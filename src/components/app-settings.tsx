import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";

import { SettingsFieldRow, SettingsGroup } from "@/components/settings-primitives";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ScopeMark, scopeLabel } from "@/components/scope-chip";
import * as api from "@/lib/api";
import { isLocale, setLocale, useLocale, useT } from "@/lib/i18n";
import { SCOPES, scopeOf, scopeParts, type Scope } from "@/lib/scope";
import { planScopeShortcuts, SCOPE_SHORTCUT_LIMIT } from "@/lib/scope-shortcuts";
import { useVisibleScopes } from "@/lib/scope-visibility";
import { useShortcutsEnabled } from "@/lib/shortcut-preference";
import {
  getThemePreference,
  isThemePreference,
  setThemePreference,
  THEME_LABEL_KEYS,
  THEME_PREFERENCES,
  type ThemePreference,
} from "@/lib/theme";
import { platformOfPath } from "@/lib/platforms/registry";
import { useScope } from "@/lib/use-scope";

/**
 * **应用级设置**的唯一实现：语言 / 外观（主题）/ 开机自启 / 自动更新。
 *
 * ## 为什么这四块可以跨产品共用
 *
 * 它们改的是**本应用**的状态 —— 界面语言、主题偏好、系统登录项、GitHub 更新源，
 * 读的也是**本应用**的版本号（`update::APP_VERSION`），与 WorkBuddy / Trae 两条
 * 产品线无关。`docs/specs` 早已把它们定性为「应用级能力 / 全局共用项，不计为
 * Trae 差距」（`trae-parity-matrix.md:103,231,236`、`trae-parity-design.md:225`）。
 *
 * 与 `settings-primitives.tsx` 的分工：那里共享**纯版式原语**（无取数、无判断），
 * 这里共享**应用级业务块**（含取数）。**产品耦合的块不得搬进来** —— 依赖 `Region`
 * 的（版本与账号库 / 权限检测 / 网关）留在 `SettingsPage`，依赖 `TraeVariant` 的
 * 留在 `TraeSettingsPage`；`gateway/*` 那类耦合 `useGatewayStore` 的组件也照旧各自实现
 * （见 `trae-parity-design.md §1.5`）。
 *
 * 历史：这三块原先只存在于 WorkBuddy 设置页，Trae 设置页完全没有 —— 同一件事
 * 在两个产品上的可得性不一致。抽到共享模块后两边走同一份实现，只可能一起变。
 *
 * ## 语言为什么也放在这里而不是各产品设置页
 *
 * 界面语言是**整个应用**的属性：两个产品分区共用同一套控件与文案，把它放进某一个
 * 产品的设置页，就会出现「在 Trae 里改不了语言」这种取决于当前分区的能力差异 ——
 * 正是本模块当初要消灭的那类不一致。判据仍是「有无产品耦合」：语言完全没有。
 */

export type AppSettingsVariant = "card" | "plain";

/**
 * 分组正文容器。
 *
 * ⚠️ `plain` 下**必须直接展开**（`<>`）：原型 `.dsec` 靠 `gap:9px` 给行距，
 * 而 `gap` 只作用于**直接子级**。夹一层 `CardContent` 会让行距塌成 0，行与行
 * 只剩一条分隔线贴着 —— 与抽屉里其它分区的节奏对不上。
 */
function GroupBody({ variant, children }: { variant: AppSettingsVariant; children: ReactNode }) {
  if (variant === "plain") return <>{children}</>;
  return <CardContent className="space-y-0 p-0">{children}</CardContent>;
}

function UpdateCard(_props: { variant: AppSettingsVariant }) {
  return null;
}
function StartupCard({ variant }: { variant: AppSettingsVariant }) {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  /** `close_to_tray`：与开机自启**分开**的 busy / 错误态 —— 一个失败不该锁住另一个。 */
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const [trayBusy, setTrayBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getLaunchAtLoginEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch((e) => {
        if (!cancelled) setMsg({ type: "err", text: api.asError(e) });
      });
    void api
      .getAppPrefs()
      .then((prefs) => {
        if (!cancelled) setCloseToTray(prefs.close_to_tray);
      })
      .catch((e) => {
        if (!cancelled) setMsg({ type: "err", text: api.asError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onToggle(value: boolean) {
    if (busy || enabled === null) return;
    const previous = enabled;
    setBusy(true);
    setMsg(null);
    try {
      // 后端回读 OS 权威状态；即使与请求一致，也以回读值显示。
      const authoritative = await api.setLaunchAtLoginEnabled(value);
      setEnabled(authoritative);
      setMsg({
        type: "ok",
        text: authoritative
          ? t("appSettings.startup.enabled")
          : t("appSettings.startup.disabled"),
      });
    } catch (e) {
      // 失败时恢复到最后一次确认的状态，并显示可读错误。
      setEnabled(previous);
      setMsg({ type: "err", text: api.asError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function onToggleCloseToTray(value: boolean) {
    if (trayBusy || closeToTray === null) return;
    const previous = closeToTray;
    // 乐观更新：开关必须立刻跟手（宿主是「点关闭那一刻」才读文件，中间没有状态可漂）。
    setCloseToTray(value);
    setTrayBusy(true);
    setMsg(null);
    try {
      /* 先读回完整偏好再写：`set_app_prefs` 是按**已知键**归一化的，只传
         `close_to_tray` 会把 `legal_consent_at`（风险确认时间）冲回默认 0 ——
         用户点一次托盘开关就被要求重新确认风险，属于跨功能的状态破坏。 */
      const current = await api.getAppPrefs();
      // 按**回读值**渲染：后端会把非法值归一成默认值，回显请求值会与宿主真实行为分叉。
      const saved = await api.setAppPrefs({ ...current, close_to_tray: value });
      setCloseToTray(saved.close_to_tray);
      if (saved.close_to_tray !== value) {
        setMsg({ type: "err", text: t("appSettings.tray.saveMismatch") });
      }
    } catch (e) {
      setCloseToTray(previous);
      setMsg({ type: "err", text: api.asError(e) });
    } finally {
      setTrayBusy(false);
    }
  }

  const label = t("appSettings.startup.silent.label");
  const trayLabel = t("appSettings.tray.closeToTray.label");

  return (
    <SettingsGroup
      id="settings-startup"
      title={t("appSettings.startup.title")}
      variant={variant}
    >
      <GroupBody variant={variant}>
        <SettingsFieldRow
          label={label}
          description={t("appSettings.startup.silent.description")}
          htmlFor="startup-silent"
          operational
        >
          <Switch
            id="startup-silent"
            checked={enabled ?? false}
            disabled={busy || enabled === null}
            onCheckedChange={(v) => void onToggle(v)}
            aria-label={label}
          />
        </SettingsFieldRow>

        <SettingsFieldRow
          className="border-b-0"
          stacked={variant === "plain"}
          label={trayLabel}
          description={t("appSettings.tray.closeToTray.description")}
          htmlFor="tray-close-to-tray"
        >
          <Switch
            id="tray-close-to-tray"
            checked={closeToTray ?? true}
            disabled={trayBusy || closeToTray === null}
            onCheckedChange={(v) => void onToggleCloseToTray(v)}
            aria-label={trayLabel}
          />
        </SettingsFieldRow>

        {msg && (
          <Alert
            variant={msg.type === "err" ? "destructive" : "default"}
            className="!w-auto mx-4 my-4 sm:mx-5"
          >
            <AlertDescription>{msg.text}</AlertDescription>
          </Alert>
        )}
      </GroupBody>
    </SettingsGroup>
  );
}

/** 外观：主题选择（持久化到 localStorage）。 */
function AppearanceCard({ variant }: { variant: AppSettingsVariant }) {
  const t = useT();
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);

  function onThemeChange(value: string) {
    if (!isThemePreference(value)) return;
    setThemePreference(value);
    setTheme(value);
  }

  return (
    <SettingsGroup
      id="settings-appearance"
      title={t("appSettings.appearance.title")}
      variant={variant}
    >
      <GroupBody variant={variant}>
        <SettingsFieldRow
          className="border-b-0"
          label={t("appSettings.appearance.theme.label")}
          description={t("appSettings.appearance.theme.description")}
          htmlFor="appearance-theme"
        >
          <Select value={theme} onValueChange={onThemeChange}>
            <SelectTrigger
              id="appearance-theme"
              size="sm"
              className="w-full sm:w-40"
              aria-label={t("appSettings.appearance.theme.aria")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_PREFERENCES.map((key) => (
                <SelectItem key={key} value={key}>
                  {t(THEME_LABEL_KEYS[key])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      </GroupBody>
    </SettingsGroup>
  );
}

/**
 * 语言：界面语言选择。
 *
 * 与主题**同一个归宿**（localStorage，设备级、不上传、不入后端配置）：两者都是
 * 「这台机器上这个人怎么看界面」的偏好，没有跨设备同步的诉求。做成后端配置反而会
 * 让 webui 与桌面端两条通道都要各加一组命令与登记点（见 §二「两条通道形状一致」）。
 *
 * 两个选项的文案是**自名的**（`简体中文` / `English`）：语言菜单用目标语言写自己的名字，
 * 是通行做法 —— 当前界面语言看不懂时，用户仍能认出自己要去哪一项。
 */
function LanguageCard({ variant }: { variant: AppSettingsVariant }) {
  const t = useT();
  const locale = useLocale();

  return (
    <SettingsGroup
      id="settings-language"
      title={t("appSettings.language.title")}
      variant={variant}
    >
      <GroupBody variant={variant}>
        <SettingsFieldRow
          className="border-b-0"
          label={t("appSettings.language.label")}
          description={t("appSettings.language.description")}
          htmlFor="appearance-language"
        >
          <Select
            value={locale}
            onValueChange={(value) => {
              if (isLocale(value)) setLocale(value);
            }}
          >
            <SelectTrigger
              id="appearance-language"
              size="sm"
              className="w-full sm:w-40"
              aria-label={t("appSettings.language.label")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh">{t("appSettings.language.zh")}</SelectItem>
              <SelectItem value="en">{t("appSettings.language.en")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      </GroupBody>
    </SettingsGroup>
  );
}

function ShortcutsCard({ variant }: { variant: AppSettingsVariant }) {
  const t = useT();
  const [enabled, setEnabled] = useShortcutsEnabled();
  const visibleScopes = useVisibleScopes((s) => s.visibleScopes);
  const plan = useMemo(
    () => planScopeShortcuts({ scopes: visibleScopes, enabled }),
    [visibleScopes, enabled],
  );
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
  const label = t("shortcuts.settings.label");
  // 降级（作用域超过上限）⇒ 无可开启之物，不显示开关。
  const degradedByCount = plan.reason === "too-many";

  return (
    <SettingsGroup id="settings-shortcuts" title={t("shortcuts.settings.title")} variant={variant}>
      <GroupBody variant={variant}>
        <SettingsFieldRow
          className="border-b-0"
          label={label}
          description={
            degradedByCount
              ? t("shortcuts.settings.degraded", { limit: SCOPE_SHORTCUT_LIMIT })
              : t("shortcuts.settings.description", {
                  mod: isMac ? "⌘" : "Ctrl",
                  n: plan.bindings.size,
                })
          }
          htmlFor="shortcuts-enabled"
          operational
        >
          {degradedByCount ? null : (
            <Switch
              id="shortcuts-enabled"
              checked={enabled}
              onCheckedChange={(value) => setEnabled(value)}
              aria-label={label}
            />
          )}
        </SettingsFieldRow>
      </GroupBody>
    </SettingsGroup>
  );
}

function ScopeVisibilityCard() {
  const t = useT();
  const location = useLocation();
  const product = platformOfPath(location.pathname);
  const [region] = useScope(product);
  const currentScope = scopeOf(product, region);
  const visibleScopes = useVisibleScopes((s) => s.visibleScopes);
  const setVisibleScopes = useVisibleScopes((s) => s.setVisibleScopes);

  function toggleScope(scope: Scope) {
    const isCurrentlyVisible = visibleScopes.includes(scope);
    const next = isCurrentlyVisible
      ? visibleScopes.filter((s) => s !== scope)
      : [...visibleScopes, scope];
    setVisibleScopes(next);
    // 隐藏到只剩 1 个时提示（开启方向不存在降级，无需提示）
    if (isCurrentlyVisible && next.length === 1) {
      toast.info(t("appSettings.scopeVisibility.onlyOneLeft"));
    }
  }

  return (
    <SettingsGroup id="settings-scope-visibility" title={t("appSettings.scopeVisibility.groupTitle")}>
      <CardContent className="space-y-0 p-0">
        {SCOPES.map((scope) => {
          const { product: scopeProduct } = scopeParts(scope);
          const isVisible = visibleScopes.includes(scope);
          const disabled = isVisible && (visibleScopes.length === 1 || scope === currentScope);

          return (
            <SettingsFieldRow
              key={scope}
              label={
                <div className="flex items-center gap-2">
                  <ScopeMark product={scopeProduct} size={14} className="shrink-0" />
                  <span>{scopeLabel(t, scope)}</span>
                </div>
              }
              operational
              htmlFor={`scope-visible-${scope}`}
            >
              <Switch
                id={`scope-visible-${scope}`}
                checked={isVisible}
                disabled={disabled}
                onCheckedChange={() => toggleScope(scope)}
                aria-label={t("appSettings.scopeVisibility.toggleAria", { scope })}
              />
            </SettingsFieldRow>
          );
        })}

        {/* 全局提示 */}
        <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
          {t("appSettings.scopeVisibility.hint")}
        </p>
      </CardContent>
    </SettingsGroup>
  );
}

/**
 * 五个应用级设置块，**门禁与原先设置页逐条对齐**。
 *
 * 门禁必须留在这里而不是交给调用方：本模块同时被设置页与顶栏 ⚙「应用设置」抽屉引用，
 * 把判断写在页面上会让两条路径各写一遍 —— 这正是当初 `settings-primitives`
 * 出现漂移的同一种病。
 *
 * 顺序把**语言放在最前**：它改的是其余所有文案的语言，用户在找「设置」时最可能先要它。
 *
 * ★ `variant` 由调用方给：设置页传 `card`（默认），抽屉传 `plain`。**内容只有一份**，
 * 两个出口不会各长一套。
 */
export function AppSettingsGroups({ variant = "card" }: { variant?: AppSettingsVariant } = {}) {
  return (
    <>
      <LanguageCard variant={variant} />
      <AppearanceCard variant={variant} />
      <ShortcutsCard variant={variant} />
      {api.isDesktop() || api.isDemoMode() ? <StartupCard variant={variant} /> : null}
      {api.isWebui() && !api.isDemoMode() ? null : <UpdateCard variant={variant} />}
      <ScopeVisibilityCard />
    </>
  );
}
