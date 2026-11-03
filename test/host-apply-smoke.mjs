/**
 * 宿主半契约测试（不需要真实宿主）：
 * 用假 ctx 跑 apply()，覆盖三种情形——
 *   1) 无 webServer（纯 CLI）：面板路由跳过，但 adapter 照旧注册
 *   2) relays 配置畸形：不抛错、不注册中转，原因透给面板
 *   3) 有 webServer：注册 /llm-relay/state 与 /llm-relay/test，且 state 响应里不含密钥
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

function fakeCtx({ webServer } = {}) {
  const routes = new Map();
  const registered = [];
  const effects = [];
  const logs = [];
  const ctx = {
    get: (name) => (name === "webServer" ? webServer : undefined),
    effect: (fn, label) => {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    logger: {
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.push({ providers, adapter });
        return () => registered.splice(registered.indexOf(providers), 1);
      },
    },
  };
  const server = {
    register: (route) => {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  if (webServer) ctx.get = (name) => (name === "webServer" ? server : undefined);
  return { ctx, routes, registered, effects, logs };
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

// 1) 纯 CLI：没有 webServer，不能抛错，adapter 必须照旧注册
{
  const { ctx, registered } = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, relayConfig), "无 webServer 时 apply 不能抛错");
  assert.equal(registered.length, 1, "无 webServer 时 adapter 仍应注册");
  assert.deepEqual(registered[0].providers, ["agentrouter"]);
}

// 2) relays 畸形：记录原因、不注册、不抛错
{
  const { ctx, registered, logs } = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, { relays: "not-an-array" }), "畸形 relays 不能打挂插件行");
  assert.equal(registered.length, 0, "畸形 relays 不应注册任何中转");
  assert.ok(
    logs.some(([level, message]) => level === "warn" && message.includes("不是数组")),
    "畸形 relays 应记录可读原因",
  );
  assert.deepEqual(normalizeConfig({ relays: [] }), [], "空 relays 不应回落成内置中转");
}

// 3) 有 webServer：两条路由都要注册；state 不带密钥、带注册状态
{
  const { ctx, routes, registered } = fakeCtx({ webServer: true });
  apply(ctx, relayConfig);
  assert.ok(routes.has("/llm-relay/state"), "应注册 /llm-relay/state");
  assert.ok(routes.has("/llm-relay/test"), "应注册 /llm-relay/test");
  assert.equal(registered.length, 1);

  const res = fakeResponse();
  routes.get("/llm-relay/state").handler({ headers: {}, url: "/llm-relay/state" }, res);
  assert.equal(res.out.status, 403, "缺少 x-llm-relay 头必须 403");

  const ok = fakeResponse();
  routes.get("/llm-relay/state").handler({ headers: { "x-llm-relay": "1" }, url: "/llm-relay/state" }, ok);
  const payload = JSON.parse(ok.out.body);
  assert.equal(payload.relays.length, 1);
  const relay = payload.relays[0];
  assert.equal(relay.id, "agentrouter");
  assert.equal(relay.registered, true, "已注册的中转应标记 registered=true");
  assert.equal(relay.hasKey, true, "测试环境应能从 ~/.dsh/.env 解析到 key");
  assert.equal(relay.key, undefined, "state 响应绝不能包含密钥字段");
  assert.ok(!ok.out.body.includes("Bearer"), "state 响应不能泄漏 Authorization");
}

console.log("RESULT: PASS — 无 webServer / 畸形 relays / 路由与 403 / state 不含密钥");