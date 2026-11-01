
import { lazy, Suspense, useState, type ElementType } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useLocation } from "react-router-dom";

import { ScopeChip, scopeLabel } from "@/components/scope-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ViewParamBar } from "@/components/usage/view-param-bar";
import { useT } from "@/lib/i18n";
import { type Product, platformOfPath } from "@/lib/platforms/registry";
import { scopeOf } from "@/lib/scope";
import { useRefreshAction } from "@/lib/use-refresh-action";
import { useScope } from "@/lib/use-scope";
import { readPreferredCombineAll } from "@/lib/usage-params";
import { type UsageLedger } from "@/lib/usage-ledger";
import { DEFAULT_USAGE_WINDOW, type UsageWindow } from "@/lib/usage-window";
import type { TranslationKey } from "@/locales/zh";

/* 四个页面**各自 lazy**（见文件头注释）。 */
const TokenStatsPage = lazy(() => import("@/pages/TokenStatsPage"));
const CreditStatsPage = lazy(() => import("@/pages/CreditStatsPage"));
const TraeTokenStatsPage = lazy(() => import("@/pages/TraeTokenStatsPage"));
const TraeCreditsPage = lazy(() => import("@/pages/TraeCreditsPage"));
const QoderUsagePage = lazy(() => import("@/pages/QoderUsagePage"));
const QoderCreditsPage = lazy(() => import("@/pages/QoderCreditsPage"));

/** 一级四视图（与原型 `tabs` 一一对应）。 */
export type UsageTab = "trend" | "sessions" | "credits";

const TAB_LABEL: Record<UsageTab, TranslationKey> = {
  trend: "wbStats.usage.view.trend",
  sessions: "wbStats.usage.view.sessions",
  credits: "wbStats.usage.view.credits",
};

const PLATFORM_TABS: Record<Product, UsageTab[]> = {
  workbuddy: ["trend", "sessions", "credits"],
  trae: ["trend"],
  qoder: ["trend", "sessions", "credits"],
};

/** 平台 → 子页面（Token 页 / 积分页）。 */
const USAGE_PAGES: Record<
  Product,
  {
    tokens: ElementType;
    credits: ElementType;
    tokenViews: boolean;
    /** 该平台的数据源能否**跨区域合并**（决定参数条要不要渲染合并态控件）。 */
    mergeScopes: boolean;
    ledger: boolean;
  }
> = {
  workbuddy: {
    tokens: TokenStatsPage,
    credits: CreditStatsPage,
    tokenViews: true,
    mergeScopes: true,
    ledger: false, // ⚠️ 本 fork：网关已下线 ⇒ 不再有账本切换（恒为客户端）
  },
  trae: {
    tokens: TraeTokenStatsPage,
    credits: TraeCreditsPage,
    tokenViews: true,
    mergeScopes: true,
    ledger: false, // ⚠️ 本 fork：网关已下线 ⇒ 不再有账本切换（恒为客户端）
  },
  /* Qoder：**单位是 credits，不是 Token**（客户端按 credits 计费、token 计数恒为 0，
     三处取证见 `QoderUsagePage` 文件头）。
     · tokens 页 = 趋势 / 模型 / 会话三视图（消费 `view`，故 `tokenViews: true`）；
     · credits 页 = **实时余额快照**（`qoder_credits`），与逐日用量是两个口径。
     ⚠️ `mergeScopes: false`（2026-10-18）：Qoder 用量来自**本机客户端会话记录**，
        只扫当前区域的目录 ⇒ 合并两个区域没有可合并的数据，参数条那枚控件是死的。
     ⚠️ 账本（2026-10-28 补齐）：客户端 = `qoder_usage`（按 credits），网关 = 新落库的
        `gateway_ledger`（同样带 credits）⇒ 三档都有真实数据。 */
  qoder: {
    tokens: QoderUsagePage,
    credits: QoderCreditsPage,
    tokenViews: true,
    mergeScopes: false,
    ledger: false, // ⚠️ 本 fork：网关已下线 ⇒ 不再有账本切换（恒为客户端）
  },
};

/**
 * 各平台**可选的账本档**。
 *
 * Trae 曾经只给「网关」一档（客户端对话库是 SQLCipher 加密的，没有明文可解析落盘）。
 * 2026-10-28 起客户端档**可选**：用户用 sqlcipher 导出明文副本后，本工具读那份明文
 * ——详见 `trae/client_import.rs`。未导入时选中该档显示**导入引导**（不是空图，
 * 也不是禁用：禁用会让用户连「怎么导入」的入口都看不到）。
 */
const PLATFORM_LEDGER_VALUES: Record<Product, readonly UsageLedger[]> = {
  workbuddy: ["client"],
  trae: ["client"],
  qoder: ["client"],
};

/**
 * 账本**有意义的视图**（切换器只在这些视图上出现）。
 *
 * 账本是「换一本账看数据」；对没有来源拆分的视图（Qoder 的实时余额、两平台的按密钥）
 * 渲染它只会换来「点了没反应」。⚠️ 与 `mergeScopes` 同一条纪律：不渲染无效果控件。
 *
 * - WorkBuddy：四个视图都消费（会话在网关账本下换成账号/端点表，积分按来源拆 credit）；
 * - Trae：趋势 / 模型（token 逐日）；积分页的数据是**余额快照差**，拆不出来源；
 * - Qoder：趋势 / 模型 / 会话（credits 逐日）；积分页是余额，与窗口无关。
 */
const LEDGER_VIEWS: Record<Product, readonly UsageTab[]> = {
  workbuddy: ["trend", "sessions", "credits"],
  trae: ["trend"],
  qoder: ["trend", "sessions"],
};

export default function UsagePage({ defaultTab = "trend" }: { defaultTab?: UsageTab } = {}) {
  const t = useT();
  /* 平台从**路由**推（同 `OverviewPage`）：`/s/trae-cn/usage` 里就带着平台。 */
  const location = useLocation();
  const product = platformOfPath(location.pathname);
  const [region] = useScope(product);
  const scope = scopeOf(product, region);
  const tabs = PLATFORM_TABS[product];
  /* 子 Tab 也支持深链 `?usage=`（原型 `demo-app.js` 就是这么做的）：评审时能直接把
     「模型 / 会话 / 积分」某一页发给别人，而不用先点一遍。
     ⚠️ 只在**初值**读一次 —— 之后它由 Tabs 自己持有（写回 URL 会让浏览器后退键
     在「切 tab」与「离开页面」之间来回跳，那比没有深链更烦）。 */
  const [tab, setTab] = useState<UsageTab>(() => {
    const deep = new URLSearchParams(location.search).get("usage");
    /* 三个视图**逐个列出**（不用 `tabs.includes`）：`tabs` 是**当前平台**可用的视图，
       用它校验深链会把「这个平台没有的视图」静默吞成首视图 —— 而深链恰恰常用于
       对照评审（发一条链接给别人看某一页）。 */
    return deep === "trend" ||
      deep === "sessions" ||
      deep === "credits"
      ? deep
      : defaultTab;
  });
  /* 平台切换后若旧 Tab 在新平台不可用（如从 WB 的「模型」切到 Trae），回落到首个可用视图。 */
  const active = tabs.includes(tab) ? tab : tabs[0];

  const [viewWindow, setViewWindow] = useState<UsageWindow>(DEFAULT_USAGE_WINDOW);
  const [combineAll, setCombineAll] = useState(() => readPreferredCombineAll());
  const [ledger, setLedger] = useState<UsageLedger>("client");

  const {
    tokens: TokenPage,
    credits: CreditPage,
    tokenViews,
    mergeScopes,
    ledger: canSwitchLedger,
  } = USAGE_PAGES[product];
  /** 本平台可选的账本档；当前值不在其中（如从 WB 切到 Trae）⇒ 回落到首档。 */
  const ledgerValues = PLATFORM_LEDGER_VALUES[product];
  const activeLedger: UsageLedger = ledgerValues.includes(ledger) ? ledger : ledgerValues[0];
  /** 账本切换器**在该视图上**是否有意义（见 `LEDGER_VIEWS`）。 */
  const ledgerVisible = canSwitchLedger && LEDGER_VIEWS[product].includes(active);
  /* 页头刷新：只重挂**当前视图**（`key` 变化 ⇒ 子页面重新取数）。
     ⚠️ 不做「全局刷新信号」：四个视图数据源不同，重挂当前视图是唯一不会
     让「另一个视图的空请求」也一起打的方案。 */
  /* 仅作子页 key（保留以支持将来强制重挂载）；当前刷新由 refreshSeq 驱动。 */
  const [reloadKey] = useState(0);
  /** 页头「刷新统计」序号：子页监听它走强制刷新（见 `UsageViewProps.refreshSeq`）。 */
  const [refreshSeq, setRefreshSeq] = useState(0);
  /* 页头刷新的**进行中态**：动作本身只是重挂当前视图（`setReloadKey`），
     真正的取数由子页面自身呈现 —— 按钮侧给「至少 500ms」的吸底反馈即可。 */
  const { busy, run } = useRefreshAction();

  /** 四个视图页共用的受控 props（骨架相同、数据不同）。 */
  const viewProps = {
    viewWindow,
    combineAll,
    onViewWindowChange: setViewWindow,
    /* 账本只对支持它的平台 + 支持它的视图有意义；其余一律给「全部」
       （子页面在这种情况下本来就不消费它，给一个语义中性的值最不容易被误读）。 */
    /* 直接给实际账本：早先这里在 `ledgerVisible` 为假时退回 "all"，
       结果子页把「客户端 + 网关」都渲染出来（网关那张永远是空表）。 */
    ledger: activeLedger,
    refreshSeq,
    /* 视图内也能改账本（例：会话视图「按账号查看网关用量」跳转）。 */
    onLedgerChange: ledgerVisible ? setLedger : undefined,
  };

  return (
    <div className="mx-auto flex w-full max-w-[1240px] min-w-0 flex-col px-7 pt-[26px] pb-[60px]">
      {/* 页头（原型 `viewUsage`，`:2823-2828`）：28px 标题 + 作用域副标题 + 刷新 + 只读 scope-chip。
          `.page-head { margin-bottom: 20px }`（`demo.css:178`）⇒ `mb-5`。 */}
      <header className="mb-5 flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-[640] tracking-[-0.02em]">{t("nav.usage")}</h1>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">
            {t("pageHead.usage", { scope: scopeLabel(t, scope) })}
          </p>
        </div>
        <div className="grow" />
        <Button
          className="shrink-0"
          variant="outline"
          size="default"
          disabled={busy}
          onClick={() =>
            void run(() => {
              /* 两个动作：刷新序号驱动子页**强制重采**，reloadKey 兜底重挂载。 */
              setRefreshSeq((value) => value + 1);
            })
          }
        >
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("wbStats.token.refresh")}
        </Button>
        <ScopeChip scope={scope} />
      </header>

      {/* 子 Tab 条：原型 `.seg` 自带 `margin-bottom:16px`（`demo.js:993`）⇒ `mb-4`。
          不再多套一层 `mt-4` —— 那会与页头的 `mb-5` 叠加成 36px。 */}
      <Tabs className="mb-4" value={active} onValueChange={(value) => setTab(value as UsageTab)}>
        <TabsList>
          {tabs.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(TAB_LABEL[value])}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* ★ 视图参数条：**整页唯一一条**，三个平台共用（WB / Trae / Qoder）。
          合并态控件由 `USAGE_PAGES[product].mergeScopes` 决定是否渲染 ——
          Qoder 只有单区域数据源，渲染它等于给一个死开关。 */}
      <ViewParamBar
        viewWindow={viewWindow}
        onViewWindowChange={setViewWindow}
        combineAll={combineAll}
        onCombineAllChange={setCombineAll}
        canMergeScopes={mergeScopes}
        ledger={activeLedger}
        onLedgerChange={setLedger}
        canSwitchLedger={ledgerVisible}
        ledgerValues={ledgerValues}
      />

      {/* ⚠️ 不在这里加 `overflow-auto`：子页面**各自有滚动容器**，再套一层会出双滚动条。 */}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<Skeleton className="h-32" />}>
          {/*
            ⚠️ **不写 `product === "workbuddy" ? … : …`**（P2 收敛清单第 5 项）：
            「哪些视图存在」由 `PLATFORM_TABS` 给出、「用哪个页面」由 `USAGE_PAGES` 给出，
            两者都已是**按平台的数据**。这里再判一次平台就是**第三份**平台知识，
            新增平台时必漏改。`tokenViews` 同样是数据（该平台的 Token 页是否消费 `view`）。
          */}
          {active === "credits" ? (
            <CreditPage key={reloadKey} {...viewProps} />
          ) : tokenViews ? (
            <TokenPage
              key={reloadKey}
              view={
                active === "sessions" ? active : "trend"
              }
              {...viewProps}
            />
          ) : (
            <TokenPage key={reloadKey} {...viewProps} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
