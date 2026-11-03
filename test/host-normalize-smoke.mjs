/**
 * 离线边界测试。运行（包目录内）：node test/host-normalize-smoke.mjs
 * envFile 使用本文件内的注释夹具，不创建其它文件、不读取真实 profile。
 * 已知不符：lib/index.js:84–85 的 Number(value) || 默认值保留负数和 ±Infinity。
 * 不为上述错误行为建立预期断言；数字回落覆盖缺省、零、NaN 和非数字。
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describeRelays, normalizeConfig, resolveKey } from "../lib/index.js";

/* envFile 夹具：仅为测试假密钥。
DSH_LLM_RELAY_HOST_NORMALIZE_SMOKE_KEY = "smoke-env-file-key"
*/
const envName = "DSH_LLM_RELAY_HOST_NORMALIZE_SMOKE_KEY";
const envFile = fileURLToPath(import.meta.url);
const fileKey = "smoke-env-file-key";
const configKey = "smoke-config-key";
const envKey = "smoke-process-env-key";
const hadEnv = Object.hasOwn(process.env, envName);
const previousEnv = process.env[envName];
const rawRelay = {
  id: "smoke-relay", name: "Smoke relay", baseURL: "https://example.invalid/v1///",
  api: "openai-responses", apiKeyEnv: "", apiKey: "",
};
const defaultModels = [
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", contextWindow: 400000, maxTokens: 128000 },
];

function normalizeOne(overrides = {}) {
  const relays = normalizeConfig({ envFile, relays: [{ ...rawRelay, ...overrides }] });
  assert.equal(relays.length, 1, "合法 relay 不应丢失或附带额外内置 relay");
  return relays[0];
}

function assertNoSecretFields(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal("key" in value, false, "快照对象不得包含 key 字段");
  assert.equal("apiKey" in value, false, "快照对象不得包含 apiKey 字段");
  for (const child of Object.values(value)) assertNoSecretFields(child);
}

try {
  // 1) 缺省、畸形或空列表不得回落到内置中转。
  for (const config of [undefined, {}, { relays: "not-an-array" }, { relays: [] }]) {
    assert.deepEqual(normalizeConfig(config), [], "没有合法 relays 列表时必须返回空数组");
  }

  // 2) URL / 协议 / 默认模型 / 模型数字字段。
  const normalized = normalizeOne({ models: [{ id: "custom-model" }] });
  assert.equal(normalized.id, rawRelay.id);
  assert.equal(normalized.name, rawRelay.name);
  assert.equal(normalized.baseURL, "https://example.invalid/v1", "去掉所有末尾斜杠");
  assert.equal(normalized.api, "openai-responses");
  assert.deepEqual(normalized.models, [
    { id: "custom-model", name: "custom-model", contextWindow: 400000, maxTokens: 128000 },
  ]);
  assert.equal(normalizeOne({ baseURL: "https://example.invalid/v1" }).baseURL, "https://example.invalid/v1");
  for (const api of ["openai-responses", "openai-completions"]) {
    assert.equal(normalizeOne({ api }).api, api, "合法协议应保留");
  }
  for (const api of ["anthropic-messages", "OPENAI-COMPLETIONS", "", undefined, null, 0, false, {}, []]) {
    assert.equal(normalizeOne({ api }).api, "openai-responses", "其它协议一律回落 responses");
  }
  assert.deepEqual(normalizeOne().models, defaultModels, "models 缺省时使用内置默认模型");
  for (const models of [[], undefined, null, "not-an-array"]) {
    assert.deepEqual(normalizeOne({ models }).models, defaultModels, "空或畸形 models 使用内置默认模型");
  }
  for (const value of [undefined, null, 0, "0", "", "   ", NaN, "NaN", "not-a-number"]) {
    const [model] = normalizeOne({ models: [{ id: "invalid-number", contextWindow: value, maxTokens: value }] }).models;
    assert.equal(model.contextWindow, 400000, "缺省、零或不可转换数字的 contextWindow 补默认值");
    assert.equal(model.maxTokens, 128000, "缺省、零或不可转换数字的 maxTokens 补默认值");
  }
  for (const [contextWindow, maxTokens] of [[32000, 4096], ["32000", "4096"]]) {
    assert.deepEqual(normalizeOne({ models: [{ id: "valid", name: "Valid", contextWindow, maxTokens }] }).models,
      [{ id: "valid", name: "Valid", contextWindow: 32000, maxTokens: 4096 }], "合法数字保留，数字字符串转为数字");
  }

  // 3) 配置 > process.env > envFile，直接测试 resolveKey 并验证 normalizeConfig 集成。
  process.env[envName] = envKey;
  const relayWithEnv = { ...rawRelay, apiKeyEnv: envName };
  assert.equal(resolveKey({ ...relayWithEnv, apiKey: configKey }, envFile), configKey, "配置优先于环境及文件");
  assert.equal(resolveKey(relayWithEnv, envFile), envKey, "环境变量优先于 envFile");
  assert.equal(resolveKey({ ...relayWithEnv, apiKey: "" }, envFile), envKey, "空配置 key 不遮挡环境变量");
  const fromConfig = normalizeOne({ id: "from-config", enabled: false, apiKey: configKey, apiKeyEnv: envName });
  const fromEnv = normalizeOne({ id: "from-env", apiKeyEnv: envName });
  assert.equal(fromConfig.key, configKey);
  assert.equal(fromEnv.key, envKey);
  process.env[envName] = "";
  assert.equal(resolveKey(relayWithEnv, envFile), fileKey, "空环境变量回落到 envFile");
  delete process.env[envName];
  assert.equal(resolveKey(relayWithEnv, envFile), fileKey, "缺省环境变量回落到 envFile");
  assert.equal(resolveKey({ ...relayWithEnv, apiKey: configKey }, envFile), configKey, "配置优先于 envFile");
  const fromFile = normalizeOne({ id: "from-file", apiKeyEnv: envName });
  assert.equal(fromFile.key, fileKey);
  assert.equal(resolveKey(rawRelay, envFile), "", "没有配置 key 或变量名时返回空字符串");
  assert.equal(resolveKey(relayWithEnv, fileURLToPath(new URL("../lib/", import.meta.url))), "", "envFile 无法读取时返回空字符串");
  let missingEnvName = `${envName}_MISSING`;
  while (Object.hasOwn(process.env, missingEnvName)) missingEnvName += "_MISSING";
  assert.equal(resolveKey({ ...rawRelay, apiKeyEnv: missingEnvName }, envFile), "", "环境及文件都没有指定键时返回空字符串");
  const fromNone = normalizeOne({ id: "from-none", apiKeyEnv: missingEnvName });
  assert.equal(fromNone.key, "");

  // 4) 快照去掉密钥字段与值，注册状态仅由判定函数决定。
  const relays = [fromConfig, fromEnv, fromFile, fromNone].map((relay) => ({
    ...relay, models: relay.models.map((model) => ({ ...model, key: configKey, apiKey: envKey })),
  }));
  const registeredIds = new Set(["from-config", "from-none"]);
  const visitedIds = [];
  const described = describeRelays(relays, (id) => {
    visitedIds.push(id);
    return registeredIds.has(id);
  });
  assert.deepEqual(visitedIds, relays.map((relay) => relay.id), "逐条将 id 传给注册判定函数");
  assert.deepEqual(described.map(({ id, hasKey, keySource, registered }) => ({ id, hasKey, keySource, registered })), [
    { id: "from-config", hasKey: true, keySource: "config", registered: true },
    { id: "from-env", hasKey: true, keySource: "env", registered: false },
    { id: "from-file", hasKey: true, keySource: "env", registered: false },
    { id: "from-none", hasKey: false, keySource: "none", registered: true },
  ]);
  assertNoSecretFields(described);
  for (const [index, relay] of described.entries()) {
    assert.ok(["config", "env", "none"].includes(relay.keySource));
    assert.equal(relay.apiKeyEnv, relays[index].apiKeyEnv, "仅保留变量名而非密钥");
    assert.deepEqual(relay.models, defaultModels, "模型快照仅保留公开字段");
  }
  for (const secret of [configKey, envKey, fileKey]) {
    assert.equal(JSON.stringify(described).includes(secret), false, "快照不得泄漏密钥值");
  }
  assert.deepEqual(describeRelays(relays, () => false).map((relay) => relay.registered), [false, false, false, false]);
  assert.deepEqual(describeRelays(relays, () => true).map((relay) => relay.registered), [true, true, true, true]);
  assert.deepEqual(describeRelays([], () => assert.fail("空列表不得调用判定函数")), []);
} finally {
  delete process.env[envName];
  // 通常情况下测试变量已删除；若调用者已定义同名变量则恢复原值。
  if (hadEnv) process.env[envName] = previousEnv;
}
assert.equal(Object.hasOwn(process.env, envName), hadEnv, "不改变环境变量原有存在性");
assert.equal(process.env[envName], previousEnv, "不污染调用者环境");
console.log("RESULT: PASS — normalize/describe 边界");
