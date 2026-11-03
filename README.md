# dsh-llm-relay

把「GPT 中转」（agentrouter 等）做成 DSH 插件：宿主半用自定义 `LlmAdapter` 原生注册 provider，
**请求头由 adapter 自己构造**，从而强制上游白名单要求的 `User-Agent: claude-cli/2.0.1 (external, cli)`
与 `Authorization`；客户端半在设置页提供中转管理面板。

## 为什么需要它

- DSH 内置 pi-ai 适配器会过滤配置里的保留头并用署名 UA 覆盖（`deepseek-harness/...`），
  而上游只认 `claude-cli/2.0.1`：其它 UA 一律 401 `unauthorized client detected`
- 该结论由本地实测得出：同一 key + `claude-cli` UA → HTTP 200；换成默认 UA → 401
- 详见 `docs/CONTRACT.md`（全部类型声明取自 DSH app.asar 的 typert reflection）

## 目录

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半：`LlmAdapter` 8 方法实现 + SSE→StreamChunk 翻译 + 多中转注册/释放 |
| `lib/client.js` | 客户端半骨架：设置页插件卡（中转增删改、启用开关、测试连接占位） |
| `cordis.patch.yml` | 插件自带 patch（本插件不声明行，挂载行写在宿主 profile） |
| `docs/REQUIREMENTS.md` | 六维需求规格 |
| `docs/CONTRACT.md` | API 契约（含未验证项清单） |

## 安装（本地热插拔）

```bash
ln -s "<repo>/plugins/dsh-llm-relay" ~/.dsh/profiles/desktop/node_modules/@local/dsh-llm-relay
```

在 `~/.dsh/profiles/desktop/cordis.patch.yml` **末尾的 `insert` 列表里**追加（顶层裸 `- id:` 只会覆盖
已存在的行，匹配不到任何行时会被 loader 告警跳过——这是 0.1.0 版本"装了却从没挂载"的原因）：

```yaml
- insert:
    - id: llm-relay
      name: '@local/dsh-llm-relay'
      config:
        envFile: C:\Users\<you>\.dsh\.env
        relays:
          - id: agentrouter
            name: AgentRouter · GPT
            enabled: true
            baseURL: https://agentrouter.org/v1
            api: openai-responses
            userAgent: claude-cli/2.0.1 (external, cli)
            apiKeyEnv: AGENTROUTER_API_KEY
            models:
              - id: gpt-6.1-sol
                name: GPT-6.1-Sol
                contextWindow: 400000
                maxTokens: 128000
```

patch 改完宿主会重新装配；改了 `lib/*.js` 则要重启宿主（profile 外的文件不在 HMR 监视范围内）。

## 面板与快捷入口

客户端半提供**同一张面板的两个入口**（复用同一个组件、同一套数据）：

1. **主窗口快捷入口**：左侧栏的全局面板图标列表里多一个「GPT 中转」图标
   （`sidebar.panellist`，id `llm-relay`，order 30，排在 task-board 之后）。
   点它，中央主列直接打开中转面板，不用进设置。
2. **设置页分区**：`settings.section`（id `llm-relay`，order 40，排在「团队房间」之后）。

面板是**可编辑**的（受限写回）：

- 列出插件行 config 里声明的每个中转：名称 / id / 接口地址 / 协议 / 模型 / User-Agent
- 三个状态徽标：已注册（adapter 注册成功）、已配置 key、启用中
- 每个中转一个「测试连接」按钮：**由宿主真发一次上游请求**（与真实调用共用同一套请求头，
  因此 UA / Authorization 行为一致），回显真实 HTTP 状态、耗时与上游原文；成功时优先显示模型回答
- 每个中转一个「编辑」按钮：可改 **名称 / 接口地址 / 协议 / User-Agent / key 环境变量名 /
  首个模型的 名称+id+contextWindow+maxTokens / 启用开关**，保存后写回该行 config，宿主**热重装配**（无需重启）
- 配置真值始终是插件行的 `config`。你也可以继续改「设置 → 插件」或 `cordis.patch.yml`

**保存时的两个防呆**：① 写之前先取一次最新 `/state`，把本次编辑合并到最新数据上，避免用旧快照覆盖别人刚保存的值；
② 写完轮询 `/state` 最多 3 秒，确认新值真的生效，否则提示「已写入但未反映，请刷新」。

**写回的安全阀**：写入前把 profile 的 `cordis.patch.yml` 备份为
`cordis.patch.yml.bak-llm-relay-write-<ts>`；写入后回读校验 id/baseURL/enabled，不一致或抛错即恢复备份。
当前版本**不支持新增、删除或重排**中转（会被 400 拒绝），**API key 永远不经由面板写入**。

两个入口共用 `main(key=llm-relay)` 与 `settings.section(id=llm-relay)` 两个座位；
侧栏图标的 id 必须与 main 的 key 完全一致，否则按钮会指向不存在的面板。

面板数据来源是宿主注册的三个同源路由：

| 路由 | 作用 |
|---|---|
| `GET /llm-relay/state` | 只读快照（不含密钥本体），带 `x-llm-relay: 1` 头 |
| `gpt_review` 工具 | 零工具单次审查：传 summary/diff/focus，一次请求返回审查意见（约 3.5k token/次） |
| `GET /llm-relay/test?id=<relay>` | 探活，返回 `{ok,status,latencyMs,model,detail,hint}`；失败时 `hint` 给出 鉴权/限流/网络/5xx 归因 |
| `POST /llm-relay/update` | 写回 relays（`{relays:[...]}`），校验 → 备份 → 写入 → 回读 → 失败回滚 |

没有该自定义头的请求一律 403：跨源页面加不上这个头（会先触发 CORS 预检），
所以外部网页无法借本机端口探测或消耗额度。

## 排障

- 启动/注册/每次调用/探活的轨迹写在 `~/.dsh/llm-relay-boot.log`，注册失败、上游 4xx/5xx 的原因都在里面。
- 宿主是否认到这一行：`plugin_manager list_plugins` 里应有 `include:llm-relay`，`fiberPhase: active`。
- provider 是否注册：`list_subagent_models` 应出现 `agentrouter — AgentRouter · GPT`。
- 图标或分区没出现：确认 `sidebar.panellist` 的 id 与 `main` 的 key 完全一致（都是 `llm-relay`），
  再刷新一次页面；本机实测客户端改动通常会被热接收，但浏览器缓存情况下仍需刷新。
- **面板一片空白**：先刷新页面。2026-11-03 修过一个这类崩溃——编辑表单在非编辑态也被构造，
  解引用了 `null` 的 draft，渲染抛错导致整块面板空白；`test/client-smoke.mjs` 现在会渲染非编辑态与编辑态
  两种卡片，防止回归。

## 验收（2026-11-03 本机实测）

1. ✅ `list_subagent_models` 中出现 `agentrouter — AgentRouter · GPT`；`provider=agentrouter` 下列出 `agentrouter/gpt-6.1-sol`
2. ✅ 子代理 `provider=agentrouter model=gpt-6.1-sol` 回 `PONG`（含 6 轮工具调用的完整 agent 回合也通过）
3. ✅ `GET /llm-relay/state` 返回 agentrouter 的 baseURL/模型/`registered:true`/`hasKey:true`，响应里没有密钥
4. ✅ `GET /llm-relay/test?id=agentrouter` 返回 `{ok:true,status:200,latencyMs:4033,detail:"PONG"}`
5. ✅ 缺 key → `hasKey:false` + `detail:"缺少 API key：…AGENTROUTER_API_KEY…"`；未知 id → HTTP 404 + 明确原因；错误 key → 真实 `status:401` + 上游原文
6. ✅ 改该行 config（把中转名改成带 `(hot)`）→ 宿主自动 `apply called` 并重新注册 adapter 与路由，`/state` 立即可见新值；改回后同样热生效
7. ✅ `test/client-smoke.mjs`（三个座位 `settings.section` / `main` / `sidebar.panellist`、id 与 key 一致、
   order、中英文案、图标可渲染且缺参不抛错）、`test/host-apply-smoke.mjs`（无 webServer 时 adapter 照常注册、
   畸形 relays 不打挂插件行、两条路由注册、缺头 403、state 不含密钥）与 `test/adapter-smoke.mjs` 均 PASS
8. ✅ 在线客户端已认到入口：`settings.section` 有 `{id:"llm-relay", order:40}`，
   `sidebar.panellist` 有 `{id:"llm-relay", order:30}`，`main` 有 `{key:"llm-relay"}`，三者均 `active:true`
9. ✅ `POST /llm-relay/update` 拒绝新增条目与非法 URL：两者都返回 HTTP 400 与可读中文原因
10. ✅ 面板写入链路实测：改名 → `200 {ok:true, ns:"configEditor", backup:"…cordis.patch.yml.bak-llm-relay-write-…"}`
    → `/state` 立即返回新名 → 宿主 `apply called` 并重新注册 adapter → 再改回原名同样成功；
    写入后 `cordis.patch.yml` 仍可解析（15 个 patch 项）、中文注释保留、`insert` 行仍完整
11. ✅ `test/host-write-smoke.mjs`（拒绝增删/重排与坏字段、密钥不外泄、回读不一致可检出）与
    其余三个测试均 PASS
12. ✅ 编辑表单与保存流程经用户实测确认：保存后显示「已生效：面板与宿主已同步」，卡片值与 `/state` 一致

## 已知未验证项

- 面板渲染、点击跳转与编辑表单交互已由用户确认（第 12 条）。
- 写回实际走的是 `configEditor` 兜底路径：`settings.describe()` 没有把本行投影成表单
  （`relays` 声明为 `z.any`，不可投影），所以 `settings.update` 分支未触发；两条路径都保留并有 trace。
- 并发写（两个标签页同时保存）不做合并：后写覆盖先写；每次写前都会生成备份。
- 面板只能编辑不能增删中转；多模型只编辑第一个。
- `enabled: false` 释放注册——逻辑已写（`ctx.effect` 的 disposer），尚未单独验收。
- 上游失败现在回报为 `finish: {kind:'error', failure:{message,code,status}}`，并按 鉴权/限流/网络/5xx
  附中文归因提示（例：【限流】上游对当前出口 IP 限流…换节点；【网络】本机到上游不通…先看代理）。
  极少数情况下宿主仍可能把它显示为一次失败回合，但错误文本会保留在会话里。
- `imageRequestTarget`/`imageRequestPricing` 是占位实现；`inputModalities` 只声明 `text`。
