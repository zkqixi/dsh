/**
 * 失败形态测试（不联网，stub 掉 globalThis.fetch）：
 * 非 2xx、网络异常、流内 error 事件，都必须以宿主认识的 `finish: {kind:'error'}` 回报，
 * 而不是抛异常（抛异常会被宿主当成"这一回合静默结束"，子代理就变成 left no closing message）。
 *
 * 运行：node plugins/dsh-llm-relay/test/adapter-error-smoke.mjs
 */
import assert from "node:assert/strict";
import { RelayAdapter } from "../lib/index.js";

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

const options = {
  provider: "agentrouter",
  model: "gpt-6.1-sol",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 16,
};

async function collect() {
  const chunks = [];
  for await (const chunk of new RelayAdapter(relay).stream(options)) chunks.push(chunk);
  return chunks;
}

/** 失败原因必须同时是一段可见文本：父会话/通知里才不会只剩一句 "failed"。 */
function visibleText(chunks) {
  return chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.text)
    .join("");
}

// 1) HTTP 401（上游报错原文里带密钥形态）→ error finish，不抛，且脱敏
globalThis.fetch = async () =>
  new Response(JSON.stringify({ error: { message: "无效的令牌 sk-test-secret-value", type: "new_api_error" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
{
  const chunks = await collect();
  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.ok(finish, "必须产出 finish 块");
  assert.equal(finish.reason.kind, "error", "非 2xx 必须以 error finish 回报");
  assert.equal(finish.reason.failure.status, 401, "要带真实状态码");
  assert.match(finish.reason.failure.message, /HTTP 401/, "原因要可读");
  assert.ok(!finish.reason.failure.message.includes("sk-test-secret-value"), "报错原文必须脱敏");
  assert.match(finish.reason.failure.message, /鉴权/, "401 必须提示去查 API key，而不是让模型以为 GPT 坏了");
  assert.match(visibleText(chunks), /鉴权/, "失败原因必须作为可见文本吐出去");
  assert.match(visibleText(chunks), /⚠️ 中转调用失败/, "可见文本要明确标注这是中转失败");
}

// 2) 网络异常（fetch 直接抛）→ error finish，不抛
globalThis.fetch = async () => {
  const error = new TypeError("fetch failed");
  error.cause = { code: "ECONNRESET" };
  throw error;
};
{
  const chunks = await collect();
  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.equal(finish?.reason?.kind, "error", "网络异常也必须以 error finish 回报");
  assert.equal(finish.reason.failure.code, "llm-relay-network");
  assert.match(finish.reason.failure.message, /ECONNRESET/, "要带上网给错误码");
  assert.match(finish.reason.failure.message, /网络/, "网络异常必须提示先查代理/网络");
  assert.match(visibleText(chunks), /网络/, "网络异常的原因也要可见");
}

// 3) 流内 error 事件（限流）→ error finish 带上游 code
globalThis.fetch = async () =>
  new Response(
    'data: {"type":"error","error":{"type":"too_many_requests","code":"rate_limit_exceeded","message":"token rate limit exceeded"}}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
{
  const chunks = await collect();
  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.equal(finish?.reason?.kind, "error", "流内 error 事件必须以 error finish 回报");
  assert.equal(finish.reason.failure.code, "rate_limit_exceeded", "要保留上游错误码");
  assert.match(finish.reason.failure.message, /token rate limit/, "要保留上游错误信息");
  assert.match(finish.reason.failure.message, /限流/, "限流必须提示换出口 IP，而不是模型故障");
  assert.match(finish.reason.failure.message, /出口 IP/, "要给出可执行建议");
  assert.match(visibleText(chunks), /限流/, "限流原因也要可见");
}

console.log("RESULT: PASS — 401 / 网络异常 / 限流事件都回报为 finish:error，且报错原文已脱敏");