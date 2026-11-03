/**
 * 对照实验 2（小切片）：只贴一个函数 + 测试运行输出，看零工具审查是否在可接受时间内给出实质结论。
 * 与实验 1（整份 13KB 源码）对比：材料规模直接决定可行性与耗时。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { normalizeConfig, buildReviewPrompt, completeOnce } from "../lib/index.js";

const root = "E:/PC+安卓平台/plugins/dsh-llm-relay";
const indexSource = readFileSync(`${root}/lib/index.js`, "utf8");
const start = indexSource.indexOf("async function persistRelays");
const end = indexSource.indexOf("function sendJson", start);
const implementation = indexSource.slice(start, end);

let testOutput = "";
let testExit = 0;
try {
  testOutput = execFileSync(process.execPath, [`${root}/test/host-write-smoke.mjs`], { encoding: "utf8" });
} catch (error) {
  testExit = error.status ?? 1;
  testOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}

const request = buildReviewPrompt({
  summary:
    "背景：DSH 插件把面板编辑写回用户 profile 配置。下面只有回滚主函数 persistRelays 与现有测试的输出。" +
    "请只依据材料判断：(1) 这段回滚逻辑有没有真实漏洞？(2) 现有测试能否证明它？不要假设材料外的东西。",
  diff: [
    "===== persistRelays =====",
    implementation,
    "===== 现有测试运行输出 =====",
    `exit=${testExit} ${testOutput.trim()}`,
  ].join("\n"),
  focus: "备份失败、写后回读不一致、回滚本身失败这几条路径",
  max_tokens: 8000,
});

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

const startedAt = Date.now();
const result = await completeOnce(relay, request);
const elapsed = Date.now() - startedAt;
console.log("ok=", result.ok, "status=", result.status, "latency_ms=", elapsed);
console.log("usage=", JSON.stringify(result.usage));
console.log("material_chars=", implementation.length + request.prompt.length);
console.log("--- REVIEW ---");
console.log((result.text ?? result.message ?? "").slice(0, 4000));