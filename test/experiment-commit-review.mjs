/**
 * 端到端验收：用「总结 + commit 号」跑一次真实的零工具审查。
 * 宿主取 diff → 单次请求 → 打印审查意见与成本。
 *
 * 用法：node test/experiment-commit-review.mjs <sha> [focus]
 */
import { gatherMaterial, buildReviewPrompt, completeOnce, normalizeConfig } from "../lib/index.js";

const sha = process.argv[2] ?? "bfc73c0";
const paths = process.env.PATHS ?? "";
const maxTokens = Number(process.env.MAXTOK ?? 12000);
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

const material = await gatherMaterial({ commit: sha, cwd: "E:/c/dsh", ...(paths ? { paths } : {}) });
console.log(`材料：source=${material.source} ok=${material.ok} chars=${material.text.length}`);
if (!material.ok) {
  console.log("取 diff 失败：", material.text.slice(0, 300));
  process.exit(1);
}

const request = buildReviewPrompt({
  summary: [
    "仓库：DSH 插件 dsh-llm-relay。上一版提交 bfc73c0 被审查判为不通过，意见是：",
    "① 声称「消除 ENOBUFS」过头（只是抬高了缓冲门槛）；② 截断语义不清（字节/字符、有无标记、覆盖范围）；",
    "③ 错误路径缺少证据；④ 建议改用流式采集。",
    "本次提交 c6438f9 针对这四点改了 runGit：spawn 流式读、到达 maxBytes 即停采并 SIGKILL、",
    "按字节截断并去掉半个字符、截断时显式标注「仅保留前 N 字节，其余未送审」、",
    "超时/启动失败/非零退出/截断四种状态分别返回可读结果。",
    "请审查：这四点是否真的被解决？有没有引入新问题（子进程泄漏、kill 时机、stderr 上限、截断边界、超时竞态）？",
  ].join("\n"),
  diff: material.text,
  focus: focus || "上一轮四条意见是否闭环；资源泄漏与竞态；截断后是否仍会给出全量通过结论",
  max_tokens: maxTokens,
});

const startedAt = Date.now();
const result = await completeOnce(relay, request);
console.log("ok=", result.ok, "status=", result.status, "latency_ms=", Date.now() - startedAt);
console.log("usage=", JSON.stringify(result.usage));
console.log("--- REVIEW ---");
console.log((result.text ?? result.message ?? "").slice(0, 5000));