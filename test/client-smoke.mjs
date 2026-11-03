/**
 * 客户端半契约测试（不渲染、不需要浏览器）：
 * 用假的 window.__ModuleLoader__ / react / ctx 跑一遍 factory 与 apply，
 * 断言它注册了三个座位——设置页分区、主列面板、侧栏图标——且参数与文案正确。
 *
 * 运行：node plugins/dsh-llm-relay/test/client-smoke.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
};

let loaded;
const window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition;
    },
  },
};

const sandbox = new Function("window", "require", source);
sandbox(window, (name) => {
  assert.equal(name, "react", `client.js 只应 require baseline 模块，实际要求了 ${name}`);
  return react;
});

assert.ok(loaded, "factory 没有通过 window.__ModuleLoader__.load 注册");
assert.equal(loaded.id, "@local/dsh-llm-relay");

const client = loaded.factory((name) => {
  assert.equal(name, "react");
  return react;
});

assert.deepEqual(client.inject, ["slots", "locale"], "客户端 inject 应只声明 slots 与 locale");

const registrations = [];
const localeDicts = {};
const translate = (key) => key;

const ctx = {
  effect: (fn) => fn(),
  locale: {
    bind: () => translate,
    register: (ns, dicts) => {
      localeDicts[ns] = dicts;
      return () => {};
    },
  },
  slots: {
    inject: (name, callback) => {
      injectedSlots.push(name);
      return callback();
    },
    register: (options, Component) => {
      registrations.push({ options, Component });
      return () => {};
    },
  },
};

const injectedSlots = [];
client.apply(ctx);

assert.deepEqual(
  injectedSlots.sort(),
  ["main", "settings.section", "sidebar.panellist"],
  "应同时接入设置页、主列面板与侧栏图标三个座位",
);

const byName = Object.fromEntries(registrations.map((item) => [item.options.name, item]));
assert.equal(registrations.length, 3, "应注册且仅注册三个座位");

// 1) 设置页分区
{
  const { options, Component } = byName["settings.section"];
  assert.equal(options.id, "llm-relay", "分区 id 必须是 llm-relay（避免覆盖内置分区）");
  assert.equal(options.order, 40);
  assert.equal(options.locale, "llm-relay");
  assert.equal(options.label(), "nav");
  assert.equal(typeof Component, "function", "注册的组件必须是可渲染函数");
  assert.deepEqual(options.inject(), { t: translate }, "inject 面必须把 t 传给组件");
}

// 2) 主列面板：key 必须与侧栏 icon 的 id 一致，且带上 page 变体
{
  const { options } = byName["main"];
  assert.equal(options.key, "llm-relay", "main 的 key 必须与侧栏 id 一致");
  assert.deepEqual(options.inject(), { t: translate, variant: "page" }, "主列面板要拿 page 变体（自身内边距与滚动）");
}

// 3) 侧栏图标
{
  const { options, Component } = byName["sidebar.panellist"];
  assert.equal(options.id, "llm-relay", "侧栏 id 必须与 main 的 key 一致，否则按钮指向不存在的面板");
  assert.equal(options.order, 30);
  assert.equal(options.label(), "nav");
  assert.equal(typeof Component, "function");
  const icon = Component({ size: 18, active: true });
  assert.equal(icon.type, "svg", "图标应渲染成 svg");
  assert.equal(icon.props.width, 18);
  assert.ok(Array.isArray(icon.children) && icon.children.length > 0, "图标应有路径内容");
  assert.doesNotThrow(() => Component({}), "size/active 缺失时图标不能抛错");
}

// 文案
const dict = localeDicts["llm-relay"];
assert.ok(dict?.zh?.nav && dict?.en?.nav, "必须同时提供中英文文案");
for (const key of ["title", "test", "testing", "keyMissing", "registered", "latency", "edit", "save", "saving", "saveFailed", "keyEnv", "editable"]) {
  assert.ok(dict.zh[key], `中文文案缺少 ${key}`);
  assert.ok(dict.en[key], `英文文案缺少 ${key}`);
}

// 渲染口：组件真的能渲染（回归 2026-11-03「点侧栏图标一片空白」——非编辑态解引用了 null draft）
{
  const { RelayCard, RelayIcon, Page } = client.__test;
  const relay = {
    id: "agentrouter",
    name: "AgentRouter",
    enabled: true,
    baseURL: "https://agentrouter.org/v1",
    api: "openai-responses",
    userAgent: "claude-cli/2.0.1",
    apiKeyEnv: "AGENTROUTER_API_KEY",
    hasKey: true,
    registered: true,
    models: [{ id: "gpt-6.1-sol", name: "GPT", contextWindow: 400000, maxTokens: 128000 }],
  };
  const baseProps = {
    relay,
    t: translate,
    onTest: () => {},
    result: null,
    onDraft: () => {},
    onEdit: () => {},
    onCancel: () => {},
    onSave: () => {},
    saving: false,
    saveError: "",
  };

  assert.doesNotThrow(() => RelayCard({ ...baseProps, editing: false, draft: null }), "非编辑态渲染不能解引用 null draft");
  assert.equal(RelayCard({ ...baseProps, editing: false, draft: null }).type, "section", "非编辑态应渲染卡片容器");

  assert.doesNotThrow(
    () =>
      RelayCard({
        ...baseProps,
        editing: true,
        draft: {
          id: "agentrouter",
          name: "AgentRouter",
          enabled: true,
          baseURL: "https://agentrouter.org/v1",
          api: "openai-responses",
          userAgent: "claude-cli/2.0.1",
          apiKeyEnv: "AGENTROUTER_API_KEY",
          modelId: "gpt-6.1-sol",
          contextWindow: 400000,
          maxTokens: 128000,
        },
      }),
    "编辑态渲染不能抛错",
  );

  assert.doesNotThrow(() => Page({ t: translate }), "设置页变体渲染不能抛错");
  assert.doesNotThrow(() => Page({ t: translate, variant: "page" }), "主列变体渲染不能抛错");
  assert.doesNotThrow(() => RelayIcon({}), "图标缺参不能抛错");
}

console.log("RESULT: PASS — settings.section(40) + main(key=llm-relay) + sidebar.panellist(30) + 图标 + zh/en + 组件渲染");