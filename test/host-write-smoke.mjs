/**
 * 写回路径的纯函数测试（不碰真实 profile）：
 *   · validateRelaysPayload：拒绝增删/重排、坏 URL、坏协议、空模型、坏模型字段
 *   · sanitizeRelays：剥掉密钥、规整 URL、补默认值
 *   · compareWrittenRelays：抓「写入没生效」
 *
 * 运行：node plugins/dsh-llm-relay/test/host-write-smoke.mjs
 */
import assert from "node:assert/strict";
import { compareWrittenRelays, sanitizeRelays, validateRelaysPayload } from "../lib/index.js";

const current = [
  { id: "agentrouter", baseURL: "https://agentrouter.org/v1", api: "openai-responses", enabled: true, models: [{ id: "gpt-6.1-sol" }] },
  { id: "backup", baseURL: "https://example.com/v1", api: "openai-completions", enabled: false, models: [{ id: "m1" }] },
];

const valid = [
  { id: "agentrouter", name: "AgentRouter", enabled: true, baseURL: "https://agentrouter.org/v1", api: "openai-responses", userAgent: "claude-cli/2.0.1", apiKeyEnv: "AGENTROUTER_API_KEY", models: [{ id: "gpt-6.1-sol", contextWindow: 400000, maxTokens: 128000 }] },
  { id: "backup", name: "Backup", enabled: false, baseURL: "https://example.com/v1", api: "openai-completions", userAgent: "ua", apiKeyEnv: "BACKUP_KEY", models: [{ id: "m1" }] },
];

// 合法输入
assert.equal(validateRelaysPayload(valid, current), "", "合法 payload 不应报错");

// 增删 / 重排
{
  const added = [...valid, { id: "new-one", baseURL: "https://x.example/v1", api: "openai-responses", models: [{ id: "m" }] }];
  assert.match(validateRelaysPayload(added, current), /只允许编辑现有中转/, "新增条目必须被拒");

  const removed = [valid[0]];
  assert.match(validateRelaysPayload(removed, current), /只允许编辑现有中转/, "删除条目必须被拒");

  const reordered = [valid[1], valid[0]];
  assert.match(validateRelaysPayload(reordered, current), /只允许编辑现有中转/, "重排必须被拒");
}

// 字段校验
{
  const badUrl = [{ ...valid[0], baseURL: "ftp://agentrouter.org" }, valid[1]];
  assert.match(validateRelaysPayload(badUrl, current), /接口地址必须以 http/, "非 http(s) 必须被拒");

  const badApi = [{ ...valid[0], api: "anthropic-messages" }, valid[1]];
  assert.match(validateRelaysPayload(badApi, current), /协议必须是/, "未知协议必须被拒");

  const noModels = [{ ...valid[0], models: [] }, valid[1]];
  assert.match(validateRelaysPayload(noModels, current), /至少要配置一个模型/, "空模型必须被拒");

  const modelNoId = [{ ...valid[0], models: [{ name: "x" }] }, valid[1]];
  assert.match(validateRelaysPayload(modelNoId, current), /模型缺少 id/, "模型缺 id 必须被拒");

  // 改 id 同时违反「id 集合不变」，会被更前面的规则拦下——这里只断言被拒
  const badId = [{ ...valid[0], id: "bad id!" }, valid[1]];
  assert.notEqual(validateRelaysPayload(badId, current), "", "畸形 id 必须被拒");

  const badWindow = [{ ...valid[0], models: [{ id: "gpt-6.1-sol", contextWindow: -1 }] }, valid[1]];
  assert.match(validateRelaysPayload(badWindow, current), /contextWindow 必须是有限正数/, "负数 contextWindow 必须被拒");

  // 只过正则但 URL 非法的串必须被拒
  const brokenUrl = [{ ...valid[0], baseURL: "https://[" }, valid[1]];
  assert.match(validateRelaysPayload(brokenUrl, current), /不是合法 URL/, "https://[ 这类串必须被拒");

  const infiniteWindow = [{ ...valid[0], models: [{ id: "gpt-6.1-sol", contextWindow: Infinity }] }, valid[1]];
  assert.match(validateRelaysPayload(infiniteWindow, current), /有限正数/, "Infinity 必须被拒");

  assert.equal(validateRelaysPayload("nope", current), "relays 必须是数组");
}

// 清洗：密钥不写入、URL 规整、默认值补齐
{
  const dirty = [
    { id: "agentrouter", baseURL: "https://agentrouter.org/v1///", api: "openai-responses", apiKey: "sk-should-not-survive", apiKeyEnv: "AGENTROUTER_API_KEY", models: [{ id: " gpt-6.1-sol " }] },
  ];
  const [clean] = sanitizeRelays(dirty);
  assert.equal(clean.baseURL, "https://agentrouter.org/v1", "baseURL 末尾斜杠应被去掉");
  assert.equal(clean.apiKey, undefined, "密钥字段绝不能进入写入内容");
  assert.equal(clean.id, "agentrouter");
  assert.equal(clean.models[0].id, "gpt-6.1-sol", "模型 id 应 trim");
  assert.equal(clean.models[0].contextWindow, 400000, "缺省 contextWindow 应补默认值");
  assert.equal(clean.models[0].maxTokens, 128000, "缺省 maxTokens 应补默认值");
  assert.equal(clean.enabled, true, "enabled 缺省应为 true");
  assert.equal(clean.name, "agentrouter", "缺省 name 退化为 id");
}

// 回读对比
{
  const written = sanitizeRelays(valid);
  assert.equal(compareWrittenRelays(written, sanitizeRelays(valid)), "", "一致时不应报错");
  assert.match(compareWrittenRelays([], sanitizeRelays(valid)), /数量不一致/, "少写必须被发现");

  const changedUrl = written.map((relay, index) => (index === 0 ? { ...relay, baseURL: "https://other.example/v1" } : relay));
  assert.match(compareWrittenRelays(changedUrl, sanitizeRelays(valid)), /baseURL 未生效/, "URL 没写进去必须被发现");

  const changedEnabled = written.map((relay, index) => (index === 1 ? { ...relay, enabled: true } : relay));
  assert.match(compareWrittenRelays(changedEnabled, sanitizeRelays(valid)), /enabled 未生效/, "开关没写进去必须被发现");

  // 其它可编辑字段也要能被回读校验抓到（旧实现只验 id/baseURL/enabled）
  const changedName = written.map((relay, index) => (index === 0 ? { ...relay, name: "Different" } : relay));
  assert.match(compareWrittenRelays(changedName, sanitizeRelays(valid)), /name 未生效/, "改名没写进去必须被发现");

  const changedModel = written.map((relay, index) =>
    index === 0 ? { ...relay, models: relay.models.map((m) => ({ ...m, name: "其他" })) } : relay,
  );
  assert.match(compareWrittenRelays(changedModel, sanitizeRelays(valid)), /模型的名称未生效/, "模型名称没写进去必须被发现");
}

console.log("RESULT: PASS — 拒绝增删/重排与坏字段；密钥不外泄；回读不一致可检出");