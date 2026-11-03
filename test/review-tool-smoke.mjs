/**
 * gpt_review（零工具、流式）契约测试：不联网，stub globalThis.fetch。
 * 关键断言：
 *  1) 请求体**不能有任何 tools 字段**（这正是它比子代理便宜一个数量级的原因），且必须 stream:true
 *  2) SSE 增量能拼成正文；usage 能带出
 *  3) 失败（401/429/网络/推理占满/空闲超时）都返回可读归因，不抛
 *  4) commit/cwd 材料由宿主取 diff，模型侧仍零工具
 *
 * 运行：node test/review-tool-smoke.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  buildReviewPrompt,
  completeOnce,
  createReviewToolDefinition,
  gatherMaterial,
  pickRelay,
  renderGitOutput,
  runGit,
} from "../lib/index.js";

const relay = {
  id: "agentrouter",
  name: "AgentRouter",
  baseURL: "https://agentrouter.org/v1",
  api: "openai-responses",
  userAgent: "claude-cli/2.0.1 (external, cli)",
  apiKeyEnv: "AGENTROUTER_API_KEY",
  key: "sk-test-secret-value",
  headers: {},
  models: [{ id: "gpt-6.1-sol", name: "GPT", contextWindow: 400000, maxTokens: 128000 }],
};

const sse = (...events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const sseResponse = (body) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

// 1) 工具定义形状
{
  const def = createReviewToolDefinition([relay]);
  assert.equal(def.name, "gpt_review");
  assert.deepEqual(def.parameters.required, ["summary"]);
  assert.equal(typeof def.execute, "function");
  const rendered = def.output.render({}, { text: "结论=通过" });
  assert.equal(rendered[0].type, "text");
}

// 2) 提示词
{
  const built = buildReviewPrompt({ summary: "改了写回链路", diff: "- a\n+ b", focus: "并发" });
  assert.match(built.system, /只读不写/);
  assert.match(built.prompt, /```diff/);
  assert.equal(built.maxTokens, 12000);
}

// 3) 流式累积：正文 + usage；请求体零工具但 stream:true
{
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(
      sse(
        { type: "response.output_text.delta", delta: "结论=" },
        { type: "response.output_text.delta", delta: "通过" },
        { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
      ),
    );
  };
  const result = await completeOnce(relay, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, true);
  assert.equal(result.text, "结论=通过");
  assert.equal(result.usage.output_tokens, 7);
  assert.equal(captured.tools, undefined, "零工具请求里不能出现 tools 字段");
  assert.equal(captured.stream, true, "必须流式（保活）");
  assert.match(captured.instructions, /独立代码审查方/);
}

// 4) chat/completions 的流式分片同样零工具
{
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "结论=" } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: "不通过" } }] })}\n\n` +
        "data: [DONE]\n\n",
    );
  };
  const result = await completeOnce({ ...relay, api: "openai-completions" }, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, true);
  assert.equal(result.text, "结论=不通过");
  assert.equal(captured.tools, undefined);
  assert.equal(captured.stream, true);
  assert.equal(captured.messages[0].role, "system");
}

// 5) 鉴权/限流失败：可读归因
for (const [status, pattern, label] of [
  [429, /限流/, "429"],
  [401, /鉴权/, "401"],
]) {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { message: "boom", code: status === 429 ? "rate_limit_exceeded" : "invalid_api_key" } }),
      { status, headers: { "content-type": "application/json" } },
    );
  const result = await completeOnce(relay, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, false, label + " 必须判失败");
  assert.match(result.message, pattern, label + " 归因不对：" + result.message);
}

// 6) 网络异常
{
  globalThis.fetch = async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ECONNRESET" };
    throw error;
  };
  const result = await completeOnce(relay, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, false);
  assert.match(result.message, /网络/);
}

// 7) 流内 error 事件（限流）
{
  globalThis.fetch = async () =>
    sseResponse(sse({ type: "error", error: { code: "rate_limit_exceeded", message: "token rate limit exceeded" } }));
  const result = await completeOnce(relay, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, false);
  assert.match(result.message, /限流/);
  assert.match(result.message, /token rate limit/);
}

// 8) 推理烧光预算（incomplete、无正文）
{
  globalThis.fetch = async () =>
    sseResponse(sse({ type: "response.incomplete", response: { usage: { output_tokens: 900 } } }));
  const result = await completeOnce(relay, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, false);
  assert.match(result.message, /推理/, "要说明是推理占满了预算");
  assert.match(result.message, /max_tokens/);
}

// 9) 空闲超时：流只发一个事件后再也不动 → 必须在 idleTimeoutMs 内判死
{
  // stub 必须响应 abort：真实 fetch 会因 signal 中断而让 body 报错
  globalThis.fetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse({ type: "response.created" })));
          init.signal?.addEventListener("abort", () => {
            try {
              controller.error(new DOMException("aborted", "AbortError"));
            } catch {}
          });
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const started = Date.now();
  const result = await completeOnce(relay, { ...buildReviewPrompt({ summary: "S" }), idleTimeoutMs: 60 });
  assert.equal(result.ok, false);
  assert.match(result.message, /空闲超时/, "要报空闲超时：" + result.message);
  assert.ok(Date.now() - started < 5000, "空闲超时应该很快返回");
}

// 10) 网关不按流式回时回落 JSON
{
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ output_text: "结论=通过", usage: { output_tokens: 3 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const result = await completeOnce(relay, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, true);
  assert.equal(result.text, "结论=通过");
}

// 11) commit/cwd 材料：宿主替模型取 diff（模型侧仍然零工具）
{
  let calls = [];
  const fakeGit = (args, cwd) => {
    calls.push({ args, cwd });
    return { ok: true, text: "DIFF-FROM-GIT" };
  };
  const byCommit = await gatherMaterial({ commit: "abc123", cwd: "/repo" }, fakeGit);
  assert.equal(byCommit.source, "commit abc123");
  assert.deepEqual(calls[0].args.slice(0, 2), ["show", "--stat"]);

  calls = [];
  const byCwd = await gatherMaterial({ cwd: "/repo", paths: "lib/a.js" }, fakeGit);
  assert.equal(byCwd.source, "working tree");
  assert.deepEqual(calls[0].args.slice(0, 2), ["diff", "HEAD"]);
  assert.ok(calls[0].args.includes("lib/a.js"));

  const explicit = await gatherMaterial({ diff: "EXPLICIT" }, fakeGit);
  assert.equal(explicit.text, "EXPLICIT");
}

// 12) 工具执行：带 commit 材料、请求零工具
{
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(
      sse(
        { type: "response.output_text.delta", delta: "结论=通过" },
        { type: "response.completed", response: { usage: { output_tokens: 4 } } },
      ),
    );
  };
  const def = createReviewToolDefinition([relay], () => ({ ok: true, text: "COMMIT-DIFF-BODY" }));
  const value = await def.execute({ summary: "S", commit: "abc123", cwd: "/repo" });
  assert.equal(value.ok, true);
  assert.equal(value.materialSource, "commit abc123");
  assert.match(captured.input, /COMMIT-DIFF-BODY/);
  assert.equal(captured.tools, undefined, "仍然零工具");
}

// 13) 字符保真（截断路径）
{
  const intact = renderGitOutput([Buffer.from("tail\uFFFD", "utf8")], { truncated: false, size: 5 });
  assert.equal(intact, "tail\uFFFD");
  const legit = renderGitOutput([Buffer.from("\uFFFDx", "utf8")], { truncated: true, size: 3 });
  assert.ok(legit.startsWith("\uFFFDx"), "合法 U+FFFD 不能被删");
}

// 14) git 的流式截断（依赖本机仓库，缺 .git 时跳过）
if (existsSync("E:/c/dsh/.git")) {
  const big = await runGit(["show", "--patch", "HEAD"], "E:/c/dsh", { maxBytes: 200 });
  assert.equal(big.ok, true);
  assert.equal(big.truncated, true);
  assert.match(big.text, /已截断/);
}

// 15) 选中转
{
  const a = { ...relay, id: "a", enabled: true };
  const b = { ...relay, id: "b", enabled: false };
  assert.equal(pickRelay([a, b], "b"), undefined);
  assert.equal(pickRelay([a, b])?.id, "a");
}

console.log("RESULT: PASS — 流式累积 + 零工具 + 五类失败归因 + 空闲超时 + commit 材料 + 字符保真");