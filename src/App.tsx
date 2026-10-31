import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ElementType } from "react";
import { BrowserRouter, HashRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation, useMatch, useNavigate, useParams } from "react-router-dom";
import { ArrowUp, GitBranch, LayoutDashboard, MessagesSquare, Monitor, PanelLeftClose, PanelLeftOpen, Settings, User } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import type { UpdateInfo } from "@/lib/types";
import { PageFallback } from "@/components/page-fallback";
import { StatusDot } from "@/components/product-marks";
import { LegalConsentDialog } from "@/components/legal-consent-dialog";
import { TopBar } from "@/components/shell/top-bar";
import { UpdateInstallDialog } from "@/components/update-install-dialog";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { FirstRunHint } from "@/components/first-run-hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { demoModeEnabled, pagesDemoHostingEnabled } from "@/lib/demo-mode";
import { useT } from "@/lib/i18n";
import { scopeLabel } from "@/lib/command-palette";
import type { TranslationKey } from "@/locales/zh";
import { planScopeShortcuts, scopeShortcutTarget } from "@/lib/scope-shortcuts";
import { useVisibleScopes } from "@/lib/scope-visibility";
import { useShortcutsEnabled } from "@/lib/shortcut-preference";
import { getSidebarCollapsed, setSidebarCollapsed } from "@/lib/sidebar";
import { AUTO_CHECK_UPDATE_INTERVAL_MS, currentSeenUpdateVersion, shouldAutoShowNotes, useAutoCheckUpdate } from "@/lib/update-preference";
import { normalizeReleaseNotes } from "@/lib/release-notes";
import { useScopeStatus } from "@/lib/use-scope-status";
import { useCompanionVisibility } from "@/lib/use-companion-visibility";
import { TRAE_VARIANTS_KEY, loadTraeVariantStatuses } from "@/lib/trae-variant-status";
import type { TraeVariantStatus } from "@/lib/trae-types";

const AccountsPage = lazy(() => import("@/pages/AccountsPage"));
const AggregateAccountsPage = lazy(() => import("@/pages/AggregateAccountsPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const OverviewPage = lazy(() => import("@/pages/OverviewPage"));
const UsagePage = lazy(() => import("@/pages/UsagePage"));
const TraeAccountsPage = lazy(() => import("@/pages/TraeAccountsPage"));
const TraeSettingsPage = lazy(() => import("@/pages/TraeSettingsPage"));
const SessionsPage = lazy(() => import("@/pages/SessionsPage"));
const TraeSessionsPage = lazy(() => import("@/pages/TraeSessionsPage"));
/* Qoder（第三个平台）：账号页 / 概览页 / 设置页是**真实页面**（真实数据 + 应用级设置）；
   用量 / 会话依赖网关请求日志与额度缓存，尚未落地 ⇒ 共用「尚未接入」的结构化空态
   （**不**复用其它平台的页面，否则会把别的平台的账号渲染进来，用户会以为 Qoder 已经在用）。 */
const QoderAccountsPage = lazy(() => import("@/pages/QoderAccountsPage"));
const QoderOverviewPage = lazy(() => import("@/pages/QoderOverviewPage"));
const QoderSettingsPage = lazy(() => import("@/pages/QoderSettingsPage"));
const QoderPendingPage = lazy(() => import("@/pages/QoderPendingPage"));
/* P0 收敛清单第 1 项：`Product` 的类型定义**已搬进注册表**，这里改为 import。
   （原来 App.tsx 里有一份局部 `type Product`，两处重复 —— 现在只剩一处。） */
import { DESTINATION_CAPABILITY, type Destination, DESTINATIONS, destinationOfLegacyPath, hasCapability, platformDescriptor, type Product, platformOfPath } from "@/lib/platforms/registry";
import { parseScope, type Scope, scopeOf, scopeParts, writeLastScope } from "@/lib/scope";
import { useCachedResource } from "@/lib/use-cached-resource";
import { useScope } from "@/lib/use-scope";
import { useTraeVariant } from "@/lib/use-trae-variant";
import { useCreditAutoRefresh } from "@/lib/use-credit-auto-refresh";
import { useWorkbuddyStatusRefresh } from "@/lib/use-workbuddy-status-refresh";
import { useAccountsStore } from "@/stores/accounts";
import { useSessionsStore } from "@/stores/sessions";

/* 产品显示名（`PRODUCT_LABEL_KEY`）与产品首页（`PRODUCT_HOME`）**已随 P2 删除** ——
   两者都在注册表的 `PlatformDescriptor` 里（`labelKey` / `home`），
   本文件只从 `platformDescriptor(product)` 现取。原先两份常量的完整理由
   （为什么存文案键、Trae 分区为何显示 `TraeWork`、区域为何不进侧栏）已随字段迁到
   `registry.ts` 的 `PlatformDescriptor.labelKey` 注释，**不在两处各留一份**。 */

/**
 * 路由 → 产品。
 *
 * ⚠️ 实现**已收敛到注册表的 `platformOfPath`**（P0 收敛清单）——
 * 原来这里有一份同款判断，两处各写一遍必然漂移。
 */
const productFromPath = platformOfPath;

const SCOPED_ROUTES: Record<Product, Record<Destination, ElementType>> = {
  workbuddy: {
    overview: OverviewPage,
    accounts: AccountsPage,
    usage: UsagePage,
    sessions: SessionsPage,
    settings: SettingsPage,
  },
  trae: {
    overview: OverviewPage,
    accounts: TraeAccountsPage,
    usage: UsagePage,
    sessions: TraeSessionsPage,
    settings: TraeSettingsPage,
  },
  qoder: {
    overview: QoderOverviewPage,
    accounts: QoderAccountsPage,
    usage: UsagePage,
    sessions: QoderPendingPage,
    settings: QoderSettingsPage,
  },
};

const DEST_META: Record<
  Destination,
  { labelKey: TranslationKey; icon: ComponentType<{ className?: string }> }
> = {
  overview: { labelKey: "nav.overview", icon: LayoutDashboard },
  accounts: { labelKey: "nav.accounts", icon: User },
  usage: { labelKey: "nav.usage", icon: MessagesSquare },
  sessions: { labelKey: "nav.sessions", icon: GitBranch },
  settings: { labelKey: "nav.settings", icon: Settings },
};

function ScopedDestination() {
  const { scope: rawScope, dest: rawDest } = useParams();

  const scope = parseScope(rawScope);
  if (!scope) return <Navigate to="/" replace />;

  if (!(DESTINATIONS as readonly string[]).includes(rawDest ?? "")) {
    return <Navigate to="/" replace />;
  }

  const { product } = scopeParts(scope);
  const Page = SCOPED_ROUTES[product][rawDest as Destination];
  return <Page />;
}

function navLinkClass({ isActive, collapsed }: { isActive: boolean; collapsed?: boolean }): string {
  return cn(
    "group flex h-[38px] items-center gap-2.5 rounded-[10px] text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
    /* 折叠态：图标居中（`justify-center` + 方形 34px）—— 宽度只有 60px，
       再留 `px-2.5` 会让图标偏左，六枚图标排成一列歪的。 */
    collapsed ? "w-[34px] justify-center px-0" : "w-full px-2.5",
    isActive
      ? "bg-primary/16 font-[550] text-foreground [&>svg]:text-primary"
      : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
  );
}

/** 侧栏导航项的数据形状（`scopedNav` 的元素）。 */
type ScopedNavItem = {
  dest: Destination;
  to: string;
  labelKey: TranslationKey;
  icon: ComponentType<{ className?: string }>;
  badge: { n: number; warn: boolean } | null;
};

/**
 * 侧栏导航项（单个）。
 *
 * ⚠️⚠️ **`className` 必须是字符串，`isActive` 必须在组件内自己算** —— 这曾是一次线上事故：
 *
 * `<TooltipTrigger asChild>` 走 Radix 的 `Slot`，而 `Slot.mergeProps` 对 `className` 的处理是
 * `[slotValue, childValue].filter(Boolean).join(" ")` —— **它不会调用函数**，只会把函数
 * `String()` 成一个字符串。于是 `<NavLink className={({ isActive }) => ...}>` 合并后变成
 * `class="({isActive:...}) => ..."`：所有工具类全部失效，导航项退化成块级元素
 * （图标一行、文字一行、`h-[38px]` / 内边距 / 圆角全丢，选中态只剩一条错位的横杠）。
 * 2026-10-22 GitHub Pages 上的侧栏就是这个症状 —— 与构建、base、CSS 产物都无关，
 * 是 React 层的 className 契约被 `asChild` 打穿。
 *
 * ⇒ 判活改由 `useMatch` 完成，规则与 `NavLink` 内部**同一套**
 * （`end: false` 正是 NavLink 对非根路径的默认值），交给 `Slot` 的永远是静态字符串。
 * 别再改回 `className={({ isActive }) => ...}`。
 */
function SidebarNavItem({ item, collapsed }: { item: ScopedNavItem; collapsed: boolean }) {
  const t = useT();
  const isActive = useMatch({ path: item.to, end: false }) !== null;
  const badge = item.badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink to={item.to} className={navLinkClass({ isActive, collapsed })}>
          {/* 折叠态：图标自身居中（`justify-center` 由 navLinkClass 的 collapsed 变体给出），
              文字不渲染；徽章从「行尾横排」改成**图标右上角标** —— 60px 里横排放不下，
              而角标是「有未读/有待处理」的通用语言，不依赖文字。 */}
          <span className="relative">
            <item.icon className="size-4" />
            {collapsed && badge !== null ? (
              <span
                data-badge={item.dest === "sessions" ? "pending-sync" : `count-${item.dest}`}
                className={cn(
                  "absolute -right-1.5 -top-1.5 grid h-[14px] min-w-[14px] place-items-center rounded-full px-1 text-[9px] tabular-nums ring-2 ring-sidebar",
                  badge.warn ? "bg-warning/22 text-warning" : "bg-muted text-muted-foreground",
                  isActive && "bg-primary/25 text-foreground",
                )}
              >
                {badge.n}
              </span>
            ) : null}
          </span>
          {collapsed ? null : (
            <>
              {t(item.labelKey)}
              {badge !== null ? (
                <span
                  data-badge={item.dest === "sessions" ? "pending-sync" : `count-${item.dest}`}
                  className={cn(
                    "ml-auto grid h-[18px] min-w-[20px] place-items-center rounded-full px-1.5 text-[10.5px] tabular-nums",
                    badge.warn ? "bg-warning/22 text-warning" : "bg-muted text-muted-foreground",
                    isActive && "bg-primary/25 text-foreground",
                  )}
                >
                  {badge.n}
                </span>
              ) : null}
            </>
          )}
        </NavLink>
      </TooltipTrigger>
      {/* 折叠态才需要 tooltip（展开态文字就在旁边；双份显示反而冗余）。 */}
      {collapsed ? (
        <TooltipContent side="right">
          {t(item.labelKey)}
          {badge !== null ? ` · ${badge.n}` : ""}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

/**
 * 每条 Trae 产品线的运行状态。
 *
 * 只在 Trae 分区激活时探测：在 WorkBuddy 分区下这次探测没有意义，
 * 而演示模式下 `get_trae_variants` 会直接抛错（按「未运行」处理即可）。
 *
 * **返回两条线各自的运行状态**（而不是单一的 true/false）：
 * 侧栏底部那颗圆点跟随**当前选中的那条线**，若只探测「Trae 是否在运行」，
 * 在「Trae Work 已关闭、Trae CN 在运行」时就会显示错误的绿灯。
 *
 * ## 走快照缓存的两个理由
 *
 * 1. **不让圆点在每次切换时先灰一下再变绿**：不缓存的话，切回 Trae 分区的那一帧
 *    状态是空的，圆点会闪一次「未运行」。
 * 2. **`freshMs` 给 60 秒**：这颗圆点是**装饰性**的（真实状态在 Trae 页面的状态条
 *    上），不值得每次切换都重探一次；窗口之外照旧后台重校验，每分钟也仍有一次定时刷新。
 *
 * 键在「不在 Trae 分区」时置为 `null`（不缓存、不探测），避免在 WorkBuddy 分区下白跑。
 */
function useTraeVariantRunning(active: boolean): Record<string, boolean> {
  const { data, refresh } = useCachedResource<TraeVariantStatus[]>(
    active ? TRAE_VARIANTS_KEY : null,
    loadTraeVariantStatuses,
    { freshMs: 60 * 1000 },
  );

  useEffect(() => {
    if (!active) return;
    // ⚠️ 这里刻意用 `refresh()`（强制）而不是 `revalidate()`：本 hook 是**唯一**的定时器
    // 持有者，而它的 `freshMs` 恰好等于间隔（60s）。换成 `revalidate()` 后，tick 会因为
    // 「距上次写入还差几十毫秒不到一个窗口」被窗口闸门吃掉 ⇒ 实际节奏退化成 **120 秒**，
    // 且不报任何错。要用 `revalidate()` 就必须同时把 `freshMs` 调小于间隔
    // （`use-scope-status.ts` 就是这么做的，那里有多个消费者、非去重不可）。
    const timer = window.setInterval(() => void refresh(), 60 * 1000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  return useMemo(
    () => Object.fromEntries((data ?? []).map((item) => [item.variant, item.running])),
    [data],
  );
}

function CompanionToggle() {
  const t = useT();
  const [visible, setVisible] = useCompanionVisibility();
  const label = t("shared.companion.entry");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          /* 几何与原型 `.mini-btn`（`buddy-switch-prototype.html:188-192`）一致：20px、**圆角 999（胶囊）**、图标 11px。
             颜色**保留开关语义**（开=实心 primary，与原型静止态一致；关=弱化），
             —— 原型那两枚是普通动作按钮，这一枚是「显示/隐藏悬浮窗」的开关，
             若一律涂成实心就丢掉了开关状态这个信号。 */
          className={cn(
            "size-5 shrink-0 rounded-full p-0",
            visible
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "text-sidebar-foreground/40 hover:text-sidebar-foreground/70",
          )}
          aria-label={label}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          <Monitor className="size-[11px]" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 侧栏底部的应用信息。
 *
 * 这里展示的是**本应用**（Buddy Switch）的版本，而不是所管理客户端的版本：
 * `status.version` 来自 `update::APP_VERSION`，此前挂在「WorkBuddy」名下会让人
 * 误以为它是 WorkBuddy 客户端的版本号。状态圆点跟随当前选中的产品。
 *
 * **只负责内容**：底部区块的边框、上间距与纵向间隔归 `Layout` 里那个
 * `<section>` —— 容器留在 `Layout` 才能只写一处。
 * webui 下整行不渲染（没有桌面运行态可展示）。
 */
function AppFooter({
  product,
  running,
  version,
}: {
  product: Product;
  running: boolean;
  version: string | undefined;
}) {
  const t = useT();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /* 「自动检查更新」开关（顶栏 ⚙ 抽屉里那一行）。关掉后**挂载时的首次检查也不做** ——
     「自动」包含首查；想手动查的人走设置里的「检查更新」按钮。 */
  const [autoCheck] = useAutoCheckUpdate();
  /* 已经主动弹过的版本（本次运行内）。同一版只弹一次：用户「稍后升级」是正常决策，
     30 分钟后再把同一份说明糊回脸上就是骚扰。 */
  const autoShownRef = useRef<string | null>(null);

  useEffect(() => {
    if (!autoCheck) {
      // 关掉自动检查时清空已有结果：否则上一次查到的新版本角标会一直挂着，
      // 看起来像「关了还在查」。
      setInfo(null);
      return;
    }
    let disposed = false;

    async function checkForUpdate() {
      try {
        const result = await api.checkUpdate();
        if (disposed) return;
        if (!result.ok) {
          setInfo(null);
          return;
        }
        /* 版本说明跨了「外部资产 → 渲染」的边界，进 state 前先按白名单归一
           （`lib/release-notes.ts`）：宁可少显示一条，也不把未知结构送进渲染树。 */
        const normalized: UpdateInfo = { ...result, notes: normalizeReleaseNotes(result.notes) };
        setInfo(normalized);
        if (
          autoShownRef.current !== normalized.latest &&
          shouldAutoShowNotes({
            desktop: api.isDesktop(),
            hasUpdate: Boolean(normalized.hasUpdate),
            latest: normalized.latest,
            seenVersion: currentSeenUpdateVersion(),
          })
        ) {
          autoShownRef.current = normalized.latest ?? null;
          setDialogOpen(true);
        }
      } catch {
        // 左下角只展示可操作的升级状态，网络错误不打扰正常使用。
      }
    }

    void checkForUpdate();
    const timer = window.setInterval(() => void checkForUpdate(), AUTO_CHECK_UPDATE_INTERVAL_MS);

    function onVisibilityChange() {
      if (document.visibilityState === "visible") void checkForUpdate();
    }
    function onWindowFocus() {
      void checkForUpdate();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [autoCheck]);

  const hasUpdate = Boolean(info?.ok && info.hasUpdate && info.latest);
  const productLabel = t(platformDescriptor(product).labelKey);

  return (
    <>
      <div>
        <div className="flex items-center gap-2 px-1 text-[11.5px] text-muted-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <StatusDot on={running} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t(running ? "sidebar.running" : "sidebar.notRunning", { product: productLabel })}
            </TooltipContent>
          </Tooltip>
          {/* 版本号用 tabular-nums，让数字变化时纵向对齐、不跳动。 */}
          <span className="min-w-0 flex-1 truncate tabular-nums text-sidebar-foreground/70">
            v{version || "?"}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* P9 T04：会话悬浮窗入口（桌面端；与原型版本行的 `.mini-btn` 同位）。
                它是**可见性开关**，与托盘 / 窗口内关闭按钮收敛到同一份偏好 —— 不新增第二个切换器。 */}
            {api.isDesktop() ? <CompanionToggle /> : null}
            {hasUpdate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    /* 与 `.mini-btn` 同几何（20px / 胶囊 / 图标 11px）。 */
                    className="size-5 rounded-full p-0"
                    aria-label={t("sidebar.update")}
                    onClick={() => setDialogOpen(true)}
                  >
                    <ArrowUp className="size-[11px]" strokeWidth={2.5} aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{t("sidebar.update")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
      <UpdateInstallDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        update={info}
      />
    </>
  );
}

function Layout() {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();

  /**
   * 当前产品分区（来自路由前缀）。
   *
   * 路径只能回答「是 WorkBuddy 还是 Trae」，回答不了「Trae 里是看哪条产品线」——
   * 两条线共用 `/trae/...`。产品线的选择由页面内部读取（见 `useTraeVariant`）。
   */
  const product: Product = productFromPath(location.pathname);

  const bareShell = Boolean(useMatch("/aggregate"));

  const [wbRegion] = useScope(product);
  const [traeRegion] = useTraeVariant();
  const navRegion = product === "trae" ? traeRegion : wbRegion;
  const scope = scopeOf(product, navRegion);
  /** 六个作用域的环境状态（顶栏作用域菜单的唯一取数来源）。 */
  const { statuses, refreshProduct } = useScopeStatus();

  const [paletteOpen, setPaletteOpen] = useState(false);

  const [sidebarCollapsed, setSidebarCollapsedState] = useState(getSidebarCollapsed);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsedState((collapsed) => {
      const next = !collapsed;
      setSidebarCollapsed(next);
      return next;
    });
  }, []);

  /* ⌘B / Ctrl+B：开关侧栏折叠。与 ⌘K（命令面板）、⌘1..9（切作用域）同族同规则：
     修饰键必须带、不能是组合（alt/shift 一律不接）、输入框内不接。 */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "b") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      toggleSidebar();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  const [shortcutsEnabled] = useShortcutsEnabled();
  const visibleScopes = useVisibleScopes((s) => s.visibleScopes);
  const shortcutPlan = useMemo(
    () => planScopeShortcuts({ scopes: visibleScopes, enabled: shortcutsEnabled }),
    [visibleScopes, shortcutsEnabled],
  );

  const sessionGroups = useSessionsStore((s) => s.groups);
  const pendingSyncCount = useMemo(
    () => sessionGroups.filter((g) => g.status === "behind" || g.status === "diverge").length,
    [sessionGroups],
  );

  function navBadge(dest: Destination): { n: number; warn: boolean } | null {
    if (dest === "accounts") {
      /* 与顶栏作用域菜单**同源**（`useScopeStatus`）：数出与「N 个需处理」不会再对不上。
         `attentionCount` 为 `null`（未知）时按「无警示」处理 —— 不拿未知冒充有事。 */
      const n = statuses[scope].accountCount;
      const attention = statuses[scope].attentionCount ?? 0;
      return n > 0 ? { n, warn: attention > 0 } : null;
    }
    if (dest === "sessions") {
      return pendingSyncCount > 0 ? { n: pendingSyncCount, warn: true } : null;
    }
    return null;
  }

  const scopedNav = useMemo(
    () =>
      DESTINATIONS.filter((dest) => {
        const capability = DESTINATION_CAPABILITY[dest];
        return capability === undefined || hasCapability(product, capability);
      }).map((dest) => ({
        dest,
        to: `/s/${scopeOf(product, navRegion)}/${dest}`,
        labelKey: DEST_META[dest].labelKey,
        icon: DEST_META[dest].icon,
        badge: navBadge(dest),
      })),
    // `navBadge` 读到的事实都在下面这几个依赖里（含 `statuses` / 网关密钥 / 待同步数）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [product, navRegion, pendingSyncCount, statuses],
  );

  const appVersion = useAccountsStore((s) => s.status?.version || s.global.status?.version);
  const workbuddyRunning = useAccountsStore((s) =>
    Boolean(s.status?.running || s.global.status?.running),
  );
  const traeRunning = useTraeVariantRunning(product === "trae");
  // Trae 分区的状态圆点跟随**当前选中的区域**（而不是「Trae 是否有任意一条在跑」）：
  // 在「Trae CN 已关闭、Trae 国际版在运行」时，只探「Trae 是否运行」会显示错误的绿灯。
  const running = product === "workbuddy" ? workbuddyRunning : Boolean(traeRunning[traeRegion]);

  useCreditAutoRefresh();
  useWorkbuddyStatusRefresh();

  function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    const tag = el?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable === true;
  }

  /** ⌘K / Ctrl+K：开关命令面板（面板本身不是切换器，只是搜索/跳转入口）。 */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /* 当前目的地：`/s/{scope}/{dest}` 取路径段；旧路由走注册表映射（缺失回落 accounts）。 */
  const currentDest = useMemo(() => {
    const match = /^\/s\/[^/]+\/([^/]+)/.exec(location.pathname);
    if (match) return match[1];
    return destinationOfLegacyPath(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      if (isTypingTarget(event.target)) return;
      const index = Number(event.key);
      let target: Scope | undefined;
      for (const [scope, bound] of shortcutPlan.bindings) {
        if (bound === index) {
          target = scope;
          break;
        }
      }
      if (!target) return; // 未绑定（降级）⇒ 按下无反应（不提示、不导航）
      event.preventDefault();
      navigate(scopeShortcutTarget(target, currentDest));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutPlan, currentDest, navigate]);

  /**
   * 切作用域（顶栏作用域菜单的唯一入口）：写「上次作用域」记忆 + 导航到
   * `/s/{scope}/{dest}`——**URL 仍是唯一真值**，记忆只决定下次冷启动落到哪。
   */
  function selectScope(next: Scope) {
    /* 从聚合页选任一作用域 = 离开聚合。目的地固定为**账号页**：
       聚合页的主任务就是账号，回到「你上次看的那个非账号页面」反而意外。 */
    if (bareShell) {
      writeLastScope(window.localStorage, next);
      navigate(`/s/${next}/accounts`);
      return;
    }
    if (next === scope) return;
    writeLastScope(window.localStorage, next);
    navigate(scopeShortcutTarget(next, currentDest));
  }

  async function refreshCurrentScope() {
    try {
      if (product === "workbuddy") {
        const store = useAccountsStore.getState();
        void store.refreshRegionStatus(navRegion);
        await store.reconcileAccounts(navRegion);
      } else {
        // Trae / Qoder 的刷新失败不抛错（写进快照的 `error` 字段）⇒ 用显式结果判成败。
        const aggregateError = await refreshProduct(product);
        if (aggregateError) throw new Error(aggregateError);
      }
      toast.success(t("topbar.refreshDone"), {
        description: t("topbar.refreshDoneDesc", { scope: scopeLabel(scope, t) }),
      });
    } catch (error) {
      toast.error(t("topbar.refreshFailed"), { description: api.asError(error) });
    }
  }

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background">
      {/* ══ 顶部应用栏（L0/L1）：作用域 + 运行态 + 搜索 + 刷新 + 主题 + 应用设置 ══ */}
      <TopBar
        scope={scope}
        statuses={statuses}
        shortcutBindings={shortcutPlan.bindings}
        onSelectScope={selectScope}
        searchLabel={t("palette.entry")}
        onOpenSearch={() => setPaletteOpen(true)}
        onRefresh={refreshCurrentScope}
        aggregateMode={bareShell}
        onSelectAggregate={() => navigate("/aggregate")}
      />

      <div className="flex min-h-0 flex-1">
        {/* ══ 侧栏（L2 目的地）：品牌 + 导航 + 版本行。不随产品换血（§3.2） ══
            ⚠️ 裸壳路由（聚合视图）下整块不渲染 —— 那 6 个目的地全是单作用域概念。 */}
        {bareShell ? null : (
        <aside
          className={cn(
            "flex min-h-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar pb-3 pt-3.5",
            "transition-[width] duration-200 ease-out",
            sidebarCollapsed ? "w-[60px] px-2" : "w-[240px] px-3",
          )}
          /* 收起态给读屏器一个明确信号：这一块只有图标，名称在 tooltip 与 aria-label 里。 */
          aria-label={t("product.navAria", { product: t(platformDescriptor(product).labelKey) })}
        >
          {/* 品牌块（原型 `.brand` / `.brand-text`，`docs/prototype/demo.css`）：**只有双行文案，不画应用图标**。
              issue #75：左缘原本纵向排着三枚同族圆角方块 —— Windows 原生标题栏应用图标（系统绘制）、
              顶栏平台图标（26px，唯一可交互）、这里 32px 的应用图标（纯 div）。可交互的那个最小、
              不可交互的两个更大 ⇒ 用户找「切换平台」入口时会点错。
              去掉这枚图标后左缘只剩「平台图标 + 文字」，混淆源头消失（方案 1，
              依据 `docs/prototype/sidebar-brand-design.html`）。
              ★ 折叠态**整块不渲染**：删掉图标后 60px 里没有可承载的内容（应用名在折叠态本就不可见）。
              ⚠️ 别再往这里加应用图标 —— 那正是本 issue 要根治的东西。 */}
          {sidebarCollapsed ? null : (
            <div className="flex items-center gap-2.5 px-2.5 pb-4">
              <div className="min-w-0">
                {/* 字重 650 / 字距 -.01em 对齐原型 `.brand-text b`（`docs/prototype/demo.css`）。
                    字体走 body 继承 —— 原型全站统一 `ui-sans-serif`，不另设展示字体。 */}
                <div className="truncate text-[13.5px] font-[650] leading-5 tracking-[-0.01em] text-sidebar-foreground">
                  Buddy Switch
                </div>
                {demoModeEnabled ? (
                  <Badge variant="secondary" className="mt-0.5 h-4 border-0 px-1.5 text-[10px] text-sidebar-foreground/60 shadow-none">
                    {t("app.demoBadge")}
                  </Badge>
                ) : (
                  <div className="truncate text-[10.5px] leading-4 text-muted-foreground">
                    {t("sidebar.brand.tagline")}
                  </div>
                )}
              </div>
            </div>
          )}

          <nav
            className={cn("flex min-h-0 flex-1 flex-col gap-[3px]", sidebarCollapsed && "items-center")}
            aria-label={t("product.navAria", { product: t(platformDescriptor(product).labelKey) })}
          >
            {scopedNav.map((item) => (
              <SidebarNavItem key={item.to} item={item} collapsed={sidebarCollapsed} />
            ))}
          </nav>

          {/* 侧栏底部区块：运行状态 + 版本行。
              ★ 折叠态：版本行整行隐藏（低频信息），
              但**运行状态点保留** —— 「客户端在不在跑」是随时要瞟一眼的。 */}
          <section className={cn("mt-auto flex flex-col gap-2.5 border-t border-sidebar-border pt-3", sidebarCollapsed && "items-center gap-2")}>
            {api.isWebui() && !demoModeEnabled ? null : (
              sidebarCollapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="grid size-6 shrink-0 place-items-center rounded-lg text-muted-foreground/70">
                      <StatusDot on={running} className="size-2" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t(running ? "sidebar.running" : "sidebar.notRunning", {
                      product: t(platformDescriptor(product).labelKey),
                    })}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <AppFooter product={product} running={running} version={appVersion} />
              )
            )}
          </section>

          {/* 折叠开关：放在侧栏**最底部**（设置项下方、版本行之下）——
              顶部品牌区不放控件（身份区），底部边缘是「抽屉把手」的位置（VS Code 同款思路）。
              收起时它自己就是「展开」按钮 ⇒ 图标随状态翻转，位置不动。 */}
          <div className={cn("mt-2.5 flex border-t border-sidebar-border pt-2.5", sidebarCollapsed && "justify-center")}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={toggleSidebar}
                  aria-expanded={!sidebarCollapsed}
                  aria-controls="sidebar-nav"
                  title={t(sidebarCollapsed ? "sidebar.expand" : "sidebar.collapse")}
                  className={cn(
                    "h-8 gap-2 rounded-[10px] text-[12.5px] font-normal text-sidebar-foreground/70 hover:bg-foreground/[0.06] hover:text-sidebar-foreground",
                    sidebarCollapsed ? "w-8 justify-center px-0" : "w-full justify-start px-2.5",
                  )}
                >
                  {sidebarCollapsed ? <PanelLeftOpen className="size-3.5" /> : <PanelLeftClose className="size-3.5" />}
                  {sidebarCollapsed ? null : t("sidebar.collapse")}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t(sidebarCollapsed ? "sidebar.expandHint" : "sidebar.collapseHint")}</TooltipContent>
            </Tooltip>
          </div>
        </aside>
        )}

        {/* ══ 内容区（L3 视图参数）：懒加载页面 ══ */}
        <main className="min-w-0 flex-1 overflow-y-auto bg-background overscroll-contain">
          {/* P6：首次引导条（可关闭 + 持久化；内容由真实绑定派生，降级项不列）。
              ⚠️ 裸壳路由下不渲染：它的文案是「去账号页勾选多项 / 点卡片开抽屉」，
              在聚合页上指错了地方。 */}
          {bareShell ? null : <FirstRunHint />}
          {/* 懒加载页面在这里挂起。Suspense **必须留在路由层**：
              放在更外层会让侧栏一起被 fallback 替换（切页时整屏闪），
              放在页面内部则页面自己的 chunk 还没到、根本没人接住 Suspense。 */}
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* P6：命令面板（Radix Dialog + cmdk）。挂在 Layout 内 ⇒ 与顶栏入口共享开关状态。 */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

export default function App() {
  const Router = pagesDemoHostingEnabled ? HashRouter : BrowserRouter;
  return (
    <TooltipProvider delayDuration={250}>
      <Router>
        <Routes>
          <Route element={<Layout />}>
            {/* P2：作用域路由 —— `/s/{scope}/{dest}`（如 `/s/wb-global/accounts`）。
                ⚠️ 与下面的旧路由**并存**：旧路由不删 ⇒ 旧书签与外部链接继续可达（P2 验收项）。 */}
            <Route path="/s/:scope/:dest" element={<ScopedDestination />} />
            {/* 聚合账号面板（issue #50）：独立路由、与 `/s/:scope/:dest` 并列。
                ⚠️ **不进 `SCOPED_ROUTES`** —— 门禁断言「每个 dest 在作用域路由里恰好 3 次」，
                把聚合塞进去会红；而它本来也不是一个 dest（dest 是单作用域内的页面）。 */}
            <Route path="/aggregate" element={<AggregateAccountsPage />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/" element={<AccountsPage />} />
            <Route path="/credit-stats" element={<UsagePage defaultTab="credits" />} />
            <Route path="/token-stats" element={<UsagePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Trae 侧与 WorkBuddy 侧逐条同构；`/trae` 本身重定向到账号管理，
                避免旧书签或外部链接落在空路由上。 */}
            <Route path="/trae" element={<Navigate to="/trae/accounts" replace />} />
            <Route path="/trae/accounts" element={<TraeAccountsPage />} />
            <Route path="/trae/token-stats" element={<UsagePage />} />
            <Route path="/trae/credits" element={<UsagePage defaultTab="credits" />} />
            <Route path="/trae/settings" element={<TraeSettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <Toaster />
      </Router>
      {/* 首启风险确认：全屏模态，只在桌面包且 `legal_consent_at == 0` 时出现。
          放在 Router 之外 —— 它不依赖路由，也不该因导航而重挂载。 */}
      <LegalConsentDialog />
    </TooltipProvider>
  );
}
