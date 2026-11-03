# 用 GPT 做审查与编码（协作流程）

中转插件（`@local/dsh-llm-relay`）本身只是把 `agentrouter/gpt-6.1-sol` 注册成一条 LLM 路由。
这份文档讲的是**拿到这条路由之后怎么用**：让 DSH 这边的代理把 GPT 当审查员和开发手。

前置检查（任一失败就往下看「排障」）：

```
list_subagent_models                       → agentrouter — AgentRouter · GPT
list_subagent_models provider=agentrouter  → agentrouter/gpt-6.1-sol
GET /llm-relay/test?id=agentrouter         → {ok:true,status:200,detail:"PONG"}
```

## 关键事实：`subagent` 工具没有 preset 参数

`subagent` / `subagent_fork` 只接受 `provider`、`model`、`reasoning_effort`、`cwd`。
profile 里的 `gpt-reviewer`、`gpt-dev` 两个预设**不会**被这个工具使用——它们只在
Web GUI 新建会话、或任务板 `mode` 字段里生效。

所以有两条路，按「要不要强制只读」选：

| 路径 | 怎么调 | 只读强制 | 适用 |
|---|---|---|---|
| 子代理 + 角色 prompt | `subagent(provider=agentrouter, model=gpt-6.1-sol, prompt=…)` | ❌ 靠 prompt 约束 | 快速审查、写代码、一次性任务 |
| 任务板 + 预设 | `task_board_create(mode="gpt-reviewer", model="agentrouter/gpt-6.1-sol")` 再 `task_board_run` | ✅ 预设本身没给 write/edit 工具 | 需要硬性只读的正式审查 |

## 流程 A（最省钱）：gpt_review —— 零工具单次审查

宿主工具 `gpt_review` 把「总结 + diff + 关注点」一次发给中转模型：**请求里不带任何工具定义**，
不读文件、不跑命令，成本约等于一次普通对话。

```
gpt_review(
  summary="本次改动做了什么、为什么",   # 必填
  diff="关键 diff 片段",                # 可选
  focus="特别关注点",                   # 可选
  max_tokens=12000,                      # 可选；推理型模型会把预算先花在 reasoning 上
)
```

实测（2026-11-03）：

| 指标 | 值 |
|---|---|
| 请求数 | 1 |
| input | 295 token |
| output | 3266 token（其中 reasoning 2535） |
| 耗时 | 84s |
| 对比：子代理审查 | 每轮一次请求，5–15 轮，单请求还带 69 个工具 schema（约 10–30 倍） |

注意：`max_tokens` 太小会被推理吃光（返回 `status: incomplete`、无正文），
工具会明确报「输出预算被推理占满」，此时调大再试。

## 流程 B：需要 GPT 自己读仓库时——子代理

## 流程 A2：我写，GPT 审（子代理版，贵但能读文件）

1. Lead（当前会话的模型）实现改动，跑通测试
2. 把**证据**交给 GPT：改了哪些文件、关键 diff、验收标准、已知未验证项
3. GPT 只读审查，产出：结论（通过/不通过）+ 逐条 PASS/FAIL + 三档问题 + 最没把握的一条
4. Lead 逐条回应：真问题就修，假问题说明为什么假，修完再送审一轮

要点：子代理**不继承本会话上下文**，要做审查就必须把 `文件:行号`、diff 片段、
验收标准写进 prompt，不能只说「审一下刚才那次改动」。

## 流程 B：GPT 写，我验

1. 给 GPT 一个**边界清晰、可自证**的任务：指定能改的文件、产出格式、验证命令
2. GPT 交付后，Lead 亲自跑验证命令，检查它有没有偷偷改别的文件
3. 对不上就让 GPT 解释，不要替它改口

适合：写测试、写小工具、独立模块、文档；不适合：跨多文件重构、需要长上下文推理的改动。

## 流程 C：严格只读审查（任务板）

```
task_board_create(
  title="审查 X",
  prompt="…审查任务与验收标准…",
  mode="gpt-reviewer",
  model="agentrouter/gpt-6.1-sol",
  permission="read-only",
)
task_board_run(taskId=…)
```

这条路的价值：`gpt-reviewer` 预设里 `write:false / edit:false`，GPT **物理上改不了代码**，
比在 prompt 里写「不许改」可靠。

## 提示词模板

审查员（配流程 A；配流程 C 时预设里已经有一份，可只给任务材料）：

```
你是本项目的独立代码审查方。你的唯一产出是审查结论，不是代码。
铁律：
1. 只读不写；需要改的地方用「文件:行号 + 应该改成什么」描述
2. 每条问题必须带证据：文件:行号、为什么错、怎么验证
3. 分三档：阻断 / 应修 / 建议
4. 先对齐验收标准，逐条判 PASS/FAIL；没给标准就先问，不要自己发明
5. 不确定就说不确定
输出：第一行 结论=通过/不通过；随后 A–F 逐条判定；按三档列问题；最后一行写最没把握的一条
```

开发手：

```
你是本项目的开发者。边界：只改 <目录/文件>，其它路径不动。
铁律：
1. 动手前先读准现状（真实文件、真实行号）
2. 每个改动给出验证方法与预期输出；不能执行就写「未执行」，不许谎称已验证
3. 命名与签名以 <真值文档> 为准
4. 不用占位符/TODO 糊过去；做不到就停下来说明卡在哪
报告：改了哪些文件 → 为什么 → 怎么验证 → 还有什么没做
```


## 三个必须同时成立的条件（踩坑记录）

| 条件 | 位置 | 现状 |
|---|---|---|
| 会话级白名单包含该路由 | profile `cordis.patch.yml` 的 `tool-subagent.modelSelectionSettings.allowedModels`（本 profile 在第 107–112 行） | ✅ `agentrouter/gpt-6.1-sol` |
| **该会话预设自己的** `tool-subagent` 行开了 `modelSelectionSettings: true` | 预设内部的行，不是 profile 顶层那一行 | ✅ 当前默认预设已开 |
| 插件注册了 provider | `~/.dsh/llm-relay-boot.log` 出现 `call agentrouter/gpt-6.1-sol` + `http 200` | ✅ |

⚠️ **同一组合作用域里只能有一行 `modelSelectionSettings: true`**。两行都开会把
`list_subagent_models` 注册两次，宿主直接报
`tool 'list_subagent_models' is already registered in this scope`，整个会话起不来。
想在新预设里也开，先确认它和已有那一行不在同一个 scope。

⚠️ **子代理不吃预设**：`subagent` 只接受 `provider / model / reasoning_effort / cwd`，
传 `agent_preset` 会被拒（`agent_preset selection is disabled for this tool instance`）。
人设对子代理无效，只能写进 prompt；要硬约束（只读）就走任务板 `mode`。

## 自建预设的两个坑

1. **compaction 必须包 isolate**，否则预设挂不上：
   ```yaml
   - id: compaction
     name: cordis:group
     group: true
     isolate: { compaction: true, toolResultPruner: true }
     config:
       - id: compaction-basic
         name: '@deepseek-ai/dsh-compaction-basic'
   ```
   不包会报 `agent preset is unavailable: Preset services require isolate realms: compaction`。
2. 预设是 **boot 时组合**的：改完要重启宿主；还要 `order` 不和现有预设冲突，GUI 才会列出。

## 验收口径：别只用「回 PONG」

极简一句话探针容易被网络抖动或模型自身行为干扰，**不能单独作为链路验收**。按可靠性排序：

1. `GET /llm-relay/test?id=agentrouter` → `{ok:true,status:200,detail:"PONG"}`（宿主侧真发请求，最快）
2. 子代理做「读一个文件并回显其中一行」→ 同时验证 文本 + 工具调用 + 工具结果回灌
3. 极简「只回 PONG」→ 仅作参考

⚠️ 探活突然全失败时，先确认上游可达：`curl -m 10 https://agentrouter.org/v1/models`
连 TLS 握手都失败（直连与代理都失败）= 网络问题，不是插件。2026-11-03 12:55 就出现过一次
`ECONNRESET / TLS handshake failed`，当时所有探针同时失败。

## 实测记录（2026-11-03）

- GPT（`agentrouter/gpt-6.1-sol`）作为子代理跑完整工具回合：6 轮工具调用，最终正确返回工作目录路径
- 审查：对 `lib/index.js` 写回链路做对抗式审查（见本会话记录 / `docs/` 下报告）
- 开发：让 GPT 独立编写 `test/host-normalize-smoke.mjs` 并自证跑通（我方复跑：退出码 0，PASS）
- 串行探针（读文件并回显）：GPT 读 `package.json` 第 2 行、指出我 prompt 里写错了行号、只回该行原文 —— 文本 + 工具调用 + 工具结果全链路通过
- `GET /llm-relay/test?id=agentrouter` → `{ok:true,status:200,detail:"PONG"}`
- **审查闭环实测（2026-11-03，6 轮）**：同一处 `runGit` 改动被审 6 次，前 5 次都判「不通过」且每次都指出**真实**缺陷
  （措辞过头 → 固定 maxBuffer → U+FFFD 误删 → spawn error 顺序 → BOM/非法前缀 → 孤立续字节），第 6 次「通过」。
  每轮成本约 1k input / 5–8k output（其中 80–95% 是 reasoning）、100–270s。**小 diff + 只问一两件事**才跑得动；
  中等及以上 diff 会把 12k–20k 输出预算全花在 reasoning 上、甚至超时。
- ⚠️ **并发跑两个探针会把出口 IP 的令牌速率打爆**（`rate_limit_exceeded`），随后同批请求被归类为【限流】。
  结论：探活要串行、单发；并发探针本身就会制造失败。

## 失败归因：先查网络，再怀疑模型

插件把上游失败归成四类，提示会**直接写进错误信息**（`finish:{kind:'error', failure.message}`，
面板的「测试连接」也带 `hint` 字段），所以会话里看到的第一句话就是该去查什么：

| 症状 | 归因 | 该做什么 |
|---|---|---|
| 401/403、`invalid_api_key` | 【鉴权】 | 查 API key 是否有效/过期（与网络无关） |
| 429、`rate_limit_exceeded`、`too_many_requests` | 【限流】出口 IP 被限速 | **换代理节点/出口 IP**，或等一会儿；不是模型坏了 |
| `ECONNRESET`、`ETIMEDOUT`、`ENOTFOUND`、TLS 握手失败 | 【网络】 | 查代理是否在线、节点质量、DNS；代理不行 GPT 会重试到失败 |
| 5xx | 【上游】 | 多为出口 IP 或上游临时故障，换节点或稍后重试 |

判断口诀：**同一 key 换个节点就好了 → 是出口 IP/代理；换谁都 401 → 才是 key。**
不要因为一两次失败就得出「GPT 不可用」。

## 排障

- `adapter returned invalid context metadata` → 插件的 `resolveModel` 元数据字段不对（已修）
- 子代理「没有回复」→ 先看 `~/.dsh/llm-relay-boot.log` 里是否有 `http 4xx/5xx` 或 `upstream error event`
- 模型能对话但工具调用失败 → 检查 `blockType` 必须是 `tool-call`（已修）
- 只想要一句话确认可用：`GET /llm-relay/test?id=agentrouter` 应回 `PONG`