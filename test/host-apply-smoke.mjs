/**
 * 宿主半契约测试（不需要真实宿主）：
 * 用假 ctx 跑 apply()，覆盖四种情形——
 *   1) 没有任何可选服务：不抛错，adapter 照旧注册（路由/工具等它们就绪再注册）
 *   2) relays 配置畸形：不抛错、不注册中转，原因透给面板
 *   3) webServer + tools 就绪：三条路由注册、缺头 403、state 不含密钥、gpt_review 注册
 *   4) 服务晚到（先没有、后注入）：inject 回调被调用后补上注册
 *
 * 运行：node plugins/dsh-llm-relay/test/host-apply-smoke.mjs
 */
import assert from "node:assert/strict";
import { apply, normalizeConfig } from "../lib/index.js";

function fakeResponse() {
  const out = { status: 0, headers: {}, body: "" };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers ?? {};
    },
    end(body) {
      out.body = body ?? "";
    },
  };
}

function fakeCtx({ withWebServer = false, withTools = false } = {}) {
  const routes = new Map();
  const registered = [];
  const toolDefs = [];
  const effects = [];
  const logs = [];
  const pending = [];

  const server = withWebServer
    ? {
        register: (route) => {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      }
    : undefined;
  const tools = withTools
    ? {
        register: (definition) => {
          toolDefs.push(definition);
          return () => {};
        },
      }
    : undefined;

  const ctx = {
    get: (name) => (name === "webServer" ? server : name === "tools" ? tools : undefined),
    webServer: server,
    tools,
    effect: (fn, label) => {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    logger: {
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
    },
    inject: (deps, callback) => {
      // 模拟 cordis：依赖齐了就立刻回调，否则挂起（由 resolveLater 手动触发）
      const ready = () => deps.every((name) => Boolean(ctx.get(name)));
      if (ready()) callback(ctx);
      else pending.push(() => { if (ready()) callback(ctx); });
      return () => {};
    },
    llm: {
      registerAdapter: (providers) => {
        registered.push({ providers });
        return () => {};
      },
    },
  };

  return {
    ctx,
    routes,
    registered,
    toolDefs,
    effects,
    logs,
    resolveLater: () => pending.splice(0).forEach((fn) => fn()),
  };
}

const relayConfig = {
  envFile: "C:/Users/Administrator/.dsh/.env",
  relays: [
    {
      id: "agentrouter",
      name: "AgentRouter · GPT",
      enabled: true,
      baseURL: "https://agentrouter.org/v1",
      api: "openai-responses",
      userAgent: "claude-cli/2.0.1 (external, cli)",
      apiKeyEnv: "AGENTROUTER_API_KEY",
      models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", contextWindow: 400000, maxTokens: 128000 }],
    },
  ],
};

// 1) 没有任何可选服务：不能抛错，adapter 必须照旧注册
{
  const { ctx, registered } = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, relayConfig), "缺服务时 apply 不能抛错");
  assert.equal(registered.length, 1, "缺服务时 adapter 仍应注册");
  assert.deepEqual(registered[0].providers, ["agentrouter"]);
}

// 2) relays 畸形：记录原因、不注册、不抛错
{
  const { ctx, registered, logs } = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, { relays: "not-an-array" }), "畸形 relays 不能打挂插件行");
  assert.equal(registered.length, 0, "畸形 relays 不应注册任何中转");
  assert.ok(logs.some(([level, message]) => level === "warn" && message.includes("不是数组")), "要记录可读原因");
  assert.deepEqual(normalizeConfig({ relays: [] }), [], "空 relays 不应回落成内置中转");
}

// 3) 服务就绪：路由 + 工具都注册；state 不含密钥；缺头 403
{
  const { ctx, routes, registered, toolDefs } = fakeCtx({ withWebServer: true, withTools: true });
  apply(ctx, relayConfig);
  assert.ok(routes.has("/llm-relay/state"), "应注册 /llm-relay/state");
  assert.ok(routes.has("/llm-relay/test"), "应注册 /llm-relay/test");
  assert.ok(routes.has("/llm-relay/update"), "应注册 /llm-relay/update");
  assert.equal(registered.length, 1);
  assert.equal(toolDefs.length, 1, "gpt_review 应注册");
  assert.equal(toolDefs[0].name, "gpt_review");

  const res = fakeResponse();
  routes.get("/llm-relay/state").handler({ headers: {}, url: "/llm-relay/state" }, res);
  assert.equal(res.out.status, 403, "缺少 x-llm-relay 头必须 403");

  const ok = fakeResponse();
  routes.get("/llm-relay/state").handler({ headers: { "x-llm-relay": "1" }, url: "/llm-relay/state" }, ok);
  const payload = JSON.parse(ok.out.body);
  assert.equal(payload.relays.length, 1);
  assert.equal(payload.relays[0].registered, true);
  assert.equal(payload.relays[0].hasKey, true);
  assert.equal(payload.relays[0].key, undefined, "state 不能包含密钥字段");
  assert.ok(!ok.out.body.includes("Bearer"), "state 不能泄漏 Authorization");
}

// 4) 服务晚到：先没有，等它出现后 inject 回调补注册
{
  const harness = fakeCtx();
  apply(harness.ctx, relayConfig);
  assert.equal(harness.routes.size, 0, "服务未就绪时不应有路由");
  assert.equal(harness.toolDefs.length, 0);

  // 模拟服务随后可用
  const server = { register: (route) => { harness.routes.set(route.path, route); return () => {}; } };
  const tools = { register: (definition) => { harness.toolDefs.push(definition); return () => {}; } };
  harness.ctx.get = (name) => (name === "webServer" ? server : name === "tools" ? tools : undefined);
  harness.ctx.webServer = server;
  harness.ctx.tools = tools;
  harness.resolveLater();

  assert.ok(harness.routes.has("/llm-relay/state"), "服务晚到后也应补上 state 路由");
  assert.equal(harness.toolDefs.length, 1, "服务晚到后也应补上 gpt_review");
}

console.log("RESULT: PASS — 缺服务/畸形配置/服务就绪/服务晚到 四种情形都符合预期");