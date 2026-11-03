/**
 * 端到端验收：用「总结 + commit 号」跑一次真实的零工具审查。
 * 宿主取 diff → 单次请求 → 打印审查意见与成本。
 *
 * 用法：node test/experiment-commit-review.mjs <sha> [focus]
 */
import { gatherMaterial, buildReviewPrompt, completeOnce, normalizeConfig } from "../lib/index.js";

const sha = process.argv[2] ?? "bfc73c0";
const focus = process.argv[3] ?? "";

const relay = normalizeConfig({
  relays: [
    {
      id: "agentrouter",
      enabled: true,
      baseURL: "https://agentrouter.org/v1",
      api: "openai-responses",
      userAgent: "claude-cli/2.0.1 (external, cli)",
      apiKeyEnv: "AGENTROUTER_API_KEY",
      models: [{ id: "gpt-6.1-sol" }],
    },
  ],
})[0];

const material = await gatherMaterial({ commit: sha, cwd: "E:/c/dsh" });
console.log(`材料：source=${material.source} ok=${material.ok} chars=${material.text.length}`);
if (!material.ok) {
  console.log("取 diff 失败：", material.text.slice(0, 300));
  process.exit(1);
}

const request = buildReviewPrompt({
  summary: [
    "仓库：DSH 插件 dsh-llm-relay（把 OpenAI 兼容中转注册成 LLM provider）。",
    "本次提交修的是：git show 取 diff 时 maxBuffer 设得过小，遇到大提交会 ENOBUFS 失败；",
    "现在先把 maxBuffer 放大到 4MB 完整取出，再由代码截断到 160KB。",
    "请审查这个改动本身是否安全（截断点是否合理、出错路径是否可读、是否有更稳的做法）。",
  ].join("\n"),
  diff: material.text,
  focus,
  max_tokens: 12000,
});

const startedAt = Date.now();
const result = await completeOnce(relay, request);
console.log("ok=", result.ok, "status=", result.status, "latency_ms=", Date.now() - startedAt);
console.log("usage=", JSON.stringify(result.usage));
console.log("--- REVIEW ---");
console.log((result.text ?? result.message ?? "").slice(0, 5000));