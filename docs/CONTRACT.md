# 契约（从 DSH app.asar 实测提取，非推测）

> 来源：C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app.asar
> 提取方式：`toString("latin1")` 后按关键字定位（asar 未压缩，可直接搜）。
> 下列声明均为 **typert.host.js 里 FaceModel reflection 保存的原始 TypeScript 声明原文**。

## Q1 · LlmAdapter 接口（8 方法）

```ts
export abstract class LlmAdapter {
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
    imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined;
    imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
```

配套类型：

```ts
interface LlmProviderInfo { id: string; name: string; }
interface LlmModelInfo { provider: string; id: string; name: string; description?: string; inputModalities?: readonly ModelModality[]; }
interface LlmResolvedModelInfo extends LlmModelInfo {
    context?: LlmModelContext;
    defaultMaxTokens?: number;
    reasoning?: LlmModelReasoningInfo;
    systemPromptUpdate?: SystemPromptUpdate;
    toolUpdate?: ToolUpdate;
}
interface PreparedAdapterCall {
    readonly model: LlmResolvedModelInfo;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
interface LlmImageRequestPricing {
    priceImages(images: readonly ImageBlock[]): readonly LlmImageRequestPrice[];
}
```

注册句柄（用于多条目独立启停）：

```ts
interface AdapterRegistrationHandle {
    (): void;                    // 调用即释放该 provider 的注册
    replace(providers: string[]): void;  // 替换注册的 provider 列表
}
```

调用形态（实测自 DSH 内置 provider 的注册处）：
```js
const registration = ctx.llm.registerAdapter([provider], adapter);
```

## Q2 · 协议映射与 HTTP 归属

- `prepareCall` 只返回 `{ model, stream }`，**不负责发 HTTP**（实测：`prepareCall` 的返回体仅为 `{model, stream:(options)=>this.stream(options)}`）。
- `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` 是抽象方法，**由 adapter 自己实现并向供应商发请求**。
- 因此自定义 adapter 自己发 HTTP，协议（openai-responses / chat/completions）由 adapter 内部决定，不受内置 pi-ai 适配器约束。

## Q3 · 请求头可控性（UA / Authorization）

**结论：走内置 pi-ai provider 配置不可行；走自定义 adapter 可行。**

证据：

1. `dsh-llm-pi-ai` 的 `requestHeaders()`（asar 绝对字节偏移约 82983694）调用 `attributionHeaders()`：先以小写名过滤掉配置 `headers` 中的**保留头**，再填充 attribution —— 即 `User-Agent` 会被丢弃并被覆盖。
2. `dsh-llm/lib/types/attribution.js:33-44`：`attributionHeaders(identity)` 只能产出 `user-agent = 产品名/版本 (+url)` 形态，无法产出 `claude-cli/2.0.1 (external, cli)`。
3. 实测 DSH 发出的真实 UA（本地网关日志）：`deepseek-harness/0.2.1-rc.5 (+https://github.com/deepseek-ai/deepseek-harness)`；同一 key + `claude-cli/2.0.1 (external, cli)` 直连上游返回 200，换成其它 UA 返回 401 `unauthorized client detected`。

因此：**自写 adapter 在自己的 `stream()` 里构造请求头，即可精确控制 `User-Agent` 与 `Authorization`**，无需本地代理进程。

## Q4 · 客户端设置页注册

已查明（asar 统计 + liangshen 客户端半实测）：

- 客户端半是预打包 bundle，外层为 `window.__ModuleLoader__.load({ id, factory(require) })`；模块由宿主注入（package.json 的 `dsh.client.inject` 列表），代码里用 `require("<已注入包名>")` 取用。
- UI 挂载用 **`ctx.slots.register({...})`**（liangshen 实测：`const unregister = ctx.slots.register({...})`，可返回注销函数；也用过 target 名 `web-ui.plugin.item`）。
- 文案用 **`ctx.locale.register(NS, {...})`**。
- 设置页现有分区名（asar 内可搜）：`settings.general` / `settings.models` / `settings.plugins` / `settings.transcript` / `settings.theme` / `settings.performance` / `settings.onboarding` / `settings.emulation` / `settings.credential` …
- **待验证**：注册一个**全新设置分区**（而非仅一个 slot 组件）的确切调用与 target 名；现有证据只到"能注册 slot 组件"。

## Q5 · 配置读写与"测试连接"通道

- 宿主侧配置表单服务：`ctx.configForms.get(namespace)`（实测用法 `ctx.configForms.get(LOCALE_SETTINGS_NAMESPACE)`、`ctx.configForms.get(AGENT_PRESET_SETTINGS_NS).getSnapshot()`），另有 `configForms.whileServed` / `configForms.describe` / `configForms.developerTools`。
- 客户端与宿主之间的设置 RPC 名（asar 内可搜）：`settings/describe`、`settings/describe`、`settings/configure`…，以及业务侧 `settings.describe` / `settings.configure`。
- 面板"测试连接"**不必做成 LLM 工具**：可走宿主 Typert Remote（包可导出 `./typert`，或用 `ctx.typert.register` 手写 wire schema）。
- **待验证**：`./typert` 导出与 `ctx.typert.register` 的确切签名与最少样板；尚未实装验证。

## Q6 · 装载与生效

- 插件包与 DSH 内置插件同构：`package.json` 的 `dsh` 字段声明 `bundle.patch`（自带 cordis.patch.yml）与 `client.inject`；`main` 指向宿主半，`exports["./client"]` 指向客户端半。
- 装载：包放进 `~/.dsh/profiles/desktop/node_modules/<scope>/<name>`（本地开发用 symlink 指向仓库目录），再在该 profile 的 `cordis.patch.yml` 里加一行 `- id: <row-id>\n  name: '<包名>'`（可与现有 `@deepseek-ai/dsh-*` 行并列），`config:` 交给插件自己的 schemastery schema。
- **待验证**：新增插件行是否需重启宿主才生效（现网证据：`cordis.patch.yml` 的改动需重启才能装配；presets 内的行在重启前不生效但会话重新装配时生效——两类行为不同，实现时要在文档里实测标注）。

## 消息与工具类型（已提取，实现依据）

```ts
type Message = MessageRoleMap[keyof MessageRoleMap];   // user / assistant / tool / system 各变体
interface MessageBase {
    readonly id: MessageId;
    readonly content: readonly ContentBlock[];
    readonly source: MessageSource;
}
interface UserMessage extends MessageBase { readonly role: 'user'; }
interface AssistantMessage extends MessageBase { readonly role: 'assistant'; readonly source: ModelMessageSource; }
type RequestMessage = Message | RequestUserInput;

// ContentBlock 家族（关键成员）
interface TextBlock { type: 'text'; text: string; citations: Array<TextCitation> | null; }
interface ThinkingBlock { type: 'thinking'; thinking: string; signature: string; }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown; caller: DirectCaller | ServerToolCaller | ServerToolCaller20260120; toolset_name?: string | null; }
interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef; offloaded?: true; }
interface ToolRemovalBlock { type: 'tool-removal'; toolName: string; }
// 注：tool_result 类 block 未逐字提取（见下方"未提取"），实现时以运行时观测补齐

interface ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown>; }
interface ToolHistory {
    readonly tools: readonly ToolSchema[];
    readonly updates: readonly { readonly messageId: MessageId; readonly additions: readonly ToolSchema[]; }[];
}

// 结束原因（finish chunk 的取值）
interface FinishReasonMap {
    stop: { kind: 'stop'; };
    'tool-calls': { kind: 'tool-calls'; };
    'max-tokens': { kind: 'max-tokens'; };
    aborted: { kind: 'aborted'; failure: LlmFailure; };
    error: { kind: 'error'; failure: LlmFailure; };
}
```

## 尚未提取（实现前必须补）

- `Message` / `ToolHistory` / `ToolResultBlock` 的确切结构（`RequestMessage = Message | RequestUserInput` 已确认，但 Message 的 role/content 形状未取）。
- `ContentBlockType`、`FinishReason` 的取值枚举（StreamChunk 翻译需要）。
- `UserMessage['content']` 形态。

## StreamChunk 判别联合（adapter 的翻译目标，7 种）

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType; }
  | { type: 'text-delta'; index: number; text: string; }
  | { type: 'reasoning-delta'; index: number; text: string; }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string; }
  | { type: 'block-end'; index: number; block: ContentBlock; }
  | { type: 'usage'; usage: TokenUsage; }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope; };
```

```ts
interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
```

## GenerateOptions（adapter 从宿主拿到的全部输入）

```ts
interface GenerateOptions {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
    messages: RequestMessage[];
    system?: string;
    tools?: ToolSchema[];
    toolHistory?: ToolHistory;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
    sessionId?: Branded<'SessionId'>;
    purpose?: 'compaction' | 'session-title';
}
```
