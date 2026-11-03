/**
 * 失败归因测试：不同失败必须给出不同的、可执行的提示，
 * 避免会话把「代理/IP 问题」误判成「模型坏了」。
 *
 * 运行：node plugins/dsh-llm-relay/test/failure-hint-smoke.mjs
 */
import assert from "node:assert/strict";
import { failureHint } from "../lib/index.js";

const cases = [
  [{ status: 401 }, /鉴权/, "401 → 查 key"],
  [{ status: 403 }, /鉴权/, "403 → 查 key"],
  [{ code: "invalid_api_key" }, /鉴权/, "上游 code=invalid_api_key → 查 key"],
  [{ status: 429 }, /限流/, "429 → 换出口 IP"],
  [{ code: "rate_limit_exceeded" }, /限流/, "rate_limit_exceeded → 换出口 IP"],
  [{ code: "too_many_requests" }, /限流/, "too_many_requests → 换出口 IP"],
  [{ status: 0, code: "ECONNRESET" }, /网络/, "ECONNRESET → 查代理"],
  [{ code: "ETIMEDOUT" }, /网络/, "ETIMEDOUT → 查代理"],
  [{ code: "ENOTFOUND" }, /网络/, "ENOTFOUND → 查 DNS/代理"],
  [{ code: "fetch failed" }, /网络/, "fetch failed → 查网络"],
  [{ status: 503 }, /上游/, "503 → 上游/出口 IP 临时故障"],
];

for (const [meta, pattern, label] of cases) {
  const hint = failureHint(meta);
  assert.match(hint, pattern, label + " 的提示不对：" + JSON.stringify(meta) + " → " + hint);
}

// 未知失败不给误导性归因
assert.equal(failureHint({ status: 418 }), "", "未知状态码不应硬套归因");

// 每条提示都要能执行（不含技术黑话堆砌）
for (const [meta] of cases) {
  assert.match(failureHint(meta), /检查|换|稍后|查|看/, JSON.stringify(meta) + " 的提示缺少可执行动作");
}

console.log("RESULT: PASS — 鉴权/限流/网络/5xx 四类归因正确，且都给出可执行建议");
