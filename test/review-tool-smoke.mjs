/**
 * gpt_review（零工具单次审查）契约测试：不联网，stub globalThis.fetch。
 * 关键断言：请求里**不能有任何 tools 字段**——这正是它比子代理便宜一个数量级的原因。
 *
 * 运行：node plugins/dsh-llm-relay/test/review-tool-smoke.mjs
 */
import assert from "node:assert/strict";
import {
  buildReviewPrompt,
  completeOnce,
  createReviewToolDefinition,
  gatherMaterial,
  pickRelay,
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

// 1) 工具定义形状
{
  const def = createReviewToolDefinition([relay]);
  assert.equal(def.name, "gpt_review");
  assert.deepEqual(def.parameters.required, ["summary"]);
  assert.equal(typeof def.execute, "function");
  assert.equal(typeof def.output.render, "function");
  const rendered = def.output.render({}, { text: "结论=通过" });
  assert.equal(rendered[0].type, "text");
  assert.match(rendered[0].text, /结论=通过/);
}

// 2) 提示词：带审查铁律、带 diff 围栏、带关注点
{
  const built = buildReviewPrompt({ summary: "改了写回链路", diff: "- a\n+ b", focus: "并发" });
  assert.match(built.system, /只读不写/);
  assert.match(built.system, /阻断 \/ 应修 \/ 建议/);
  assert.match(built.prompt, /改了写回链路/);
  assert.match(built.prompt, /```diff/);
  assert.match(built.prompt, /并发/);
  assert.equal(built.maxTokens, 12000);
}

// 3) 单次请求：body 里绝不能出现 tools；system 走 instructions；返回值是文本
let capturedBody;
globalThis.fetch = async (url, init) => {
  capturedBody = JSON.parse(init.body);
  return new Response(
    JSON.stringify({ output_text: "结论=通过\nA PASS", usage: { input_tokens: 120, output_tokens: 30 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
{
  const request = buildReviewPrompt({ summary: "S", diff: "D" });
  const result = await completeOnce(relay, request);
  assert.equal(result.ok, true);
  assert.match(result.text, /结论=通过/);
  assert.equal(capturedBody.tools, undefined, "零工具请求里不能出现 tools 字段");
  assert.equal(capturedBody.model, "gpt-6.1-sol");
  assert.match(capturedBody.instructions, /独立代码审查方/, "审查人设要作为 instructions 发送");
  assert.match(capturedBody.input, /【改动总结】/);
  assert.equal(capturedBody.stream, undefined, "单次调用不开流式");
  assert.ok(result.usage, "要回传 usage，便于观察成本");
}

// 4) chat-completions 模式也要零工具
{
  const chatRelay = { ...relay, api: "openai-completions" };
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "结论=不通过" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await completeOnce(chatRelay, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, true);
  assert.match(result.text, /结论=不通过/);
  assert.equal(capturedBody.tools, undefined, "completions 模式同样不能带 tools");
  assert.equal(capturedBody.messages[0].role, "system");
}

// 5) 限流/鉴权失败：返回可读归因，而不是抛错
for (const [status, pattern, label] of [
  [429, /限流/, "429 限流"],
  [401, /鉴权/, "401 鉴权"],
]) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "boom", code: status === 429 ? "rate_limit_exceeded" : "invalid_api_key" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  const result = await completeOnce(relay, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, false, label + " 必须判失败");
  assert.match(result.message, pattern, label + " 的归因不对：" + result.message);
}

// 6) 网络异常同样归因
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

// 7) 选中转：显式 id > 第一个可用
{
  const a = { ...relay, id: "a", enabled: true };
  const b = { ...relay, id: "b", enabled: false };
  assert.equal(pickRelay([a, b], "b"), undefined, "停用的中转不应被选中");
  assert.equal(pickRelay([a, b])?.id, "a");
  assert.equal(pickRelay([], undefined), undefined);
}

// 8) execute 的失败路径要给出可读文本（不是空）
{
  globalThis.fetch = async () => new Response("{}", { status: 500 });
  const def = createReviewToolDefinition([relay]);
  const value = await def.execute({ summary: "S" });
  assert.equal(value.ok, false);
  assert.match(value.text, /GPT 审核失败/);
}

// 9) 推理烧光输出预算（status=incomplete、无正文）→ 必须报可读原因，不能把整段 JSON 当结论
{
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { output_tokens: 900 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const result = await completeOnce(relay, buildReviewPrompt({ summary: "S" }));
  assert.equal(result.ok, false, "没有正文时不能判成功");
  assert.match(result.message, /推理/, "要说明是推理占满了预算");
  assert.match(result.message, /max_tokens/, "要给出可执行建议");
  assert.ok(!String(result.text ?? "").includes('"content_filters"'), "不能把原始 JSON 当结论");
}

// 10) commit/cwd 材料：宿主替模型取 diff（模型侧仍然零工具）
{
  let calls = [];
  const fakeGit = (args, cwd) => {
    calls.push({ args, cwd });
    return { ok: true, text: "DIFF-FROM-GIT" };
  };

  const byCommit = await gatherMaterial({ commit: "abc123", cwd: "/repo" }, fakeGit);
  assert.equal(byCommit.ok, true);
  assert.equal(byCommit.source, "commit abc123");
  assert.deepEqual(calls[0].args.slice(0, 2), ["show", "--stat"], "commit 走 git show");
  assert.equal(calls[0].cwd, "/repo");

  calls = [];
  const byCwd = await gatherMaterial({ cwd: "/repo", paths: "lib/a.js" }, fakeGit);
  assert.equal(byCwd.source, "working tree");
  assert.deepEqual(calls[0].args.slice(0, 2), ["diff", "HEAD"], "只给 cwd 时取工作区改动");
  assert.ok(calls[0].args.includes("lib/a.js"), "paths 要透传");

  const explicit = await gatherMaterial({ diff: "EXPLICIT" }, fakeGit);
  assert.equal(explicit.text, "EXPLICIT", "显式 diff 优先级最高");
}

// 11) 工具执行时带上 git 材料：请求体里仍然没有 tools
{
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ output_text: "结论=通过" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const def = createReviewToolDefinition([relay], () => ({ ok: true, text: "COMMIT-DIFF-BODY" }));
  const value = await def.execute({ summary: "S", commit: "abc123", cwd: "/repo" });
  assert.equal(value.ok, true);
  assert.equal(value.materialSource, "commit abc123");
  assert.match(captured.input, /COMMIT-DIFF-BODY/, "commit 取到的 diff 要进请求");
  assert.equal(captured.tools, undefined, "仍然零工具");
}

// 12) 流式截断：超出上限时保留前 N 字节、带截断标记、且不抛错
{
  const { runGit } = await import("../lib/index.js");
  const { existsSync } = await import("node:fs");
  if (existsSync("E:/c/dsh/.git")) {
    const small = await runGit(["rev-parse", "HEAD"], "E:/c/dsh");
    assert.equal(small.ok, true, "小输出应成功");
    assert.match(small.text.trim(), /^[0-9a-f]{7,40}$/);

    const big = await runGit(["show", "--patch", "HEAD"], "E:/c/dsh", { maxBytes: 200 });
    assert.equal(big.ok, true, "截断不是失败");
    assert.equal(big.truncated, true, "应标记截断");
    assert.ok(big.text.length < 1000, "保留下来的内容必须有界");
    assert.match(big.text, /已截断/, "必须明确标记只送审了一部分");
  }
}

console.log("RESULT: PASS — gpt_review 零工具单次请求（无 tools 字段）+ 归因 + 工具契约");