/**
 * 回滚路径的故障注入测试（不碰真实 profile）：
 * persistRelays 现在接受 io.copyFile，可以分别模拟「备份失败」「回滚失败」两条路径。
 *
 * 运行：node plugins/dsh-llm-relay/test/host-rollback-smoke.mjs
 */
import assert from "node:assert/strict";
import { persistRelays } from "../lib/index.js";

const relays = [
  {
    id: "agentrouter",
    name: "AgentRouter",
    enabled: true,
    baseURL: "https://agentrouter.org/v1",
    api: "openai-responses",
    userAgent: "ua",
    apiKeyEnv: "K",
    models: [{ id: "gpt-6.1-sol", name: "GPT", contextWindow: 400000, maxTokens: 128000 }],
  },
];

function makeCtx({ update, describe } = {}) {
  const calls = { update: 0, edit: 0 };
  const settings = {
    prepareDocument: async () => "C:/tmp/cordis.patch.yml",
    update: async () => {
      calls.update += 1;
      if (update) return update();
    },
    describe: () => (describe ? describe() : [{ ns: "llm-relay", value: { relays } }]),
  };
  const configEditor = {
    entries: () => [],
    edit: async () => {
      calls.edit += 1;
    },
  };
  return { calls, ctx: { get: (name) => (name === "settings" ? settings : name === "configEditor" ? configEditor : undefined) } };
}

// 1) 备份失败 → 必须放弃写入，且绝不调用 update/edit
{
  const { ctx, calls } = makeCtx();
  const result = await persistRelays(ctx, relays, {
    copyFile: async () => {
      throw new Error("disk full");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /备份失败/);
  assert.equal(calls.update, 0, "备份失败后不能写 settings");
  assert.equal(calls.edit, 0, "备份失败后不能走 configEditor");
}

// 2) 写后回读不一致 → 恢复备份并报告 rolledBack
{
  const { ctx, calls } = makeCtx({ describe: () => [{ ns: "llm-relay", value: { relays: [{ ...relays[0], baseURL: "https://wrong.example/v1" }] } }] });
  const copies = [];
  const result = await persistRelays(ctx, relays, {
    copyFile: async (from, to) => {
      copies.push([from, to]);
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /写后校验不一致/);
  assert.equal(result.rolledBack, true, "不一致时必须回滚");
  assert.equal(calls.update, 1);
  assert.equal(copies.length, 2, "一次备份 + 一次恢复");
  assert.match(copies[1][0], /bak-llm-relay-write/, "第二次复制必须是从备份恢复");
}

// 3) 回滚本身失败 → rolledBack=false，错误里要同时带原始原因和回滚原因
{
  const { ctx } = makeCtx({ describe: () => [{ ns: "llm-relay", value: { relays: [{ ...relays[0], baseURL: "https://wrong.example/v1" }] } }] });
  let copyIndex = 0;
  const result = await persistRelays(ctx, relays, {
    copyFile: async () => {
      copyIndex += 1;
      if (copyIndex === 2) throw new Error("rollback denied");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.match(result.error, /写后校验不一致/, "要保留原始失败原因");
  assert.match(result.error, /回滚也失败/, "要说明回滚也失败");
  assert.match(result.error, /rollback denied/, "要带出回滚失败的原因");
}

// 4) settings.update 抛错但 configEditor 能写、回读一致 → 成功，并如实带出 settings 的报错
{
  const { ctx } = makeCtx({ update: () => { throw new Error("settings rejected"); } });
  const result = await persistRelays(ctx, relays, { copyFile: async () => {} });
  assert.equal(result.ok, true, "兜底路径写成功应判成功");
  assert.equal(result.verified, true, "能独立回读且一致 → verified");
  assert.match(result.note ?? "", /settings rejected/, "settings 的报错要如实带出");
}

// 5) 没有可回读来源 → 不能自证 verified
{
  const { ctx } = makeCtx({ describe: () => [] });
  const ctxNoEditor = { get: (name) => (name === "settings" ? ctx.get("settings") : undefined) };
  const result = await persistRelays(ctxNoEditor, relays, { copyFile: async () => {} });
  // settings.update 成功但 describe 为空 → 无回读；configEditor 也不在 → 无法确认
  assert.equal(result.ok, false, "没有任何写入通道时应失败");
}

console.log("RESULT: PASS — 备份失败/回读不一致回滚/回滚失败/兜底成功/无可回读 五种情形符合预期");