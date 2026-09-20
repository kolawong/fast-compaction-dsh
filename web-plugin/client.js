/**
 * dsh-plugin-fast-compaction — Client half (Web settings card).
 *
 * One configuration card for the `fast-compaction` settings namespace,
 * registered into the Plugins page slots a bundle configuration belongs to
 * (`plugins.bundle.config` + `plugins.row.config`, plus the legacy
 * `settings.plugin.item` for pre-0.1.6 settings dialogs). Reads ride the
 * shared settings mirror through the bound settings scope; writes go through
 * the scope's `mutate`, which is the sanctioned wrapper over
 * `ctx.remote.settings.mutate(ns, ops, expectedRevision)` — the scope fences
 * every write with the latest known namespace revision and auto-reloads the
 * mirror when the Host refuses (settings/conflict), so a "not landed" save is
 * detected by re-reading the accepted view after the write settles.
 *
 * The apiKey field is a `role('secret')` slot: it never arrives over the
 * wire. The card shows 已设置/未设置 from the describe view's `secrets` flag,
 * an empty input means "leave unchanged", and the clear button sends an
 * `unset` op.
 *
 * No build step: plain JS + the host's React via window.__ModuleLoader__.
 *
 * @license MIT
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-fast-compaction",
  factory: (require) => {
    const exports = {};
    const React = require("react");
    const { useState } = React;
    const { jsx, jsxs } = require("react/jsx-runtime");

    /** Settings namespace owned by the server half. */
    const SETTINGS_NS = "fast-compaction";
    /** Locale dictionary namespace (slot `locale` option binds `t` to it). */
    const NS = "settings.plugin.fast-compaction";
    /** This bundle's package name: the `plugins.bundle.config` key. */
    const PKG = "dsh-plugin-fast-compaction";
    /** This bundle's row id in cordis.patch.yml: the `plugins.row.config` key. */
    const ROW = "fast-compaction";

    /** Code defaults, mirrored from index.js for the per-field hint lines. */
    const DEFAULTS = {
      disabled: false,
      model: "jev-latest",
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25000,
      maxRequestTokens: 30000,
      truncateHeadChars: 300,
      minReduction: 0.25,
    };

    /**
     * Editable numeric fields and their input constraints, mirroring the
     * server schema (`natural()` = integer >= 0; min 1 where the schema says
     * so; ratios clamped to [0, 1]).
     */
    const NUMBER_FIELDS = {
      keepThreshold: { min: 0, max: 1, step: "0.05", integer: false },
      preserveRecentMessages: { min: 0, step: "1", integer: true },
      maxStateTokens: { min: 1, step: "1000", integer: true },
      maxRequestTokens: { min: 1, step: "1000", integer: true },
      truncateHeadChars: { min: 0, step: "50", integer: true },
      minReduction: { min: 0, max: 1, step: "0.05", integer: false },
    };
    const TEXT_FIELDS = ["model", "baseUrl"];
    const SECRET_FIELD = "apiKey";
    /** Field order the form renders. */
    const FIELDS = ["disabled", SECRET_FIELD, ...TEXT_FIELDS, ...Object.keys(NUMBER_FIELDS)];

    const dicts = {
      zh: {
        title: "快速压缩 (fast-compaction)",
        summary: "上下文压缩的裁决引擎：保留阈值、token 预算、保留条数与裁决模型参数。",
        liveNote: "改动即时生效于后续压缩（引擎热读 settings.yaml），无需重启。",
        loading: "正在读取设置…",
        unavailable: "此部署未提供 fast-compaction 设置命名空间。",
        readOnly: "当前设置为只读（设置文档不可写）。",
        disabled: "停用智能裁决",
        disabledHint: "默认：启用裁决。勾选后压缩仍会发生，但改走 DSH 内置的有损摘要。",
        apiKey: "API Key",
        apiKeySet: "已设置",
        apiKeyUnset: "未设置",
        apiKeyPlaceholder: "留空表示不修改",
        apiKeyHint: "默认：读取环境变量 TYPESAFE_API_KEY。密钥不会回传到浏览器。",
        apiKeyClear: "清除",
        model: "裁决模型",
        modelHint: "默认：jev-latest — 逐条裁决 keep/truncate/drop 的模型。",
        baseUrl: "裁决接口地址 (baseUrl)",
        baseUrlHint: "默认：https://api.typesafe.ai/v1/systemone — TypeSafe System One 端点。",
        keepThreshold: "保留概率阈值 (keepThreshold)",
        keepThresholdHint: "默认：0.5 — 工具调用/结果的保留概率低于该值时被删除或截断。",
        preserveRecentMessages: "保留最近消息数",
        preserveRecentMessagesHint: "默认：6 — 尾部始终原样保留的消息条数。",
        maxStateTokens: "状态令牌上限 (maxStateTokens)",
        maxStateTokensHint: "默认：25000 — 发送给裁决模型的历史状态估算 token 上限。",
        maxRequestTokens: "请求令牌上限 (maxRequestTokens)",
        maxRequestTokensHint: "默认：30000 — 单次裁决请求（状态 + 一批问题）的估算 token 上限。",
        truncateHeadChars: "截断头部长度 (truncateHeadChars)",
        truncateHeadCharsHint: "默认：300 — 被删除的工具结果在截断标记前保留的头部字符数。",
        minReduction: "最小缩减率 (minReduction)",
        minReductionHint: "默认：0.25 — 裁决结果缩减率低于该值时回退内置摘要。",
        overridden: "已覆盖",
        invalidNumber: "无效数值",
        save: "保存",
        saving: "保存中…",
        discard: "放弃修改",
        resetAll: "重置为默认",
        saved: "已保存 ✓",
        conflict: "设置已被其他来源修改，已重新拉取最新值；请核对后重试。",
        rejected: "写入被拒绝：",
      },
      en: {
        title: "Fast Compaction",
        summary: "The verdict engine for context compaction: keep thresholds, token budgets, retention, and verdict-model parameters.",
        liveNote: "Changes apply to subsequent compactions immediately (the engine hot-reads settings.yaml) — no restart needed.",
        loading: "Loading settings…",
        unavailable: "This deployment does not serve the fast-compaction settings namespace.",
        readOnly: "Settings are read-only in this deployment (the settings document is not writable).",
        disabled: "Disable verdict adjudication",
        disabledHint: "Default: verdicts on. When checked, compaction still happens but uses DSH's built-in lossy summarizer.",
        apiKey: "API Key",
        apiKeySet: "Set",
        apiKeyUnset: "Not set",
        apiKeyPlaceholder: "Leave empty to keep unchanged",
        apiKeyHint: "Default: read from the TYPESAFE_API_KEY environment variable. The secret never reaches the browser.",
        apiKeyClear: "Clear",
        model: "Verdict model",
        modelHint: "Default: jev-latest — the model adjudicating keep/truncate/drop per call.",
        baseUrl: "Verdict endpoint (baseUrl)",
        baseUrlHint: "Default: https://api.typesafe.ai/v1/systemone — the TypeSafe System One endpoint.",
        keepThreshold: "Keep-probability threshold (keepThreshold)",
        keepThresholdHint: "Default: 0.5 — a tool call or result below this keep probability is dropped or truncated.",
        preserveRecentMessages: "Preserve recent messages",
        preserveRecentMessagesHint: "Default: 6 — tail messages always kept verbatim.",
        maxStateTokens: "Max state tokens",
        maxStateTokensHint: "Default: 25000 — estimated token ceiling of the history state sent to the verdict model.",
        maxRequestTokens: "Max request tokens",
        maxRequestTokensHint: "Default: 30000 — estimated token ceiling of one verdict request (state plus one batch of questions).",
        truncateHeadChars: "Truncate head chars",
        truncateHeadCharsHint: "Default: 300 — head characters retained from a dropped tool result before its truncation note.",
        minReduction: "Minimum reduction (minReduction)",
        minReductionHint: "Default: 0.25 — below this reduction ratio the verdict pass falls back to the built-in summary.",
        overridden: "Overridden",
        invalidNumber: "Invalid number",
        save: "Save",
        saving: "Saving…",
        discard: "Discard changes",
        resetAll: "Reset to defaults",
        saved: "Saved ✓",
        conflict: "Settings were changed elsewhere; the latest values have been reloaded. Please review and retry.",
        rejected: "Write rejected: ",
      },
    };

    /** Inline style kit; colors fall back beside the host's dsw alias vars. */
    const S = {
      card: { display: "flex", flexDirection: "column", gap: "12px", padding: "4px 0" },
      note: {
        padding: "8px 12px", borderRadius: "8px", fontSize: "12px", lineHeight: 1.5,
        color: "var(--dsw-alias-state-info-primary, #2563eb)",
        background: "var(--dsw-alias-state-info-secondary, rgba(37, 99, 235, 0.08))",
        border: "1px solid var(--dsw-alias-state-info-primary, rgba(37, 99, 235, 0.35))",
      },
      error: {
        padding: "8px 12px", borderRadius: "8px", fontSize: "12px", lineHeight: 1.5,
        color: "var(--dsw-alias-state-error-primary, #dc2626)",
        background: "var(--dsw-alias-state-error-secondary, rgba(220, 38, 38, 0.08))",
        border: "1px solid var(--dsw-alias-state-error-primary, rgba(220, 38, 38, 0.35))",
      },
      row: { display: "flex", flexDirection: "column", gap: "4px" },
      rowHead: { display: "flex", alignItems: "center", gap: "8px" },
      label: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #e5e7eb)" },
      hint: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #9ca3af)", lineHeight: 1.5 },
      input: {
        width: "100%", boxSizing: "border-box", padding: "6px 10px", fontSize: "13px",
        borderRadius: "6px", border: "1px solid var(--dsw-alias-outline-primary, #4b5563)",
        background: "var(--dsw-alias-background-primary, transparent)",
        color: "var(--dsw-alias-label-primary, #e5e7eb)",
      },
      inputInvalid: { border: "1px solid var(--dsw-alias-state-error-primary, #dc2626)" },
      badge: {
        fontSize: "11px", padding: "1px 8px", borderRadius: "999px",
        border: "1px solid var(--dsw-alias-outline-primary, #4b5563)",
        color: "var(--dsw-alias-label-tertiary, #9ca3af)",
      },
      badgeSet: {
        color: "var(--dsw-alias-state-success-primary, #16a34a)",
        border: "1px solid var(--dsw-alias-state-success-primary, rgba(22, 163, 74, 0.5))",
      },
      badgeOverridden: {
        color: "var(--dsw-alias-state-info-primary, #2563eb)",
        border: "1px solid var(--dsw-alias-state-info-primary, rgba(37, 99, 235, 0.5))",
      },
      badgeError: {
        color: "var(--dsw-alias-state-error-primary, #dc2626)",
        border: "1px solid var(--dsw-alias-state-error-primary, rgba(220, 38, 38, 0.5))",
      },
      actions: { display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" },
      button: {
        padding: "6px 14px", fontSize: "13px", borderRadius: "6px", cursor: "pointer",
        border: "1px solid var(--dsw-alias-outline-primary, #4b5563)",
        background: "var(--dsw-alias-background-primary, transparent)",
        color: "var(--dsw-alias-label-primary, #e5e7eb)",
      },
      buttonPrimary: {
        background: "var(--dsw-alias-state-info-primary, #2563eb)",
        border: "1px solid var(--dsw-alias-state-info-primary, #2563eb)",
        color: "#ffffff",
      },
      buttonDisabled: { opacity: 0.45, cursor: "not-allowed" },
      saved: { fontSize: "12px", color: "var(--dsw-alias-state-success-primary, #16a34a)" },
      checkRow: { display: "flex", alignItems: "center", gap: "8px" },
      secretRow: { display: "flex", gap: "8px" },
    };

    /** Format the effective section value of one field as input text. */
    function formatValue(field, value) {
      const raw = value?.[field];
      if (raw === undefined || raw === null) return "";
      return String(raw);
    }

    /**
     * Validate one staged draft; the accepted JSON value or undefined when the
     * text is not a value this field accepts (which blocks the save).
     */
    function parseField(field, text) {
      const trimmed = text.trim();
      if (field in NUMBER_FIELDS) {
        const rule = NUMBER_FIELDS[field];
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) return undefined;
        if (rule.integer && !Number.isInteger(parsed)) return undefined;
        if (rule.min !== undefined && parsed < rule.min) return undefined;
        if (rule.max !== undefined && parsed > rule.max) return undefined;
        return parsed;
      }
      return trimmed;
    }

    /** The redacted `secrets` flag of the apiKey slot from the describe view. */
    function secretSet(mirrorSnap) {
      const view = mirrorSnap?.view?.namespaces?.find((candidate) => candidate.ns === SETTINGS_NS);
      const secret = view?.secrets?.find((candidate) => candidate.path.join(".") === SECRET_FIELD);
      return secret?.set === true;
    }

    /**
     * The settings card component. `view === "summary"` renders the one-liner
     * the Plugins page places under the title; anything else (page, or the
     * legacy dialog that passes no view) renders the full form.
     */
    function FastCompactionCard(props) {
      const { t, view, fcMutate } = props;
      // The slot framework binds inject.hooks entries as use<Name> selector hooks.
      const snap = props.useFastCompaction((state) => state);
      const mirror = props.useFastCompactionDescribe((state) => state);

      /**
       * Staged edits: field -> { text: string } | { clear: true } | { bool: boolean }.
       * A field absent from the map renders its live effective value.
       */
      const [staged, setStaged] = useState({});
      const [saving, setSaving] = useState(false);
      const [savedTick, setSavedTick] = useState(false);
      /** null | "conflict" | { message: string } */
      const [failure, setFailure] = useState(null);

      if (view === "summary") return t("summary");

      if (!snap || snap.status === "loading") {
        return jsx("div", { style: S.hint, children: t("loading") });
      }
      if (snap.status !== "ready") {
        return jsx("div", { style: S.hint, children: t("unavailable") });
      }

      const value = snap.value ?? {};
      const user = (snap.user && typeof snap.user === "object") ? snap.user : {};
      const writable = snap.writable === true;
      const isSet = secretSet(mirror);

      /** Whether the user layer carries this field (the "overridden" mark). */
      const overridden = (field) => Object.hasOwn(user, field);

      /** Draft text one control renders. */
      const draftText = (field) => {
        const edit = staged[field];
        if (edit === undefined) return formatValue(field, value);
        if (edit.clear === true) return formatValue(field, DEFAULTS);
        if (edit.bool !== undefined) return "";
        return edit.text;
      };

      /** Draft invalidity (blocks the save). */
      const draftInvalid = (field) => {
        const edit = staged[field];
        if (edit === undefined || edit.clear === true || edit.bool !== undefined) return false;
        if (edit.text.trim() === "") return false; // empty = unset, always valid
        return parseField(field, edit.text) === undefined;
      };

      /**
       * Translate the staged map into mutate ops. Text fields treat an empty
       * draft as unset (re-inherit the default); identical re-typed values are
       * skipped. Returns null when any staged draft is invalid.
       */
      function buildOps() {
        const ops = [];
        for (const field of FIELDS) {
          const edit = staged[field];
          if (edit === undefined) continue;
          if (edit.clear === true) {
            ops.push({ op: "unset", path: [field] });
            continue;
          }
          if (edit.bool !== undefined) {
            if (edit.bool !== (value.disabled === true) || overridden("disabled")) {
              ops.push({ op: "set", path: ["disabled"], value: edit.bool });
            }
            continue;
          }
          const text = edit.text.trim();
          if (field === SECRET_FIELD) {
            // A blank secret draft writes nothing: the stored key stays.
            if (text !== "") ops.push({ op: "set", path: [SECRET_FIELD], value: text });
            continue;
          }
          if (text === "") {
            if (overridden(field)) ops.push({ op: "unset", path: [field] });
            continue;
          }
          const parsed = parseField(field, text);
          if (parsed === undefined) return null;
          if (String(parsed) === formatValue(field, value) && !overridden(field)) continue;
          ops.push({ op: "set", path: [field], value: parsed });
        }
        return ops;
      }

      const ops = buildOps();
      const invalid = ops === null;
      const dirty = invalid || (ops !== null && ops.length > 0);

      function stage(field, edit) {
        setStaged((previous) => ({ ...previous, [field]: edit }));
        setFailure(null);
        setSavedTick(false);
      }

      /**
       * Whether the Host accepted the ops: read back from the post-write
       * snapshot/view. The scope already fences with expectedRevision and, on
       * settings/conflict, reloads the mirror before its promise settles — so
       * a mismatch here means "someone else wrote" or "the Host refused".
       */
      function landed(appliedOps) {
        const after = props.fcSnapshot() ?? {};
        const afterValue = after.value ?? {};
        const afterUser = (after.user && typeof after.user === "object") ? after.user : {};
        const afterMirror = props.fcDescribeSnapshot();
        return appliedOps.every((op) => {
          const field = op.path[0];
          if (field === SECRET_FIELD) {
            // The literal never rides back; trust the set flag for a set, and
            // an unset when an env-sourced base key remains legitimately set.
            return op.op === "set" ? secretSet(afterMirror) === true : true;
          }
          if (op.op === "unset") return !Object.hasOwn(afterUser, field);
          return afterValue[field] === op.value;
        });
      }

      async function runWrite(appliedOps, options) {
        if (appliedOps.length === 0 || saving || !writable) return;
        setSaving(true);
        setFailure(null);
        setSavedTick(false);
        try {
          await fcMutate(appliedOps);
          if (landed(appliedOps)) {
            // A full save/reset clears the stage; a standalone secret clear
            // leaves the user's other staged edits alone.
            if (options?.clearStaged !== false) setStaged({});
            setSavedTick(true);
          } else {
            // Conflict or refusal: the scope has already re-pulled Host state;
            // drop the stale drafts so the form shows the accepted values.
            setStaged({});
            setFailure("conflict");
          }
        } catch (error) {
          setFailure({ message: String(error) });
        } finally {
          setSaving(false);
        }
      }

      const inputDisabled = saving || !writable;

      /** One labelled row: label + optional badges, control, hint line. */
      function fieldRow(field, control, hintKey) {
        return jsxs("div", {
          style: S.row,
          children: [
            jsxs("div", {
              style: S.rowHead,
              children: [
                jsx("span", { style: S.label, children: t(field) }),
                overridden(field)
                  ? jsx("span", { style: { ...S.badge, ...S.badgeOverridden }, children: t("overridden") })
                  : null,
                draftInvalid(field)
                  ? jsx("span", { style: { ...S.badge, ...S.badgeError }, children: t("invalidNumber") })
                  : null,
              ],
            }),
            control,
            jsx("span", { style: S.hint, children: t(hintKey) }),
          ],
        }, field);
      }

      function textInput(field) {
        const rule = NUMBER_FIELDS[field];
        return jsx("input", {
          style: draftInvalid(field) ? { ...S.input, ...S.inputInvalid } : S.input,
          type: rule !== undefined ? "number" : "text",
          ...(rule !== undefined
            ? { min: rule.min, ...(rule.max !== undefined ? { max: rule.max } : {}), step: rule.step }
            : {}),
          value: draftText(field),
          disabled: inputDisabled,
          onChange: (event) => { stage(field, { text: event.target.value }); },
        });
      }

      const children = [
        // Prominent live-apply note.
        jsx("div", { style: S.note, children: t("liveNote") }, "note"),

        // disabled toggle.
        jsxs("div", {
          style: S.row,
          children: [
            jsxs("label", {
              style: S.checkRow,
              children: [
                jsx("input", {
                  type: "checkbox",
                  checked: staged.disabled?.bool ?? value.disabled === true,
                  disabled: inputDisabled,
                  onChange: (event) => { stage("disabled", { bool: event.target.checked }); },
                }),
                jsx("span", { style: S.label, children: t("disabled") }),
              ],
            }),
            jsx("span", { style: S.hint, children: t("disabledHint") }),
          ],
        }, "disabled"),

        // apiKey: write-only secret. Set flag from the describe view; a blank
        // draft keeps the stored key; the clear button stages an unset.
        fieldRow(SECRET_FIELD, jsxs("div", {
          style: S.secretRow,
          children: [
            jsx("input", {
              style: { ...S.input, flex: 1 },
              type: "password",
              placeholder: t("apiKeyPlaceholder"),
              value: staged[SECRET_FIELD]?.text ?? "",
              disabled: inputDisabled,
              onChange: (event) => { stage(SECRET_FIELD, { text: event.target.value }); },
            }),
            jsx("span", {
              style: isSet ? { ...S.badge, ...S.badgeSet, alignSelf: "center" } : { ...S.badge, alignSelf: "center" },
              children: isSet ? t("apiKeySet") : t("apiKeyUnset"),
            }),
            jsx("button", {
              style: inputDisabled || !isSet ? { ...S.button, ...S.buttonDisabled } : S.button,
              disabled: inputDisabled || !isSet,
              onClick: () => { void runWrite([{ op: "unset", path: [SECRET_FIELD] }], { clearStaged: false }); },
              children: t("apiKeyClear"),
            }),
          ],
        }), "apiKeyHint"),

        ...TEXT_FIELDS.map((field) => fieldRow(field, textInput(field), `${field}Hint`)),
        ...Object.keys(NUMBER_FIELDS).map((field) => fieldRow(field, textInput(field), `${field}Hint`)),
      ];

      if (!writable) {
        children.push(jsx("div", { style: S.hint, children: t("readOnly") }, "readonly"));
      }
      if (failure === "conflict") {
        children.push(jsx("div", { style: S.error, children: t("conflict") }, "failure"));
      } else if (failure !== null) {
        children.push(jsx("div", { style: S.error, children: t("rejected") + failure.message }, "failure"));
      }

      children.push(jsxs("div", {
        style: S.actions,
        children: [
          jsx("button", {
            style: inputDisabled || !dirty || invalid
              ? { ...S.button, ...S.buttonPrimary, ...S.buttonDisabled }
              : { ...S.button, ...S.buttonPrimary },
            disabled: inputDisabled || !dirty || invalid,
            onClick: () => { if (ops !== null) void runWrite(ops); },
            children: saving ? t("saving") : t("save"),
          }),
          jsx("button", {
            style: inputDisabled || !dirty ? { ...S.button, ...S.buttonDisabled } : S.button,
            disabled: inputDisabled || !dirty,
            onClick: () => { setStaged({}); setFailure(null); },
            children: t("discard"),
          }),
          jsx("button", {
            style: inputDisabled ? { ...S.button, ...S.buttonDisabled } : S.button,
            disabled: inputDisabled,
            onClick: () => {
              // Wholesale reset: unset every field, so each re-inherits the
              // composition base / schema default (replace({}) equivalent).
              void runWrite(FIELDS.map((field) => ({ op: "unset", path: [field] })));
            },
            children: t("resetAll"),
          }),
          savedTick ? jsx("span", { style: S.saved, children: t("saved") }) : null,
        ],
      }, "actions"));

      return jsx("div", { style: S.card, children });
    }

    /**
     * Register one slot entry, tolerating a duplicate: the slots store throws
     * when the same key + priority registers twice, and an unguarded throw
     * here would abort the remaining registrations.
     */
    function safeSlotRegister(ctx, options, component) {
      try {
        return ctx.slots.register(options, component);
      } catch (error) {
        console.warn(`[fast-compaction] slot "${options.name}" registration skipped:`, error);
        return undefined;
      }
    }

    exports.inject = ["locale", "slots", "settingsScope"];
    exports.apply = function apply(ctx) {
      ctx.locale.register(NS, { zh: dicts.zh, en: dicts.en });

      let scope;
      let describeFace;
      try {
        scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
        describeFace = ctx.settingsScope.describe();
      } catch (error) {
        scope = undefined;
        describeFace = undefined;
      }
      if (scope === undefined || describeFace === undefined) {
        console.warn("[fast-compaction] settings scope unavailable; settings card skipped.");
        return;
      }

      // The slot-entry face: settings state as hook sources (the framework
      // binds them into useFastCompaction / useFastCompactionDescribe), plus
      // the write path and the post-write read-back handles `landed` uses.
      const injectCard = () => ({
        hooks: { fastCompaction: scope, fastCompactionDescribe: describeFace },
        fcMutate: (ops) => scope.mutate(ops),
        fcSnapshot: () => scope.getSnapshot(),
        fcDescribeSnapshot: () => describeFace.getSnapshot(),
      });

      // DSH 0.1.6+ Plugins page: bundle-level configuration, keyed by the
      // bundle's package name.
      ctx.slots.inject("plugins.bundle.config", function* () {
        const registration = safeSlotRegister(ctx, {
          name: "plugins.bundle.config",
          key: PKG,
          locale: NS,
          inject: injectCard,
        }, FastCompactionCard);
        if (registration !== undefined) yield registration;
      });

      // DSH 0.1.6+ Plugins page: row-level configuration, keyed by
      // `<package>#<row id>` as the bundle patch declares the row.
      ctx.slots.inject("plugins.row.config", function* () {
        const registration = safeSlotRegister(ctx, {
          name: "plugins.row.config",
          key: `${PKG}#${ROW}`,
          locale: NS,
          inject: injectCard,
        }, FastCompactionCard);
        if (registration !== undefined) yield registration;
      });

      // Legacy DSH (< 0.1.6) Settings dialog slot.
      ctx.slots.inject("settings.plugin.item", function* () {
        const registration = safeSlotRegister(ctx, {
          name: "settings.plugin.item",
          key: SETTINGS_NS,
          id: SETTINGS_NS,
          order: 40,
          locale: NS,
          inject: injectCard,
        }, FastCompactionCard);
        if (registration !== undefined) yield registration;
      });
    };

    return exports;
  },
});
