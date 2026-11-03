/**
 * 冒烟测试：不经过宿主，直接驱动 RelayAdapter.stream()，
 * 验证「请求头注入 → 上游调用 → SSE 解析 → StreamChunk 翻译」整条链路。
 *
 * 运行：node plugins/dsh-llm-relay/test/adapter-smoke.mjs
 */
import { normalizeConfig, RelayAdapter, requestHeaders } from "../lib/index.js";

const relay = normalizeConfig({
  relays: [
    {
      id: "agentrouter",
      name: "AgentRouter",
      baseURL: "https://agentrouter.org/v1",
      api: "openai-responses",
      userAgent: "claude-cli/2.0.1 (external, cli)",
      apiKeyEnv: "AGENTROUTER_API_KEY",
    },
  ],
})[0];

console.log("1) key:", relay.key ? `resolved(${relay.key.length})` : "MISSING");
const headers = requestHeaders(relay);
console.log("2) headers:", JSON.stringify({ ...headers, authorization: "Bearer <redacted>" }));

const adapter = new RelayAdapter(relay);
const prepared = await adapter.prepareCall("agentrouter", "gpt-6.1-sol");
console.log("3) prepareCall → model:", JSON.stringify(prepared.model).slice(0, 160));

const chunks = [];
for await (const chunk of prepared.stream({
  provider: "agentrouter",
  model: "gpt-6.1-sol",
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single token PONG.", citations: null }], id: "m1", source: { kind: "user" } }],
  maxTokens: 64,
})) {
  chunks.push(chunk);
  console.log("   chunk:", JSON.stringify(chunk).slice(0, 200));
}

const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
const finished = chunks.find((c) => c.type === "finish");
console.log("4) text:", JSON.stringify(text).slice(0, 200));
console.log("5) finish:", JSON.stringify(finished));
console.log(text.toUpperCase().includes("PONG") ? "RESULT: PASS" : "RESULT: FAIL (未收到 PONG)");
