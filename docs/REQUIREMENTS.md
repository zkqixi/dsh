# dsh-llm-relay · 需求规格（v1）

## 目标
把「GPT 中转」做成本机 DSH 插件，取代手工搭建的本地网关：

- 宿主半：用 `ctx.llm.registerAdapter([providerId], adapter)` 原生注册中转 provider，在请求头里强制 `User-Agent: claude-cli/2.0.1 (external, cli)` 与 `Authorization: Bearer <key>`（上游 agentrouter 只认该 UA，DSH 默认发 `deepseek-harness/...` 会被 401）。
- 客户端半：设置页新增「GPT 中转」页签，管理多条中转（名称/baseURL/协议/模型/key/UA 头），逐条启用开关，「测试连接」显示上游真实返回。

## 范围
- 新增 `plugins/dsh-llm-relay/`：package.json、lib/index.js、lib/client.js、cordis.patch.yml、docs/
- 通过 symlink 挂到 `~/.dsh/profiles/desktop/node_modules/@local/dsh-llm-relay`，并在该 profile 的 cordis.patch.yml 加一行挂载
- 内置一条 agentrouter 中转（baseURL https://agentrouter.org/v1，api openai-responses，model gpt-6.1-sol）
- 不改 DSH 本体 / app.asar

## 验收标准
1. 面板可增删改多条中转，每条独立启用开关
2. 面板「测试连接」显示上游真实结果（成功 / 错误原文）
3. 启用时子代理 provider=agentrouter、model=gpt-6.1-sol 真回 PONG；禁用后该路由不可用
4. 密钥优先读环境变量（AGENTROUTER_API_KEY），未设置则用面板录入值
5. 启停无需重启宿主（若宿主限制，必须在文档中写明）

## 失败模式
- adapter 接口与预期不符 → 由 P0 契约 spike 先定，不符合则退回本地代理方案
- 客户端无法注册设置页/无法读写宿主配置 → 退化为配置驱动 + 只读面板
- UA 注入点不在 adapter 可控范围 → 保留本地网关兜底
- 重复注册同一 provider id → 注册前 replace/释放
- 配置写坏 → 面板写前校验并保留备份

## 优先级
主链路优先：「子代理能跑通 PONG」（UA + key 注入）。面板易用性可降级，但链路必须真通。

## 非目标（v1 不做）
- 不改 DSH 本体
- 不做模型自动发现、用量统计
- 不把明文 key 提交进 git
- 不做 npm 发布（先本地热插拔包）
