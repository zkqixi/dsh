/**
 * 对照实验：不给 GPT 任何工具，只把「真实源码 + 测试文件 + 运行输出」喂进 gpt_review，
 * 看它能否做实质审查（读代码、判断测试是否足以证明结论）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { normalizeConfig, buildReviewPrompt, completeOnce } from "../lib/index.js";

const root = "E:/PC+安卓平台/plugins/dsh-llm-relay";

// 1) 由「调用方」读文件：截取本次要审的实现（persistRelays / compareWrittenRelays / validateRelaysPayload / sanitizeRelays）
const indexSource = readFileSync(`${root}/lib/index.js`, "utf8");
function cut(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  if (start < 0) return `/* 未找到 ${startMarker} */`;
  const end = indexSource.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? indexSource.slice(start) : indexSource.slice(start, end);
}
const implementation = [
  cut("function compareWrittenRelays", "async function persistRelays"),
  cut("async function persistRelays", "function sendJson"),
].join("\n\n");

// 2) 由「调用方」读测试文件
const testSource = readFileSync(`${root}/test/host-write-smoke.mjs`, "utf8");

// 3) 由「调用方」真的跑测试，拿运行输出
let testOutput = "";
let testExit = 0;
try {
  testOutput = execFileSync(process.execPath, [`${root}/test/host-write-smoke.mjs`], { encoding: "utf8" });
} catch (error) {
  testExit = error.status ?? 1;
  testOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}

const request = buildReviewPrompt({
  summary: [
    "背景：这是一个 DSH 插件（把 OpenAI 兼容中转注册成 LLM provider），下面是它的「写回个人配置」链路实现与对应测试。",
    "请你只依据下面的材料判断两件事：",
    "(1) 这份测试是否足以证明实现正确？（逐条指出测试覆盖了什么、没覆盖什么）",
    "(2) 实现里有哪些未被测试覆盖、且真实可能造成危害的风险？（写坏用户配置、假成功、回滚失败、密钥泄漏等）",
    "注意：你没有任何工具，读不到别的文件、也跑不了命令；材料外的内容一律按「未提供」处理，不要假设。",
    "输出请控制在 800 字以内，只写结论与要点，不要复述材料。",
  ].join("\n"),
  diff: [
    "===== 实现：lib/index.js（节选） =====",
    implementation,
    "===== 测试：test/host-write-smoke.mjs =====",
    testSource,
    "===== 测试运行输出（由调用方执行） =====",
    `exit=${testExit}\n${testOutput}`,
  ].join("\n"),
  focus: "测试是否在给错误实现背书；回滚路径是否可验证；并发与坏配置的边界",
  max_tokens: 16000,
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
console.log("=== 调用结果 ===");
console.log("ok=", result.ok, "status=", result.status, "latency=", result.latencyMs, "ms");
console.log("usage=", JSON.stringify(result.usage));
console.log("=== 送出的材料规模 ===");
console.log("实现字符数:", implementation.length, " 测试字符数:", testSource.length, " 运行输出字符数:", testOutput.length);
console.log("=== GPT 审核输出 ===");
console.log((result.text ?? result.message ?? "").slice(0, 6000));