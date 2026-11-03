/**
 * dsh-llm-relay · 宿主半
 *
 * 以自定义 LlmAdapter 原生注册「中转」provider：请求头由本 adapter 自己构造，
 * 因此可以强制上游要求的 User-Agent 与 Authorization —— 这是内置 pi-ai 适配器
 * 做不到的（它会把配置里的保留头过滤掉并用自己的署名 UA 覆盖，见 docs/CONTRACT.md Q3）。
 *
 * 契约来源：docs/CONTRACT.md（从 DSH app.asar 提取的真实类型声明）。
 * 标注 ⚠️ 的位置是需要联网后运行时验证的推断处。
 */
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const name = "llm-relay";
// 必须用模块级 inject 声明依赖：Cordis 的服务访问是受检的，
// 在 ctx.inject() 回调里用外层 ctx 访问 ctx.llm 会抛
// "cannot get property \"llm\" without inject"（2026-11-03 实测）。
const inject = ["llm"];

/** 配置用宽松 schema：relays 的形状由 normalizeConfig() 兜底，坏值不能把整行插件打成不激活。 */
const Config = z.object({
  relays: z.any().default([]),
  envFile: z.string().default(join(homedir(), ".dsh", ".env")),
});

const BUILTIN_RELAY = {
  id: "agentrouter",
  name: "AgentRouter · GPT",
  enabled: true,
  baseURL: "https://agentrouter.org/v1",
  api: "openai-responses",
  userAgent: "claude-cli/2.0.1 (external, cli)",
  apiKeyEnv: "AGENTROUTER_API_KEY",
  apiKey: "",
  headers: {},
  models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", contextWindow: 400000, maxTokens: 128000 }],
};

/** 从 ~/.dsh/.env 读取 KEY=value（仅当环境变量缺失时兜底）。 */
function readEnvFile(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function resolveKey(relay, envFile) {
  if (relay.apiKey) return relay.apiKey;
  if (relay.apiKeyEnv && process.env[relay.apiKeyEnv]) return process.env[relay.apiKeyEnv];
  if (relay.apiKeyEnv) {
    const fromFile = readEnvFile(envFile)[relay.apiKeyEnv];
    if (fromFile) return fromFile;
  }
  return "";
}

/** 只接受有限正数，其余（负数、0、NaN、±Infinity、字符串垃圾）一律回落默认值。 */
function positiveOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** 抹掉文本里的密钥形态，避免上游报错原文把凭据带进响应或日志。 */
function redactSecrets(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***")
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9._\-]{6,}/g, "$1-***");
}

/**
 * 把失败归因成「鉴权 / 限流 / 网络 / 上游 5xx」，并给出一句可执行的中文提示。
 * 目的：让 DSH 与会话里的模型看到的第一句话就是「去查网络/代理/IP」，而不是以为 GPT 本身坏了。
 */
function failureHint({ status = 0, code = "" } = {}) {
  const text = String(code ?? "").toLowerCase();
  if (status === 401 || status === 403 || /unauthor|invalid.?api.?key|invalid.?token|auth/.test(text)) {
    return "【鉴权】上游拒绝了凭据：先检查 API key 是否有效/过期（这类失败与网络无关）";
  }
  if (status === 429 || /rate.?limit|too.?many.?requests|quota|throttl/.test(text)) {
    return "【限流】上游对当前出口 IP 限流（不是模型本身坏了）：换一个代理节点/出口 IP，或等一会儿再试";
  }
  if (
    status === 0 ||
    /network|econnreset|econnrefused|etimedout|enotfound|eai_again|tls|socket|fetch.?failed|abort/.test(text)
  ) {
    return "【网络】本机到上游不通（代理/网络问题）：先看代理是否在线、节点质量是否正常，再去怀疑模型";
  }
  if (status >= 500) {
    return "【上游】网关 5xx：多为出口 IP 或上游临时故障，换节点或稍后重试";
  }
  return "";
}

/** 拼一句「提示 + 原文」的失败信息。 */
function failureMessage(base, meta) {
  const hint = failureHint(meta);
  return redactSecrets(hint ? `${hint} ｜ ${base}` : base);
}

/**
 * 失败时先把原因作为一段可见文本吐出去，再给 error finish。
 * 目的：宿主/父会话看到的是「【限流】…换节点」而不是一句 "failed, no closing message"。
 */
function* failureChunks(message, index) {
  const text = `⚠️ 中转调用失败：${message}`;
  yield { type: "block-start", index, blockType: "text" };
  yield { type: "text-delta", index, text };
  yield { type: "block-end", index, block: { type: "text", text } };
}

function normalizeRelay(raw, envFile) {
  const r = { ...BUILTIN_RELAY, ...raw };
  const models = Array.isArray(r.models) && r.models.length ? r.models : BUILTIN_RELAY.models;
  return {
    id: String(r.id || "").trim(),
    name: String(r.name || r.id),
    enabled: r.enabled !== false,
    baseURL: String(r.baseURL || "").replace(/\/+$/, ""),
    api: r.api === "openai-completions" ? "openai-completions" : "openai-responses",
    userAgent: String(r.userAgent || BUILTIN_RELAY.userAgent),
    apiKeyEnv: String(r.apiKeyEnv || ""),
    apiKey: String(r.apiKey || ""),
    headers: r.headers && typeof r.headers === "object" ? r.headers : {},
    models: models.map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      contextWindow: positiveOr(m.contextWindow, 400000),
      maxTokens: positiveOr(m.maxTokens, 128000),
    })),
    key: resolveKey(r, envFile),
  };
}

function normalizeConfig(config) {
  const envFile = config?.envFile || join(homedir(), ".dsh", ".env");
  // 只在真的给了中转列表时才注册；空/畸形配置不静默挂一个内置中转（原因由 apply 记录并透给面板）。
  const list = Array.isArray(config?.relays) ? config.relays : [];
  return list.map((raw) => normalizeRelay(raw, envFile));
}

function requestHeaders(relay) {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${relay.key}`,
    // 关键：上游只认这个 UA，换成 DSH 默认署名 UA 会 401 unauthorized client detected
    "user-agent": relay.userAgent,
    ...relay.headers,
  };
}

/** 取一条消息里文本块的纯文本（system 指令、tool 结果都只要文本）。 */
function textOf(blocks) {
  return (blocks ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/**
 * DSH Message[] → OpenAI Responses API 的 input items。
 * 契约：ContentBlockMap = text | reasoning | image | file | tool-call | tool-addition | tool-removal；
 * 工具结果是独立的 role:'tool' 消息（带 toolCallId），不是块。
 */
function toResponsesInput(messages) {
  const items = [];
  for (const message of messages ?? []) {
    const role = message?.role;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    if (role === "tool") {
      const callId = message.toolCallId ?? message.source?.callId;
      if (callId) items.push({ type: "function_call_output", call_id: callId, output: textOf(blocks) });
      continue;
    }
    if (role === "system" || role === "developer") {
      const text = textOf(blocks);
      if (text) items.push({ role, content: text });
      continue;
    }
    if (role === "assistant") {
      for (const block of blocks) {
        if (block?.type === "text" && block.text) items.push({ role: "assistant", content: block.text });
        else if (block?.type === "tool-call") {
          items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments ?? "{}" });
        }
        // reasoning / file 块不回放：store:false 的请求不接受历史推理项
      }
      continue;
    }
    const parts = blocks.filter((b) => b?.type === "text" && b.text).map((b) => ({ type: "input_text", text: b.text }));
    if (parts.length === 1) items.push({ role: "user", content: parts[0].text });
    else if (parts.length > 1) items.push({ role: "user", content: parts });
  }
  return items;
}

/** DSH Message[] → OpenAI Chat Completions 的 messages。 */
function toChatMessages(messages) {
  const out = [];
  for (const message of messages ?? []) {
    const role = message?.role;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    if (role === "tool") {
      const callId = message.toolCallId ?? message.source?.callId;
      if (callId) out.push({ role: "tool", tool_call_id: callId, content: textOf(blocks) });
      continue;
    }
    if (role === "assistant") {
      const entry = { role: "assistant" };
      const text = textOf(blocks);
      if (text) entry.content = text;
      const calls = blocks.filter((b) => b?.type === "tool-call");
      if (calls.length) {
        entry.tool_calls = calls.map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: b.arguments ?? "{}" },
        }));
      }
      if (entry.content || entry.tool_calls) out.push(entry);
      continue;
    }
    const text = textOf(blocks);
    if (text) out.push({ role: role === "system" || role === "developer" ? "system" : "user", content: text });
  }
  return out;
}

function toTools(tools, api) {
  return (tools ?? []).map((t) => {
    const parameters = t.parameters ?? { type: "object", properties: {} };
    if (api === "openai-completions") {
      return { type: "function", function: { name: t.name, description: t.description, parameters } };
    }
    return { type: "function", name: t.name, description: t.description, parameters };
  });
}

/** 解析 SSE 文本流，产出 {event, data}；兼容网关用 CRLF 分隔事件的情况。 */
async function* parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "";
      const dataLines = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) yield { event, data: dataLines.join("\n") };
    }
  }
}

class RelayAdapter {
  constructor(relay) {
    this.relay = relay;
  }

  providerInfo(provider) {
    return { id: provider, name: this.relay.name };
  }

  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    const width = Math.min(image?.width || 1024, 2048);
    return { width, height: Math.round(width * 0.75), maxBytes: 4 * 1024 * 1024 };
  }

  async listModels(provider) {
    return this.relay.models.map((m) => ({ provider, id: m.id, name: m.name, inputModalities: ["text"] }));
  }

  async resolveModel(provider, model) {
    const found = this.relay.models.find((m) => m.id === model) ?? this.relay.models[0];
    return {
      provider,
      id: found?.id ?? model,
      name: found?.name ?? model,
      // LlmModelContext 的字段是 contextWindow（不是 window）；写错会被 llm 服务判为
      // "adapter returned invalid context metadata" 并直接拒绝这次调用。
      context: { contextWindow: found?.contextWindow ?? 400000 },
      inputModalities: ["text"],
      defaultMaxTokens: found?.maxTokens ?? 128000,
    };
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  async *stream(options) {
    const relay = this.relay;
    const url = relay.api === "openai-completions" ? `${relay.baseURL}/chat/completions` : `${relay.baseURL}/responses`;
    // 诊断用：记录 harness 实际传下来的请求形态（块类型计数/工具数/system 长度）
    try {
      const blockTypes = {};
      for (const m of options.messages ?? []) {
        for (const b of m?.content ?? []) blockTypes[`${m.role}:${b?.type ?? "?"}`] = (blockTypes[`${m.role}:${b?.type ?? "?"}`] ?? 0) + 1;
      }
      trace("call " + relay.id + "/" + options.model + " msgs=" + (options.messages?.length ?? 0) +
        " tools=" + (options.tools?.length ?? 0) + " system=" + (options.system?.length ?? 0) +
        " blocks=" + JSON.stringify(blockTypes));
    } catch {}
    const messages = options.messages ?? [];
    const system = typeof options.system === "string" ? options.system : "";
    const body =
      relay.api === "openai-completions"
        ? {
            model: options.model,
            messages: [...(system ? [{ role: "system", content: system }] : []), ...toChatMessages(messages)],
            stream: true,
            max_tokens: options.maxTokens ?? undefined,
            temperature: options.temperature ?? undefined,
            ...(options.tools?.length ? { tools: toTools(options.tools, relay.api) } : {}),
          }
        : {
            model: options.model,
            input: toResponsesInput(messages),
            ...(system ? { instructions: system } : {}),
            ...(options.tools?.length ? { tools: toTools(options.tools, relay.api) } : {}),
            stream: true,
            max_output_tokens: Math.max(16, options.maxTokens ?? 4096),
            temperature: options.temperature ?? undefined,
            store: false,
          };

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: requestHeaders(relay),
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      // 抛异常会被宿主转成「这一回合静默结束」（子代理表现为 left no closing message），
      // 所以改用宿主认识的终止形态，让错误显示出来。
      const code = error?.cause?.code ?? "network";
      const message = failureMessage(`${error?.name ?? "Error"}: ${error?.message ?? error}（${code}）`, { code });
      trace("fetch THREW " + message);
      yield* failureChunks(message, 0);
      yield { type: "finish", reason: { kind: "error", failure: { message, code: "llm-relay-network" } } };
      return;
    }
    trace("http " + response.status + " " + (response.headers.get("content-type") ?? "-"));

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      trace("http NOT OK body: " + redactSecrets(text.slice(0, 800)));
      const message = failureMessage(`llm-relay ${relay.id}: HTTP ${response.status} ${text.slice(0, 500)}`, {
        status: response.status,
      });
      trace("http NOT OK: " + message);
      yield* failureChunks(message, 0);
      yield {
        type: "finish",
        reason: { kind: "error", failure: { message, code: "llm-relay-upstream", status: response.status } },
      };
      return;
    }

    let nextIndex = 0;
    let lastIndex = 0;
    const indexByItem = new Map(); // item id → block index
    const indexByOutput = new Map(); // output_index → block index
    const textByIndex = new Map(); // block index → 累积文本 / 累积 arguments
    const callByIndex = new Map(); // block index → { id, name }：同一个工具调用必须用同一个 id
    let usedTokens = false;
    const seen = new Set();

    const indexFor = (payload) => {
      const byItem = payload?.item_id ? indexByItem.get(payload.item_id) : undefined;
      if (byItem !== undefined) return byItem;
      if (payload?.item?.id && indexByItem.has(payload.item.id)) return indexByItem.get(payload.item.id);
      if (typeof payload?.output_index === "number" && indexByOutput.has(payload.output_index)) {
        return indexByOutput.get(payload.output_index);
      }
      return lastIndex;
    };

    for await (const { event, data } of parseSSE(response)) {
      if (data === "[DONE]") break;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const type = payload.type || event;
      seen.add(type);

      if (type === "response.output_item.added") {
        const item = payload.item ?? {};
        const index = nextIndex++;
        lastIndex = index;
        if (item.id) indexByItem.set(item.id, index);
        if (typeof payload.output_index === "number") indexByOutput.set(payload.output_index, index);
        if (item.type === "reasoning") {
          yield { type: "block-start", index, blockType: "reasoning" };
        } else if (item.type === "function_call") {
          const callId = item.call_id ?? item.id;
          callByIndex.set(index, { id: callId, name: item.name });
          yield { type: "block-start", index, blockType: "tool-call" };
          yield { type: "tool-call-delta", index, id: callId, name: item.name, argumentsDelta: "" };
        } else if (item.type === "message") {
          yield { type: "block-start", index, blockType: "text" };
        }
        continue;
      }

      if (type === "response.output_text.delta") {
        const index = indexFor(payload);
        textByIndex.set(index, (textByIndex.get(index) ?? "") + (payload.delta ?? ""));
        yield { type: "text-delta", index, text: payload.delta ?? "" };
        continue;
      }

      if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
        const index = indexFor(payload);
        textByIndex.set(index, (textByIndex.get(index) ?? "") + (payload.delta ?? ""));
        yield { type: "reasoning-delta", index, text: payload.delta ?? "" };
        continue;
      }

      if (type === "response.function_call_arguments.delta") {
        const index = indexFor(payload);
        textByIndex.set(index, (textByIndex.get(index) ?? "") + (payload.delta ?? ""));
        const call = callByIndex.get(index);
        yield {
          type: "tool-call-delta",
          index,
          id: call?.id ?? payload.item_id ?? "",
          ...(call?.name ? { name: call.name } : {}),
          argumentsDelta: payload.delta ?? "",
        };
        continue;
      }

      if (type === "response.output_item.done") {
        const item = payload.item ?? {};
        const index = item.id && indexByItem.has(item.id) ? indexByItem.get(item.id) : indexFor(payload);
        lastIndex = index;
        const accumulated = textByIndex.get(index) ?? "";
        if (item.type === "reasoning") {
          const text = (Array.isArray(item.summary) ? item.summary.map((s) => s?.text ?? "").join("") : "") || accumulated;
          yield { type: "block-end", index, block: { type: "reasoning", text } };
        } else if (item.type === "function_call") {
          yield {
            type: "block-end",
            index,
            block: {
              type: "tool-call",
              id: item.call_id ?? item.id,
              name: item.name,
              arguments: item.arguments ?? (accumulated || "{}"),
            },
          };
        } else if (item.type === "message") {
          yield { type: "block-end", index, block: { type: "text", text: accumulated || itemText(item) } };
        }
        continue;
      }

      if (type === "response.completed") {
        const usage = payload.response?.usage ?? {};
        yield {
          type: "usage",
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            totalTokens: usage.total_tokens ?? undefined,
          },
        };
        usedTokens = true;
        const hasToolCall = (payload.response?.output ?? []).some((o) => o.type === "function_call");
        yield { type: "finish", reason: { kind: hasToolCall ? "tool-calls" : "stop" } };
        continue;
      }

      if (type === "response.incomplete") {
        // 上游提前结束（例如推理耗尽 max_output_tokens）：如实报 max-tokens，而不是假装 stop
        const usage = payload.response?.usage;
        if (usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              totalTokens: usage.total_tokens ?? undefined,
            },
          };
        }
        usedTokens = true;
        yield { type: "finish", reason: { kind: "max-tokens" } };
        continue;
      }

      if (type === "response.failed" || type === "error") {
        const failure = payload.error ?? {};
        const code = String(failure.code ?? failure.type ?? "llm-relay-upstream");
        const message = failureMessage(`llm-relay ${relay.id}: ${failure.message ?? payload.message ?? "upstream error"}`, {
          code,
        });
        trace("upstream error event: " + redactSecrets(JSON.stringify(payload).slice(0, 800)));
        trace("upstream error finish: " + message);
        yield* failureChunks(message, lastIndex + 1);
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: { message, code },
          },
        };
        return;
      }
    }

    trace("sse done types=" + [...seen].join(",") + " usedTokens=" + usedTokens);
    if (!usedTokens) yield { type: "finish", reason: { kind: "stop" } };
  }
}

function itemText(item) {
  const parts = Array.isArray(item?.content) ? item.content : [];
  return parts.map((p) => p?.text ?? "").join("");
}

const TRACE_FILE = join(homedir(), ".dsh", "llm-relay-boot.log");
function trace(line) {
  try { appendFileSync(TRACE_FILE, new Date().toISOString() + " " + line + "\n"); } catch {}
}

/** 设置页看到的只读快照：永不包含密钥本身。 */
function describeRelays(relays, isRegistered) {
  return relays.map((relay) => ({
    id: relay.id,
    name: relay.name,
    enabled: relay.enabled,
    baseURL: relay.baseURL,
    api: relay.api,
    userAgent: relay.userAgent,
    apiKeyEnv: relay.apiKeyEnv,
    hasKey: Boolean(relay.key),
    keySource: relay.apiKey ? "config" : relay.key ? "env" : "none",
    registered: isRegistered(relay.id),
    models: relay.models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  }));
}

const PROBE_PROMPT = "Reply with exactly: PONG";

/**
 * 真发一次最小请求验证中转可用（设置页「测试连接」）。
 * 与适配器共用同一套请求头，因此 UA / Authorization 的行为和真实调用一致。
 * @returns 上游状态、耗时、以及上游原文（成功时优先给模型回答）
 */
async function probeRelay(relay) {
  const startedAt = Date.now();
  const model = relay.models[0]?.id;
  if (!relay.id) return { ok: false, status: 0, latencyMs: 0, detail: "中转缺少 id", model: "" };
  if (!relay.key) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      model,
      detail: `缺少 API key：请在 ${relay.apiKeyEnv ? `环境变量 ${relay.apiKeyEnv}` : "配置"} 或 ~/.dsh/.env 里提供`,
    };
  }
  if (!model) return { ok: false, status: 0, latencyMs: 0, model: "", detail: "该中转没有配置模型" };

  const url = relay.api === "openai-completions" ? `${relay.baseURL}/chat/completions` : `${relay.baseURL}/responses`;
  const headers = { ...requestHeaders(relay), accept: "application/json" };
  const body =
    relay.api === "openai-completions"
      ? { model, messages: [{ role: "user", content: PROBE_PROMPT }], max_tokens: 16, stream: false }
      : { model, input: PROBE_PROMPT, max_output_tokens: 64, store: false };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let answer = "";
    try {
      const json = JSON.parse(text);
      answer =
        relay.api === "openai-completions"
          ? String(json?.choices?.[0]?.message?.content ?? "")
          : String(
              json?.output_text ??
                (Array.isArray(json?.output) ? json.output : [])
                  .filter((item) => item?.type === "message")
                  .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
                  .map((part) => part?.text ?? "")
                  .join("") ??
                "",
            );
    } catch {}
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      model,
      detail: redactSecrets((answer && answer.trim()) || text.slice(0, 800)),
      hint: response.ok ? "" : failureHint({ status: response.status }),
    };
  } catch (error) {
    const networkCode = error?.cause?.code ?? "network";
    trace("probe FAILED " + relay.id + ": " + redactSecrets(error?.message ?? error));
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      model,
      detail: redactSecrets(`${error?.name ?? "Error"}: ${error?.message ?? String(error)}（${networkCode}）`),
      hint: failureHint({ status: 0, code: networkCode }),
    };
  }
}

const RELAY_PROTOCOLS = new Set(["openai-responses", "openai-completions"]);

/**
 * 校验面板提交的 relays：只允许编辑现有条目（id 集合与顺序不变），并逐字段校验。
 * @returns 可读错误；合法时返回空串
 */
function validateRelaysPayload(payload, currentRelays) {
  if (!Array.isArray(payload)) return "relays 必须是数组";
  const currentIds = currentRelays.map((relay) => relay.id);
  const nextIds = payload.map((relay) => String(relay?.id ?? "").trim());
  if (nextIds.length !== currentIds.length || nextIds.some((id, index) => id !== currentIds[index])) {
    return "只允许编辑现有中转：id 集合与顺序必须保持不变（当前版本不支持新增、删除或重排）";
  }
  for (const relay of payload) {
    const id = String(relay?.id ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return `中转 id 非法：${id || "(空)"}`;
    const baseURL = String(relay?.baseURL ?? "").trim();
    if (/\s/.test(baseURL)) return `中转 ${id} 的接口地址不能包含空白字符`;
    let parsedURL;
    try {
      parsedURL = new URL(baseURL);
    } catch {
      return `中转 ${id} 的接口地址不是合法 URL：${baseURL}`;
    }
    if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
      return `中转 ${id} 的接口地址必须以 http:// 或 https:// 开头`;
    }
    if (!parsedURL.hostname) return `中转 ${id} 的接口地址缺少主机名`;
    if (!RELAY_PROTOCOLS.has(relay?.api)) return `中转 ${id} 的协议必须是 openai-responses 或 openai-completions`;
    if (relay.userAgent !== undefined && typeof relay.userAgent !== "string") return `中转 ${id} 的 User-Agent 必须是字符串`;
    if (relay.apiKeyEnv !== undefined && typeof relay.apiKeyEnv !== "string") return `中转 ${id} 的 key 环境变量名必须是字符串`;
    if (!Array.isArray(relay?.models) || relay.models.length === 0) return `中转 ${id} 至少要配置一个模型`;
    for (const model of relay.models) {
      if (!String(model?.id ?? "").trim()) return `中转 ${id} 有模型缺少 id`;
      if (model.contextWindow !== undefined && !(Number.isFinite(Number(model.contextWindow)) && Number(model.contextWindow) > 0)) {
        return `中转 ${id} 的 contextWindow 必须是有限正数`;
      }
      if (model.maxTokens !== undefined && !(Number.isFinite(Number(model.maxTokens)) && Number(model.maxTokens) > 0)) {
        return `中转 ${id} 的 maxTokens 必须是有限正数`;
      }
    }
  }
  return "";
}

/** 只保留面板可编辑字段：API key 永远不经由面板写入（仍只从环境变量 / .env 读）。 */
function sanitizeRelays(payload) {
  return payload.map((relay) => ({
    id: String(relay.id).trim(),
    name: String(relay.name ?? "").trim() || String(relay.id).trim(),
    enabled: relay.enabled !== false,
    baseURL: String(relay.baseURL).trim().replace(/\/+$/, ""),
    api: relay.api,
    userAgent: String(relay.userAgent ?? "").trim() || BUILTIN_RELAY.userAgent,
    apiKeyEnv: String(relay.apiKeyEnv ?? "").trim(),
    models: relay.models.map((model) => ({
      id: String(model.id).trim(),
      name: String(model.name ?? "").trim() || String(model.id).trim(),
      contextWindow: positiveOr(model.contextWindow, 400000),
      maxTokens: positiveOr(model.maxTokens, 128000),
    })),
  }));
}

/** 找出这一行在 settings 目录里的命名空间（profile entry id）。 */
function findSettingsNamespace(ctx) {
  const settings = ctx.get("settings");
  if (!settings) return "";
  let listed = [];
  try {
    listed = settings.describe() ?? [];
  } catch {
    return "";
  }
  const names = new Set(listed.map((entry) => entry?.ns));
  for (const candidate of ["llm-relay", "include:llm-relay"]) if (names.has(candidate)) return candidate;
  return "";
}

/** 对比回读值与提交值，抓「写入没生效」。 */
function compareWrittenRelays(written, expected) {
  if (!Array.isArray(written) || written.length !== expected.length) return "relays 数量不一致";
  for (let index = 0; index < expected.length; index += 1) {
    const actual = written[index] ?? {};
    const want = expected[index];
    if (String(actual.id) !== want.id) return `第 ${index + 1} 项的 id 不一致`;
    if (String(actual.baseURL ?? "").replace(/\/+$/, "") !== want.baseURL) return `中转 ${want.id} 的 baseURL 未生效`;
    if ((actual.enabled !== false) !== (want.enabled !== false)) return `中转 ${want.id} 的 enabled 未生效`;
    if (String(actual.name ?? "") !== want.name) return `中转 ${want.id} 的 name 未生效`;
    if (String(actual.api ?? "") !== want.api) return `中转 ${want.id} 的 api 未生效`;
    if (String(actual.userAgent ?? "") !== want.userAgent) return `中转 ${want.id} 的 userAgent 未生效`;
    if (String(actual.apiKeyEnv ?? "") !== want.apiKeyEnv) return `中转 ${want.id} 的 apiKeyEnv 未生效`;
    const wantModels = Array.isArray(want.models) ? want.models : [];
    const actualModels = Array.isArray(actual.models) ? actual.models : [];
    if (actualModels.length !== wantModels.length) return `中转 ${want.id} 的模型数量未生效`;
    for (let m = 0; m < wantModels.length; m += 1) {
      const got = actualModels[m] ?? {};
      const wanted = wantModels[m];
      if (String(got.id ?? "") !== wanted.id) return `中转 ${want.id} 第 ${m + 1} 个模型的 id 未生效`;
      if (String(got.name ?? "") !== wanted.name) return `中转 ${want.id} 第 ${m + 1} 个模型的名称未生效`;
      if (Number(got.contextWindow) !== wanted.contextWindow) return `中转 ${want.id} 第 ${m + 1} 个模型的 contextWindow 未生效`;
      if (Number(got.maxTokens) !== wanted.maxTokens) return `中转 ${want.id} 第 ${m + 1} 个模型的 maxTokens 未生效`;
    }
  }
  return "";
}

/**
 * 写回插件行 config：先备份 profile patch，用 settings.update 写，
 * 失败或回读不一致就恢复备份。没有备份能力时拒绝写入。
 */
async function persistRelays(ctx, relays, io = {}) {
  const settings = ctx.get("settings");
  const configEditor = ctx.get("configEditor");
  const ns = findSettingsNamespace(ctx);
  // 允许测试注入 copyFile 以模拟「备份失败 / 回滚失败」两条路径
  const copy = typeof io.copyFile === "function" ? io.copyFile : copyFile;

  let patchPath = "";
  try {
    patchPath = (await settings?.prepareDocument?.()) || "";
  } catch {}
  if (!patchPath) {
    return { ok: false, error: "拿不到 profile patch 路径，拒绝在没有备份的情况下写入" };
  }

  const backup = `${patchPath}.bak-llm-relay-write-${Date.now()}`;
  try {
    await copy(patchPath, backup);
  } catch (error) {
    return { ok: false, error: `备份失败，已放弃写入：${error?.message ?? error}` };
  }
  trace("write backup: " + backup);

  const rollback = async (reason) => {
    let restored = false;
    try {
      await copy(backup, patchPath);
      restored = true;
    } catch (error) {
      reason += `；回滚也失败：${error?.message ?? error}`;
    }
    trace(restored ? "write rolled back: " + reason : "write rollback FAILED: " + reason);
    return { ok: false, error: reason, rolledBack: restored, backup };
  };

  let written = null;
  let settingsError = "";
  /** 回读来源是否独立于本次提交：只有能独立回读才算 verified。 */
  let verified = false;
  let wroteVia = "";
  if (settings && ns) {
    try {
      await settings.update(ns, { relays });
      trace("settings.update ok ns=" + ns);
    } catch (error) {
      settingsError = String(error?.message ?? error);
      trace("settings.update failed: " + settingsError);
    }
    try {
      written = (settings.describe() ?? []).find((entry) => entry?.ns === ns)?.value?.relays ?? null;
      if (written) {
        verified = true;
        wroteVia = ns;
      }
    } catch {}
  }

  // 兜底：settings 没有把这一行投影成表单时，直接走 Loader 的配置编辑器
  if (!written && configEditor) {
    try {
      const entries = configEditor.entries() ?? [];
      const entry = entries.find((item) => (item?.options?.id ?? item?.id) === "llm-relay");
      if (entry) {
        await configEditor.edit(entry, (current) => ({ ...(current ?? {}), relays }));
        trace("configEditor.edit ok");
        wroteVia = wroteVia || "configEditor";
        // 不能拿本次提交自证成功：只有独立回读到的值才算 verified
        try {
          written = (settings?.describe() ?? []).find((item) => item?.ns === "llm-relay")?.value?.relays ?? null;
          if (written) {
            verified = true;
            wroteVia = wroteVia || "configEditor";
          }
        } catch {
          written = null;
        }
      }
    } catch (error) {
      return await rollback(`写入失败：${error?.message ?? error}`);
    }
  }

  if (!written) {
    if (!wroteVia) return await rollback("宿主既没有可用的 settings 表单也没有 configEditor，写回不可用");
    trace("relays written (unverified via " + wroteVia + "): " + relays.map((relay) => `${relay.id}:${relay.enabled ? "on" : "off"}`).join(","));
    return {
      ok: true,
      verified: false,
      ns: ns || wroteVia,
      backup,
      note: settingsError
        ? `写回走 ${wroteVia}，但 settings.update 先报错：${settingsError}`
        : "已写入，但宿主没有暴露可回读的表单，无法确认是否生效",
    };
  }
  const mismatch = compareWrittenRelays(written, relays);
  if (mismatch) return await rollback(`写后校验不一致：${mismatch}`);

  trace("relays written: " + relays.map((relay) => `${relay.id}:${relay.enabled ? "on" : "off"}`).join(","));
  return { ok: true, verified, ns: ns || wroteVia || "configEditor", backup, ...(settingsError ? { note: settingsError } : {}) };
}

function sendJson(res, status, payload) {
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload));
  } catch {}
}

/**
 * 只回答带 `x-llm-relay: 1` 头部的同源请求。
 * 跨源页面加不了这个自定义头（会先触发 CORS 预检并被拒），所以外部网站无法借本机端口探测密钥或消耗额度。
 */
function admitPanelRequest(req, res) {
  if (req.headers["x-llm-relay"] === "1") return true;
  sendJson(res, 403, { error: "missing x-llm-relay header" });
  return false;
}

// ───────────────────────── 零工具单次调用：gpt_review ─────────────────────────
// 用途：把「改动总结 + 关键 diff + 关注点」一次发给中转模型做审查，
// 不带任何工具定义、不读文件、不跑命令——请求量与「在终端里贴一段话问 GPT」同级。

const REVIEW_SYSTEM_PROMPT =
  "你是本项目的独立代码审查方，只读不写（你也没有任何工具，不要假装读过文件）。" +
  "审查依据只有用户给出的总结、diff 与验收标准。铁律：" +
  "1) 每条问题必须带证据：指出是哪段代码/哪一行、为什么错、怎么验证；2) 分三档：阻断 / 应修 / 建议；" +
  "3) 先对齐验收标准逐条判 PASS/FAIL，没给标准就先说明你按什么标准判；4) 不确定就说不确定，禁止用「应该没问题」收尾。" +
  "输出格式：第一行 结论=通过/不通过（或结论=信息不足）；随后 A–F 逐条判定（若对方给了清单）；按三档列问题；最后一行写你最没把握的一条。";

const GIT_MAX_BYTES = 160000;

/**
 * 跑一次 git，**按字节流式采集并限长**：到达上限就停采并终止子进程，
 * 因此不存在「缓冲上限太小导致 ENOBUFS」这一类失败（流式读取没有固定 maxBuffer）。
 * 失败/超时/截断都返回可读状态，从不抛错。
 */
/**
 * 截断时判断末尾是否留下了一个残缺的多字节字符：
 * 从末尾回扫最多 3 个续字节找到起始字节，再对它到末尾的那一段做严格解码。
 * 能解 → 末尾是完整字符（哪怕是合法的 U+FFFD），一个字节都不动；
 * 解不开 → 这一段确实缺后续字节，才把它切掉。
 * 与「正则删 U+FFFD」的区别：不会误删合法字符，也不受全段其它非法字节影响。
 */
function partialTailLength(buffer) {
  const length = buffer.length;
  if (length === 0) return 0;
  // 找一个「切掉 trim 个字节后，剩余末尾字符仍完整」的最小 trim（最多 3，UTF-8 不完整尾部不会更长）
  for (let trim = 0; trim <= 3; trim += 1) {
    const end = length - trim;
    if (end <= 0) return trim;
    let start = end - 1;
    let steps = 0;
    while (start > 0 && steps < 3 && (buffer[start] & 0xc0) === 0x80) {
      start -= 1;
      steps += 1;
    }
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(start, end));
      return trim;
    } catch {
      // 这个边界仍然残缺，多切一个字节再试
    }
  }
  // 全都解不开（例如尾部本来就是非法字节）：不切，交给非严格解码成替换符，绝不删除合法字符
  return 0;
}

/**
 * 把采集到的字节渲染成文本。截断时只切掉真正残缺的尾部字节；
 * 合法字符（含 U+FFFD 与 BOM）在截断与非截断路径下都保持原样。
 */
function renderGitOutput(chunks, { truncated = false, size = 0 } = {}) {
  const buffer = Buffer.concat(chunks);
  const text = truncated ? buffer.subarray(0, buffer.length - partialTailLength(buffer)).toString("utf8") : buffer.toString("utf8");
  return truncated ? `${text}\n…（已截断：仅保留前 ${size} 字节，其余未送审）` : text;
}

function runGit(args, cwd, { maxBytes = GIT_MAX_BYTES, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let truncated = false;
    let size = 0;
    let stderr = "";
    const chunks = [];
    let child;
    let timer;

    const render = () => renderGitOutput(chunks, { truncated, size });
    const finish = (ok, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {}
      resolve({ ok, text, truncated });
    };

    try {
      child = spawn("git", ["--no-pager", "-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, text: `${error?.message ?? error}` });
      return;
    }

    // 先挂 error：启动失败（ENOENT/EMFILE）时错误是异步发出的，先挂上才能兜住
    child.on("error", (error) => finish(false, `git 启动失败：${error?.message ?? error}`));
    timer = setTimeout(() => finish(false, `git 超时（${timeoutMs}ms）`), timeoutMs);
    child.stdout?.on("data", (buffer) => {
      if (truncated || settled) return;
      const remain = maxBytes - size;
      if (buffer.length >= remain) {
        chunks.push(buffer.subarray(0, remain));
        size += remain;
        truncated = true;
        finish(true, render());
        return;
      }
      chunks.push(buffer);
      size += buffer.length;
    });
    child.stderr?.on("data", (buffer) => {
      if (stderr.length < 4000) stderr += buffer.toString("utf8").slice(0, 4000);
    });
    child.on("close", (code) => {
      if (code === 0) finish(true, render());
      else finish(false, `git 退出码 ${code}：${stderr.slice(0, 400) || "(无 stderr)"}`);
    });
  });
}

/**
 * 收集送审材料：显式 diff > commit（git show）> 工作区未提交改动（git diff HEAD）。
 * 这是「调用方替模型做 IO」：模型本身没有任何工具，读不到仓库也跑不了命令，
 * 但可以审一份由调用方取好的、真实且限长的 diff —— 等价于「总结 + commit 号」的做法。
 */
async function gatherMaterial(args = {}, git = runGit) {
  const explicit = String(args.diff ?? "").trim();
  if (explicit) return { ok: true, text: explicit, source: "diff" };

  const cwd = String(args.cwd ?? "").trim();
  const commit = String(args.commit ?? "").trim();
  const paths = String(args.paths ?? "").trim();
  const pathArgs = paths ? ["--", ...paths.split(/\s+/).filter(Boolean)] : [];

  if (commit) {
    const result = await git(
      ["show", "--stat", "--patch", "--no-color", "--format=commit %H%n%s%n", commit, ...pathArgs],
      cwd || process.cwd(),
    );
    return { ...result, source: `commit ${commit}` };
  }
  if (cwd) {
    const result = await git(["diff", "HEAD", "--no-color", "--stat", "--patch", ...pathArgs], cwd);
    return { ...result, source: "working tree" };
  }
  return { ok: true, text: "", source: "" };
}

/** 拼出这次审查要发的内容。 */
function buildReviewPrompt(args = {}) {
  const summary = String(args.summary ?? "").trim();
  const diff = String(args.diff ?? "").trim();
  const focus = String(args.focus ?? "").trim();
  const parts = ["【改动总结】", summary || "(未提供)", ""];
  if (diff) parts.push("【关键 diff】", "```diff", diff, "```", "");
  if (focus) parts.push("【特别关注】", focus, "");
  parts.push("请按审查方格式给出结论。");
  return {
    system: REVIEW_SYSTEM_PROMPT,
    prompt: parts.join("\n"),
    maxTokens: positiveOr(args.max_tokens, 12000),
  };
}

/** 从 Responses / Chat Completions 的返回体里取答案文本。 */
function readAnswer(api, json) {
  if (api === "openai-completions") return String(json?.choices?.[0]?.message?.content ?? "");
  return String(
    json?.output_text ??
      (Array.isArray(json?.output) ? json.output : [])
        .filter((item) => item?.type === "message")
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .map((part) => part?.text ?? "")
        .join("") ??
      "",
  );
}

/**
 * 对某个中转发一次「无工具」请求，返回文本。
 * 与探活共用同一套请求头与失败归因，但不发送 tools 字段。
 */
async function completeOnce(relay, { system, prompt, maxTokens = 8000, idleTimeoutMs = 90000 } = {}) {
  const startedAt = Date.now();
  const model = relay.models[0]?.id;
  if (!relay?.key) {
    return { ok: false, status: 0, latencyMs: 0, model, message: `中转 ${relay?.id ?? "?"} 缺少 API key` };
  }
  if (!model) return { ok: false, status: 0, latencyMs: 0, model: "", message: "该中转没有配置模型" };

  const url = relay.api === "openai-completions" ? `${relay.baseURL}/chat/completions` : `${relay.baseURL}/responses`;
  const headers = { ...requestHeaders(relay), accept: "text/event-stream" };
  const body =
    relay.api === "openai-completions"
      ? {
          model,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: prompt },
          ],
          max_tokens: maxTokens,
          stream: true,
        }
      : {
          model,
          input: prompt,
          ...(system ? { instructions: system } : {}),
          max_output_tokens: maxTokens,
          store: false,
          stream: true,
        };

  const controller = new AbortController();
  let idleTimer;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try {
        controller.abort(new Error(`空闲超时：${idleTimeoutMs}ms 没有收到任何事件`));
      } catch {}
    }, idleTimeoutMs);
  };

  let response;
  try {
    armIdle();
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (error) {
    clearTimeout(idleTimer);
    const aborted = error?.name === "AbortError" || String(error?.message ?? "").includes("空闲超时");
    const code = aborted ? "idle-timeout" : (error?.cause?.code ?? "network");
    const message = failureMessage(
      `${aborted ? "空闲超时" : error?.name ?? "Error"}: ${error?.message ?? error}（${code}）`,
      { code },
    );
    trace("gpt_review THREW " + message);
    return { ok: false, status: 0, latencyMs: Date.now() - startedAt, model, message };
  }

  if (!response.ok) {
    clearTimeout(idleTimer);
    const text = await response.text().catch(() => "");
    const message = failureMessage(`HTTP ${response.status} ${text.slice(0, 800)}`, { status: response.status });
    trace("gpt_review HTTP " + response.status + ": " + message);
    return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, model, message };
  }

  const contentType = response.headers.get("content-type") ?? "";
  let text = "";
  let usage;
  let errorInfo = null;
  let incomplete = false;

  try {
    if (!contentType.includes("text/event-stream")) {
      // 网关没按流式回：按一次性 JSON 处理，保证兼容
      const raw = await response.text();
      const parsed = (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      })();
      text = parsed ? readAnswer(relay.api, parsed) : "";
      usage = parsed?.usage ?? parsed?.response?.usage;
      incomplete = parsed?.status === "incomplete" || Boolean(parsed?.incomplete_details);
    } else {
      for await (const { event, data } of parseSSE(response)) {
        armIdle();
        if (data === "[DONE]") break;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        const type = payload.type || event;
        if (type === "response.output_text.delta") {
          text += payload.delta ?? "";
          continue;
        }
        if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
          continue; // 推理增量只要保活，不要正文
        }
        if (type === "response.completed") {
          usage = payload.response?.usage ?? payload.usage ?? usage;
          break;
        }
        if (type === "response.incomplete") {
          usage = payload.response?.usage ?? usage;
          incomplete = true;
          break;
        }
        if (type === "response.failed" || type === "error") {
          errorInfo = payload.error ?? { message: payload.message, code: payload.code };
          break;
        }
        // chat/completions 的流式分片
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) text += delta;
        if (payload.usage) usage = payload.usage;
        if (payload.choices?.[0]?.finish_reason === "length") incomplete = true;
      }
    }
  } catch (error) {
    clearTimeout(idleTimer);
    const aborted = error?.name === "AbortError" || String(error?.message ?? "").includes("空闲超时");
    const code = aborted ? "idle-timeout" : (error?.cause?.code ?? "network");
    const message = failureMessage(
      `${aborted ? "空闲超时" : error?.name ?? "Error"}: ${error?.message ?? error}（${code}）`,
      { code },
    );
    trace("gpt_review stream THREW " + message);
    return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, model, message };
  } finally {
    clearTimeout(idleTimer);
  }

  if (errorInfo) {
    const message = failureMessage(
      `llm-relay ${relay.id}: ${errorInfo.message ?? "upstream error"}`,
      { code: String(errorInfo.code ?? errorInfo.type ?? "llm-relay-upstream") },
    );
    trace("gpt_review upstream error: " + message);
    return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, model, message, usage };
  }

  if (!String(text).trim()) {
    const reason = incomplete
      ? "上游提前结束：输出预算被推理占满（max_output_tokens）——把 max_tokens 调大再试"
      : "上游返回里没有可读文本";
    return { ok: false, status: response.status, latencyMs: Date.now() - startedAt, model, message: reason, usage };
  }

  return { ok: true, status: response.status, latencyMs: Date.now() - startedAt, model, text: redactSecrets(text), usage };
}

/** 选中要用的中转：显式 id 优先，否则第一个启用且有 key 的。 */
function pickRelay(relays, id) {
  if (!Array.isArray(relays) || relays.length === 0) return undefined;
  if (id) return relays.find((relay) => relay.id === id && relay.enabled && relay.key);
  return relays.find((relay) => relay.enabled && relay.key) ?? relays[0];
}

/** 组装 gpt_review 的工具定义（纯函数，便于测试）。 */
function createReviewToolDefinition(relays, git = runGit) {
  return {
    name: "gpt_review",
    timeoutMs: 300000,
    description:
      "用中转模型（默认 GPT）对一段改动做零工具、单次请求的代码审查：传改动总结 + commit 号或 cwd/diff，返回审查结论。" +
      "传 commit 时宿主会自己跑 git show 取 diff、传 cwd 时取工作区未提交改动——模型本身仍然没有任何工具。" +
      "它不会读文件、不会跑命令（请求里不带任何工具定义），成本约等于一次普通对话；" +
      "请求是流式的（保活），超时按空闲时间算（默认 90s 没有事件才判失败），长推理不容易被网关掐断；" +
      "需要模型自己读仓库或跑测试时改用 subagent 或任务板。",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "本次改动做了什么、为什么改（审查的事实基础，必填）" },
        diff: { type: "string", description: "关键 diff 片段；没有可省略" },
        focus: { type: "string", description: "希望它额外关注的点，例如并发/回滚/密钥泄漏" },
        commit: { type: "string", description: "要审的提交号；宿主会自己跑 git show 取 diff（推荐：总结 + commit 号）" },
        cwd: { type: "string", description: "仓库目录；给了 commit 或只给 cwd 时用来取 diff（只给 cwd 则审工作区未提交改动）" },
        paths: { type: "string", description: "可选：只审这些路径（空格分隔）" },
        relay: { type: "string", description: "使用哪个中转 id；默认第一个可用中转" },
        max_tokens: { type: "number", description: "最大输出 token，默认 12000（推理型模型会把预算先花在 reasoning 上）" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    async execute(args) {
      const relay = pickRelay(relays, args?.relay);
      if (!relay) return { text: "没有可用的中转：检查插件行 config 里的 relays（是否 enabled、是否有 key）" };
      // 调用方替模型做 IO：取 commit / 工作区 diff。取不到就带着原因继续，让审查方知道材料不全。
      const material = await gatherMaterial(args, git);
      const request = buildReviewPrompt({ ...args, diff: material.text || String(args?.diff ?? "") });
      const result = await completeOnce(relay, request);
      const meta = {
        materialSource: material.source || "none",
        materialChars: (material.text || "").length,
        ...(material.ok === false ? { materialError: material.text.slice(0, 200) } : {}),
      };
      if (!result.ok) {
        return { text: `⚠️ GPT 审核失败：${result.message}`, ok: false, model: result.model, relay: relay.id, ...meta };
      }
      return {
        text: result.text,
        ok: true,
        model: result.model,
        relay: relay.id,
        latencyMs: result.latencyMs,
        ...meta,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  };
}

/** 把 gpt_review 注册成一个宿主工具；没有 tools 服务时静默跳过。 */
function registerReviewTool(ctx, relays) {
  const tools = ctx.get("tools");
  if (!tools) {
    trace("no tools service; gpt_review not registered");
    return;
  }
  ctx.effect(() => tools.register(createReviewToolDefinition(relays)), "dsh-llm-relay: gpt_review 工具");
  trace("gpt_review tool registered");
}

/** 设置页的两个同源只读/探活路由；无浏览器宿主（纯 CLI）时静默跳过。 */
function registerPanelRoutes(ctx, relays, isRegistered, note = "") {
  const webServer = ctx.get("webServer");
  if (!webServer) {
    trace("no webServer service; panel routes skipped");
    return;
  }
  trace("registering panel routes under webServer");
  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: "/llm-relay/state",
        handler: (req, res) => {
          if (!admitPanelRequest(req, res)) return;
          sendJson(res, 200, { relays: describeRelays(relays, isRegistered), ...(note ? { note } : {}) });
        },
      }),
    "dsh-llm-relay: 设置页 state 路由",
  );
  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: "/llm-relay/test",
        handler: async (req, res) => {
          if (!admitPanelRequest(req, res)) return;
          let id = "";
          try {
            id = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("id") ?? "";
          } catch {}
          const relay = relays.find((item) => item.id === id);
          if (!relay) {
            sendJson(res, 404, { ok: false, status: 0, latencyMs: 0, detail: `未知中转：${id}`, model: "" });
            return;
          }
          sendJson(res, 200, await probeRelay(relay));
        },
      }),
    "dsh-llm-relay: 设置页 test 路由",
  );
  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: "/llm-relay/update",
        handler: async (req, res) => {
          if (!admitPanelRequest(req, res)) return;
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "只接受 POST" });
            return;
          }
          let body = "";
          try {
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 64 * 1024) throw new Error("请求体过大");
            }
          } catch (error) {
            sendJson(res, 400, { ok: false, error: `读取请求体失败：${error?.message ?? error}` });
            return;
          }
          let payload;
          try {
            payload = JSON.parse(body || "{}");
          } catch {
            sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
            return;
          }
          const invalid = validateRelaysPayload(payload?.relays, relays);
          if (invalid) {
            sendJson(res, 400, { ok: false, error: invalid });
            return;
          }
          const result = await persistRelays(ctx, sanitizeRelays(payload.relays));
          sendJson(res, result.ok ? 200 : 500, result);
        },
      }),
    "dsh-llm-relay: 设置页 update 路由",
  );
}

function apply(ctx, config) {
  trace("apply called | relays=" + (config && config.relays ? config.relays.length : null));
  const relays = normalizeConfig(config);
  trace("apply relays: " + relays.map((relay) => relay.id + "=" + relay.name).join(","));
  const handles = new Map();
  /** logger 也是受检服务；缺失时不能拖垮 apply。 */
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(message);
    } catch {}
  };

  // 坏掉的 relays 配置不等于「插件坏掉」：记录原因、照常激活、面板可见空列表与原因。
  const note = (() => {
    const value = config?.relays;
    if (value === undefined || value === null) return "config.relays 未声明，没有可注册的中转";
    if (!Array.isArray(value)) return "config.relays 不是数组，已忽略";
    if (value.length === 0) return "config.relays 为空，没有可注册的中转";
    return "";
  })();
  if (note) {
    trace("config note: " + note);
    log("warn", "llm-relay: " + note);
  }

  const mount = (relay) => {
    trace("mount " + relay.id + " enabled=" + relay.enabled + " key=" + (relay.key ? "yes" : "NO") + " baseURL=" + relay.baseURL);
    if (!relay.id || !relay.enabled) return;
    if (!relay.key) {
      log("warn", `llm-relay: 中转 ${relay.id} 缺少 API key（apiKey 或 ${relay.apiKeyEnv}），跳过注册`);
      return;
    }
    const adapter = new RelayAdapter(relay);
    try {
      handles.set(relay.id, ctx.llm.registerAdapter([relay.id], adapter));
      trace("registered " + relay.id);
      log("info", `llm-relay: 已注册中转 ${relay.id} → ${relay.baseURL}（UA: ${relay.userAgent}）`);
    } catch (error) {
      // provider id 已被别的来源（例如 GUI 模型页里的同名 provider）占用时不拖垮整个插件行
      trace("register FAILED " + relay.id + ": " + (error && error.message));
      log("warn", `llm-relay: 注册 ${relay.id} 失败（可能已被占用）：${error?.message ?? error}`);
    }
  };

  ctx.effect(() => {
    for (const relay of relays) mount(relay);
    return () => {
      for (const [, handle] of handles) {
        try {
          handle();
        } catch {}
      }
      handles.clear();
    };
  }, "dsh-llm-relay: 注册中转 adapter");

  registerPanelRoutes(ctx, relays, (id) => handles.has(id), note);
  registerReviewTool(ctx, relays);
}

export {
  Config,
  RelayAdapter,
  apply,
  buildReviewPrompt,
  compareWrittenRelays,
  completeOnce,
  createReviewToolDefinition,
  failureHint,
  describeRelays,
  gatherMaterial,
  partialTailLength,
  renderGitOutput,
  inject,
  name,
  normalizeConfig,
  persistRelays,
  pickRelay,
  probeRelay,
  readAnswer,
  resolveKey,
  requestHeaders,
  runGit,
  sanitizeRelays,
  validateRelaysPayload,
};
