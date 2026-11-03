/**
 * dsh-llm-relay · 客户端半
 *
 * 形态与宿主注入的客户端插件一致：window.__ModuleLoader__.load({ id, factory(require) })，
 * 由宿主按 package.json 的 dsh.client 注入依赖模块。
 *
 * 本半只贡献一个设置页分区（settings.section，id=llm-relay）：
 *   · 只读展示当前生效的中转（配置真值仍是插件行 config，由 DSH settings 投影，改配置会热重装配）
 *   · 每个中转一个「测试连接」按钮，真正发请求的是宿主（/llm-relay/test），
 *     浏览器不直连上游，因此不会暴露密钥、也不受 CORS 影响。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-llm-relay",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    /** 文案命名空间。 */
    const NS = "llm-relay";
    /** 宿主侧同源路由前缀。 */
    const ENDPOINT = "/llm-relay";
    /** 宿主只回答带这个自定义头的同源请求；跨源页面加不上它。 */
    const HEADERS = { "x-llm-relay": "1" };

    const zh = {
      nav: "GPT 中转",
      title: "GPT 中转",
      intro:
        "这里列出并编辑插件行 config 里的中转。保存会写回那一行 config 并让宿主热重装配（写入前自动备份 cordis.patch.yml）。不支持新增/删除中转，API key 仍只从环境变量或 ~/.dsh/.env 读。",
      refresh: "刷新",
      loading: "读取中…",
      failed: "读取失败",
      empty: "这一行没有声明任何中转。",
      test: "测试连接",
      testing: "测试中…",
      baseURL: "接口地址",
      api: "协议",
      models: "模型",
      userAgent: "User-Agent",
      keyReady: "已配置 key",
      keyMissing: "缺少 key",
      registered: "已注册",
      unregistered: "未注册",
      disabled: "已停用",
      status: "状态码",
      latency: "耗时",
      result: "上游返回",
      unknownError: "没有拿到结果",
      readOnly: "只读",
      editable: "可编辑",
      edit: "编辑",
      save: "保存",
      saving: "保存中…",
      cancel: "取消",
      name: "名称",
      modelId: "模型 id",
      contextWindow: "上下文窗口",
      maxTokens: "最大输出",
      enable: "启用",
      saveOk: "已保存，宿主正在重新装配",
      saveApplied: "已生效：面板与宿主已同步",
      savePending: "已写入，但宿主还没反映出新值；请刷新页面确认",
      saveFailed: "保存失败",
      keyEnv: "key 环境变量",
      modelName: "模型名称",
      modelHint: "这里只编辑第一个模型；多模型请改 cordis.patch.yml",
      currentModel: "当前模型",
    };

    const en = {
      nav: "GPT Relay",
      title: "GPT Relay",
      intro:
        "Relays declared by this plugin row's config. Saving writes that config back and the Host recomposes (cordis.patch.yml is backed up first). Adding or removing relays is not supported here, and the API key keeps coming only from the environment or ~/.dsh/.env.",
      refresh: "Refresh",
      loading: "Loading…",
      failed: "Failed to load",
      empty: "This row declares no relays.",
      test: "Test connection",
      testing: "Testing…",
      baseURL: "Base URL",
      api: "API",
      models: "Models",
      userAgent: "User-Agent",
      keyReady: "Key configured",
      keyMissing: "Key missing",
      registered: "Registered",
      unregistered: "Not registered",
      disabled: "Disabled",
      status: "Status",
      latency: "Latency",
      result: "Upstream reply",
      unknownError: "No result",
      readOnly: "Read-only",
      editable: "Editable",
      edit: "Edit",
      save: "Save",
      saving: "Saving…",
      cancel: "Cancel",
      name: "Name",
      modelId: "Model id",
      contextWindow: "Context window",
      maxTokens: "Max output",
      enable: "Enabled",
      saveOk: "Saved; the Host is recomposing",
      saveApplied: "Applied: panel and Host agree",
      savePending: "Written, but the Host does not reflect it yet; refresh to confirm",
      saveFailed: "Save failed",
      keyEnv: "Key env var",
      modelName: "Model name",
      modelHint: "Only the first model is edited here; edit cordis.patch.yml for more.",
      currentModel: "Current model",
    };

    /** 语义色用主题 token，亮/暗两套自动跟随。 */
    const TONE = {
      ok: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      error: "var(--dsw-alias-state-error-primary)",
      idle: "var(--dsw-alias-state-idle-primary)",
    };

    function chip(text, tone) {
      const color = TONE[tone] ?? TONE.idle;
      return h(
        "span",
        {
          key: text,
          style: {
            display: "inline-block",
            padding: "1px 8px",
            borderRadius: 999,
            border: `1px solid ${color}`,
            color,
            fontSize: 11,
            lineHeight: "18px",
            whiteSpace: "nowrap",
          },
        },
        text,
      );
    }

    function field(label, value) {
      return h(
        "div",
        { style: { display: "flex", gap: 12, fontSize: 12, lineHeight: "20px" } },
        h("span", { style: { minWidth: 84, flex: "0 0 auto", color: "var(--dsw-alias-label-secondary)" } }, label),
        h("span", { style: { color: "var(--dsw-alias-label-primary)", wordBreak: "break-all", minWidth: 0 } }, value),
      );
    }

    const inputStyle = {
      flex: 1,
      minWidth: 0,
      fontSize: 12,
      padding: "4px 8px",
      borderRadius: 6,
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-base)",
      color: "var(--dsw-alias-label-primary)",
    };

    function formRow(label, control) {
      return h(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 10, fontSize: 12 } },
        h("span", { style: { minWidth: 84, flex: "0 0 auto", color: "var(--dsw-alias-label-secondary)" } }, label),
        control,
      );
    }

    function smallButton(label, onClick, options = {}) {
      return h(
        "button",
        {
          type: "button",
          disabled: options.disabled === true,
          onClick,
          style: {
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--dsw-alias-border-l2)",
            background: options.primary ? "var(--dsw-alias-bg-layer-2)" : "transparent",
            color: "var(--dsw-alias-label-primary)",
            cursor: options.disabled ? "progress" : "pointer",
          },
        },
        label,
      );
    }

    function RelayCard(props) {
      const { relay, t, onTest, result, editing, draft, onDraft, onEdit, onCancel, onSave, saving, saveError } = props;
      const testing = result?.phase === "running";
      const chips = [
        relay.enabled ? null : chip(t("disabled"), "idle"),
        relay.registered ? chip(t("registered"), "ok") : chip(t("unregistered"), "error"),
        relay.hasKey ? chip(t("keyReady"), "ok") : chip(t("keyMissing"), "warn"),
      ].filter(Boolean);

      // 表单在非编辑态也会被构造，所以不能直接解引用 draft（null 会抛错把整页打白）
      const form = draft ?? {};
      const editForm = h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6, paddingTop: 4 } },
        formRow(
          t("name"),
          h("input", { value: form.name ?? "", onChange: (event) => onDraft({ name: event.target.value }), style: inputStyle }),
        ),
        formRow(
          t("baseURL"),
          h("input", { value: form.baseURL ?? "", onChange: (event) => onDraft({ baseURL: event.target.value }), style: inputStyle }),
        ),
        formRow(
          t("api"),
          h(
            "select",
            { value: form.api ?? "openai-responses", onChange: (event) => onDraft({ api: event.target.value }), style: inputStyle },
            h("option", { value: "openai-responses" }, "openai-responses"),
            h("option", { value: "openai-completions" }, "openai-completions"),
          ),
        ),
        formRow(
          t("userAgent"),
          h("input", { value: form.userAgent ?? "", onChange: (event) => onDraft({ userAgent: event.target.value }), style: inputStyle }),
        ),
        formRow(
          t("keyEnv"),
          h("input", { value: form.apiKeyEnv ?? "", onChange: (event) => onDraft({ apiKeyEnv: event.target.value }), style: inputStyle }),
        ),
        formRow(
          t("modelName"),
          h("input", { value: form.modelName ?? "", onChange: (event) => onDraft({ modelName: event.target.value }), style: inputStyle }),
        ),
        formRow(
          t("modelId"),
          h("input", { value: form.modelId ?? "", onChange: (event) => onDraft({ modelId: event.target.value }), style: inputStyle }),
        ),
        formRow(
          t("contextWindow"),
          h("input", {
            type: "number",
            value: form.contextWindow ?? "",
            onChange: (event) => onDraft({ contextWindow: event.target.value }),
            style: inputStyle,
          }),
        ),
        formRow(
          t("maxTokens"),
          h("input", {
            type: "number",
            value: form.maxTokens ?? "",
            onChange: (event) => onDraft({ maxTokens: event.target.value }),
            style: inputStyle,
          }),
        ),
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-primary)" } },
          h("input", { type: "checkbox", checked: form.enabled !== false, onChange: (event) => onDraft({ enabled: event.target.checked }) }),
          t("enable"),
        ),
        h("p", { style: { margin: 0, fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, t("modelHint")),
        saveError
          ? h("p", { style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } }, `${t("saveFailed")}：${saveError}`)
          : null,
        h(
          "div",
          { style: { display: "flex", gap: 8, paddingTop: 2 } },
          smallButton(saving ? t("saving") : t("save"), onSave, { primary: true, disabled: saving }),
          smallButton(t("cancel"), onCancel, { disabled: saving }),
        ),
      );

      return h(
        "section",
        {
          key: relay.id,
          style: {
            border: "1px solid var(--dsw-alias-border-l1)",
            borderRadius: 10,
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            background: "var(--dsw-alias-bg-layer-1)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h("strong", { style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, relay.name || relay.id),
          h("code", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, relay.id),
          ...chips,
          h("span", { style: { flex: 1 } }),
          smallButton(editing ? t("cancel") : t("edit"), () => (editing ? onCancel() : onEdit(relay)), { disabled: saving }),
          smallButton(testing ? t("testing") : t("test"), () => onTest(relay), { disabled: testing || editing }),
        ),
        editing
          ? editForm
          : [
              field(t("baseURL"), relay.baseURL),
              field(t("api"), relay.api),
              field(t("models"), relay.models.map((model) => model.id).join("，") || "—"),
              field(t("userAgent"), relay.userAgent),
            ],
        result && result.phase !== "running"
          ? h(
              "div",
              {
                style: {
                  borderTop: "1px solid var(--dsw-alias-border-l1)",
                  paddingTop: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                },
              },
              h(
                "div",
                { style: { display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12 } },
                chip(result.ok ? `HTTP ${result.status}` : result.status ? `HTTP ${result.status}` : t("failed"), result.ok ? "ok" : "error"),
                h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, `${t("latency")} ${result.latencyMs} ms`),
                result.model ? h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, result.model) : null,
              ),
              result.hint
                ? h(
                    "p",
                    { style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-warn-primary)" } },
                    result.hint,
                  )
                : null,
              h(
                "pre",
                {
                  style: {
                    margin: 0,
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: "var(--dsw-alias-bg-layer-2)",
                    color: "var(--dsw-alias-label-primary)",
                    fontSize: 12,
                    lineHeight: "18px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 220,
                    overflow: "auto",
                  },
                },
                result.detail || t("unknownError"),
              ),
            )
          : null,
      );
    }

    function Page(props) {
      // inject 面正常会给 t；万一宿主没走 inject 面，也不能让整页抛错把设置面板带下去
      const t = typeof props?.t === "function" ? props.t : (key) => key;
      const [snapshot, setSnapshot] = react.useState({ phase: "loading", relays: [], error: "" });
      const [results, setResults] = react.useState({});
      // 编辑态：draft = { id, name, baseURL, api, userAgent, apiKeyEnv, enabled, modelId, contextWindow, maxTokens }
      const [draft, setDraft] = react.useState(null);
      const [saving, setSaving] = react.useState(false);
      const [saveError, setSaveError] = react.useState("");
      const [saveOk, setSaveOk] = react.useState("");

      const load = react.useCallback(async () => {
        setSnapshot((current) => ({ ...current, phase: current.relays.length ? "ready" : "loading", error: "" }));
        try {
          const response = await fetch(`${ENDPOINT}/state`, { headers: HEADERS });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          setSnapshot({ phase: "ready", relays: Array.isArray(payload?.relays) ? payload.relays : [], error: "" });
        } catch (error) {
          setSnapshot({ phase: "error", relays: [], error: String(error?.message ?? error) });
        }
      }, []);

      react.useEffect(() => {
        void load();
      }, [load]);

      const onTest = react.useCallback(async (relay) => {
        setResults((current) => ({ ...current, [relay.id]: { phase: "running", ok: false, status: 0, latencyMs: 0, detail: "" } }));
        try {
          const response = await fetch(`${ENDPOINT}/test?id=${encodeURIComponent(relay.id)}`, { headers: HEADERS });
          const payload = await response.json().catch(() => ({}));
          setResults((current) => ({
            ...current,
            [relay.id]: {
              phase: "settled",
              ok: payload?.ok === true,
              status: Number(payload?.status ?? response.status ?? 0),
              latencyMs: Number(payload?.latencyMs ?? 0),
              detail: String(payload?.detail ?? (response.ok ? "" : `HTTP ${response.status}`)),
              model: payload?.model ?? "",
              hint: payload?.hint ?? "",
            },
          }));
        } catch (error) {
          setResults((current) => ({
            ...current,
            [relay.id]: { phase: "settled", ok: false, status: 0, latencyMs: 0, detail: String(error?.message ?? error) },
          }));
        }
      }, []);

      const startEdit = react.useCallback((relay) => {
        setSaveOk("");
        setSaveError("");
        setDraft({
          id: relay.id,
          name: relay.name,
          enabled: relay.enabled !== false,
          baseURL: relay.baseURL,
          api: relay.api,
          userAgent: relay.userAgent,
          apiKeyEnv: relay.apiKeyEnv,
          modelName: relay.models[0]?.name ?? "",
          modelId: relay.models[0]?.id ?? "",
          contextWindow: relay.models[0]?.contextWindow ?? 400000,
          maxTokens: relay.models[0]?.maxTokens ?? 128000,
        });
      }, []);

      const cancelEdit = react.useCallback(() => {
        setDraft(null);
        setSaveError("");
      }, []);

      const updateDraft = react.useCallback((patch) => {
        setDraft((current) => (current ? { ...current, ...patch } : current));
      }, []);

      // 等宿主把提交的值真正装配出来，避免「已保存」却还是旧值
      const waitForApplied = react.useCallback(async (expected) => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            const payload = await fetch(`${ENDPOINT}/state`, { headers: HEADERS }).then((response) => response.json());
            const actual = Array.isArray(payload?.relays) ? payload.relays : [];
            const same =
              actual.length === expected.length &&
              expected.every(
                (want, index) =>
                  String(actual[index]?.id ?? "") === want.id &&
                  String(actual[index]?.name ?? "") === String(want.name ?? "") &&
                  String(actual[index]?.models?.[0]?.id ?? "") === String(want.models?.[0]?.id ?? "") &&
                  String(actual[index]?.models?.[0]?.name ?? "") === String(want.models?.[0]?.name ?? ""),
              );
            if (same) return true;
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return false;
      }, []);

      // 两个入口各有一份快照：重新聚焦或每隔一会儿取一次，减少陈旧覆盖
      react.useEffect(() => {
        if (typeof window === "undefined") return;
        const onFocus = () => void load();
        const timer = setInterval(() => void load(), 10000);
        window.addEventListener("focus", onFocus);
        return () => {
          window.removeEventListener("focus", onFocus);
          clearInterval(timer);
        };
      }, [load]);

      const saveDraft = react.useCallback(async () => {
        if (!draft) return;
        setSaving(true);
        setSaveError("");
        setSaveOk("");
        // 两个入口（主列 / 设置页）各有一份快照；保存前先取一次最新 state，
        // 把本次编辑合并上去，避免用陈旧数据把刚生效的值覆盖回去。
        let fresh = snapshot.relays;
        try {
          const latest = await fetch(`${ENDPOINT}/state`, { headers: HEADERS }).then((response) => response.json());
          if (Array.isArray(latest?.relays) && latest.relays.length) fresh = latest.relays;
        } catch {}

        const nextModels = (relay) => [
          {
            ...(relay.models[0] ?? {}),
            id: String(draft.modelId ?? "").trim(),
            name: String(draft.modelName ?? "").trim() || String(draft.modelId ?? "").trim(),
            contextWindow: Number(draft.contextWindow) || 400000,
            maxTokens: Number(draft.maxTokens) || 128000,
          },
          ...relay.models.slice(1),
        ];
        const relays = fresh.map((relay) => ({
          id: relay.id,
          name: relay.id === draft.id ? draft.name : relay.name,
          enabled: relay.id === draft.id ? draft.enabled : relay.enabled !== false,
          baseURL: relay.id === draft.id ? draft.baseURL : relay.baseURL,
          api: relay.id === draft.id ? draft.api : relay.api,
          userAgent: relay.id === draft.id ? draft.userAgent : relay.userAgent,
          apiKeyEnv: relay.id === draft.id ? draft.apiKeyEnv : relay.apiKeyEnv,
          models: relay.id === draft.id ? nextModels(relay) : relay.models,
        }));
        try {
          const response = await fetch(`${ENDPOINT}/update`, {
            method: "POST",
            headers: { ...HEADERS, "content-type": "application/json" },
            body: JSON.stringify({ relays }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`);
          setDraft(null);
          setSaveOk(t("saveOk"));
          const applied = await waitForApplied(relays);
          await load();
          setSaveOk(
            applied
              ? t("saveApplied")
              : `${t("savePending")}${payload?.note ? `（${payload.note}）` : ""}`,
          );
        } catch (error) {
          setSaveError(String(error?.message ?? error));
        } finally {
          setSaving(false);
        }
      }, [draft, snapshot.relays, load, t, waitForApplied]);

      // 设置页分区由外壳提供容器；主列面板要自己撑满并滚动
      const variant = props?.variant === "page" ? "page" : "settings";
      const content = h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" } },
          h("h2", { style: { margin: 0, fontSize: 16, color: "var(--dsw-alias-label-primary)" } }, t("title")),
          chip(t("editable"), "idle"),
          h("span", { style: { flex: 1 } }),
          h(
            "button",
            {
              type: "button",
              onClick: () => void load(),
              style: {
                fontSize: 12,
                padding: "3px 10px",
                borderRadius: 6,
                border: "1px solid var(--dsw-alias-border-l2)",
                background: "transparent",
                color: "var(--dsw-alias-label-primary)",
                cursor: "pointer",
              },
            },
            t("refresh"),
          ),
        ),
        h("p", { style: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } }, t("intro")),
        saveOk ? h("p", { style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-success-primary)" } }, saveOk) : null,
        snapshot.phase === "loading" ? h("p", { style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, t("loading")) : null,
        snapshot.phase === "error"
          ? h(
              "p",
              { style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } },
              `${t("failed")}：${snapshot.error}`,
            )
          : null,
        snapshot.phase === "ready" && snapshot.relays.length === 0
          ? h("p", { style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, t("empty"))
          : null,
        ...snapshot.relays.map((relay) =>
          h(RelayCard, {
            key: relay.id,
            relay,
            t,
            onTest,
            result: results[relay.id],
            editing: draft?.id === relay.id,
            draft: draft?.id === relay.id ? draft : null,
            onDraft: updateDraft,
            onEdit: startEdit,
            onCancel: cancelEdit,
            onSave: saveDraft,
            saving,
            saveError: draft?.id === relay.id ? saveError : "",
          }),
        ),
      );

      if (variant !== "page") return content;
      return h(
        "div",
        {
          style: {
            height: "100%",
            overflow: "auto",
            boxSizing: "border-box",
            padding: "24px 28px 32px",
            background: "var(--dsw-alias-bg-base)",
          },
        },
        content,
      );
    }

    /**
     * 侧栏面板图标：两枚箭头互换，代表「中转」。
     * ownerProps 只有 size/active，颜色跟随当前文字色（currentColor），激活态加重。
     */
    function RelayIcon(props) {
      const size = Number(props?.size) > 0 ? Number(props.size) : 18;
      const active = props?.active === true;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M4 8h11" }),
        h("path", { d: "M12 5l3 3-3 3" }),
        h("path", { d: "M20 16H9" }),
        h("path", { d: "M12 13l-3 3 3 3" }),
      );
    }

    /** 需要的客户端服务。 */
    const inject = ["slots", "locale"];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-llm-relay: 文案");

      // 1) 设置页里的一整页（原入口，保留）
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "llm-relay",
                order: 40,
                label: () => t("nav"),
                locale: NS,
                inject: () => ({ t }),
              },
              Page,
            ),
          ),
        "dsh-llm-relay: 设置页分区",
      );

      // 2) 主列面板：侧栏图标点开后，在这个 key 上渲染同一张面板
      ctx.effect(
        () =>
          ctx.slots.inject("main", () =>
            ctx.slots.register(
              {
                name: "main",
                key: "llm-relay",
                inject: () => ({ t, variant: "page" }),
              },
              Page,
            ),
          ),
        "dsh-llm-relay: 主列面板",
      );

      // 3) 主窗口快捷入口：侧栏全局面板图标（id 必须与上面的 main key 一致）
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.panellist", () =>
            ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: "llm-relay",
                order: 30,
                label: () => t("nav"),
                locale: NS,
              },
              RelayIcon,
            ),
          ),
        "dsh-llm-relay: 侧栏图标",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.NS = NS;
    // 测试用的渲染口（避免只测注册、不测组件真的能渲染）
    exports.__test = { RelayCard, RelayIcon, Page };
    return module.exports;
  },
});