
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, CircleAlert, Coins, Info, Loader2, RefreshCw, TrendingDown } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartFrame } from "@/components/usage/chart-frame";
import { CreditBalanceArea } from "@/components/usage/credit-balance-area";
import { CreditDivergingBar } from "@/components/usage/credit-diverging-bar";
import { CreditExpiryBars } from "@/components/usage/credit-expiry-bars";
import { formatCredits, signedCredits } from "@/components/usage/format";
import { StackedDailyBar } from "@/components/usage/stacked-daily-bar";
import { StatTiles, type StatTile } from "@/components/usage/stat-tiles";
import { LEDGER_CLIENT_COLOR, LEDGER_GATEWAY_COLOR } from "@/components/usage/ledger-parts";
import { useUsageWindowLabel, type UsageViewProps } from "@/components/usage/view-param-bar";
import * as api from "@/lib/api";
import { balanceCaption, singleSideCaption } from "@/lib/chart-caption";
import { formatDate } from "@/lib/format";
import { CREDITS_UPSTREAM_REFRESH_INTERVAL_MS } from "@/lib/use-credit-auto-refresh";
import { useAutoRefreshWhenVisible } from "@/lib/use-auto-refresh";
import { displayText } from "@/lib/display-text";
import { useT } from "@/lib/i18n";
import type {
  CreditExpiry,
  CreditResource,
  CreditStatsAccount,
  CreditStatistics,
  GatewayUsageDim,
  Region,
  RegionFilter,
  TokenStatsSource,
} from "@/lib/types";
import { useRefreshAction } from "@/lib/use-refresh-action";
import { useScope } from "@/lib/use-scope";
import { usageWindowKeys } from "@/lib/usage-window";
import { balanceCurve, creditDailyBars, expiryBuckets, mergeSources, type DailyModelColumn } from "@/lib/usage-charts";
import {
  LEDGER_CLIENT_SEGMENT,
  LEDGER_GATEWAY_SEGMENT,
  clientCreditDaily,
  creditDailySeries,
  mergeDims,
  showsClient,
  showsGateway,
  type UsageLedger,
} from "@/lib/usage-ledger";
import { useAccountsStore } from "@/stores/accounts";

/** 会话级缓存：切走再切回不重取。`at` = 这份数据被拿到的时刻（「上次刷新」提示的唯一来源）。 */
const statisticsCache: Partial<Record<RegionFilter, { data: CreditStatistics; at: number }>> = {};

/** 文案里的「每 N 分钟」从间隔常量推导 —— 常量改了文案不会说谎。 */
const REFRESH_INTERVAL_MINUTES = Math.round(CREDITS_UPSTREAM_REFRESH_INTERVAL_MS / 60_000);

export default function CreditStatsPage({
  viewWindow,
  combineAll,
  refreshSeq = 0,
  ledger = "client",
}: UsageViewProps & { ledger?: UsageLedger }) {
  const t = useT();
  const [scopeRegion] = useScope("workbuddy");
  const region: RegionFilter = combineAll ? "all" : scopeRegion;
  const [stats, setStats] = useState<CreditStatistics | null>(() => statisticsCache[region]?.data ?? null);
  const [loading, setLoading] = useState(() => !statisticsCache[region]);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(
    () => statisticsCache[region]?.at ?? null,
  );
  /* 三处「刷新积分」出口（错误重试 / 空态 / 顶部条）共用同一个 `load(region, true)`。 */
  const { busy, run } = useRefreshAction();

  const [tokenSource, setTokenSource] = useState<TokenStatsSource | null>(null);
  const [dim, setDim] = useState<GatewayUsageDim | null>(null);

  const { creditMap, fetchAllRegions } = useAccountsStore(
    useShallow((state) => ({ creditMap: state.creditMap, fetchAllRegions: state.fetchAllRegions })),
  );
  const wbAccounts = useAccountsStore((state) => state.accounts);
  const globalAccounts = useAccountsStore((state) => state.global.accounts);
  /* 页头「刷新统计」：序号变化 ⇒ 强制刷新（refresh = true），
     不能只靠重挂载 —— 重挂载会命中 `statisticsCache` 里的旧数据。 */
  useEffect(() => {
    if (refreshSeq <= 0) return;
    /* 后端已被页头 `prefetch` 强制重采过 ⇒ 这里只绕过**本地** module 缓存去读新数，
       不再传 refresh=true（那会把官方账单再拉一遍，十几秒白等）。 */
    void load(region, false, true, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSeq]);

  useEffect(() => {
    if (wbAccounts.length === 0 && globalAccounts.length === 0) {
      void fetchAllRegions().catch(() => undefined);
    }
  }, [wbAccounts.length, globalAccounts.length, fetchAllRegions]);
  /** 快照账号 ID（`account.id`）→ uid（`sessions.user_id`）：两套 ID 的桥。 */
  const uidBySnapshotId = useMemo(() => {
    const map = new Map<string, string>();
    for (const account of [...wbAccounts, ...globalAccounts]) {
      if (account.uid) map.set(account.id, account.uid);
    }
    return map;
  }, [wbAccounts, globalAccounts]);

  const load = useCallback(
    async (target: RegionFilter, refresh = false, silent = false, bypassCache = false) => {
      if (!refresh && !bypassCache && statisticsCache[target]) {
        const cached = statisticsCache[target]!;
        setStats(cached.data);
        setLastRefreshAt(cached.at);
        setLoading(false);
        setError(null);
        return;
      }
      /* 静默（自动刷新）不点亮 `loading`：那会让顶部按钮转圈、空态闪骨架 ——
         用户没点任何东西，界面不该看起来像在等人操作。 */
      if (!silent) setLoading(true);
      setError(null);
      try {
        // 资源包（到期分布数据源）来自 store；统计来自后端。
        await fetchAllRegions();
        const next = await api.getCreditStatistics(refresh, target);
        const at = Date.now();
        statisticsCache[target] = { data: next, at };
        setStats(next);
        setLastRefreshAt(at);
      } catch (cause) {
        setError(api.asError(cause));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [fetchAllRegions],
  );

  useEffect(() => {
    void load(region);
  }, [load, region]);

  const autoRefresh = useCallback(() => load(region, true, true), [load, region]);
  useAutoRefreshWhenVisible(lastRefreshAt ?? 0, autoRefresh);

  /* 请求口径的两份素材（与余额口径**并行**取；任一失败只让该来源缺席，
     不阻塞余额那一半 —— 余额是权威口径，不能因为附加维度取不到就整页报错）。 */
  useEffect(() => {
    let disposed = false;
    const regions: Region[] = region === "all" ? ["cn", "global"] : [region];
    api
      .getTokenStatistics(undefined, region)
      .then((result) => {
        if (!disposed) setTokenSource(mergeSources(result.sources));
      })
      .catch(() => {
        if (!disposed) setTokenSource(null);
      });
    Promise.all(regions.map((item) => api.getGatewayUsageDim(item).catch(() => null)))
      .then((results) => {
        if (!disposed) setDim(mergeDims(results));
      })
      .catch(() => {
        if (!disposed) setDim(null);
      });
    return () => {
      disposed = true;
    };
  }, [region]);

  const bars = useMemo(
    () => (stats ? creditDailyBars(stats, viewWindow) : []),
    [stats, viewWindow],
  );
  const totalOut = bars.reduce((sum, bar) => sum + bar.outAmt, 0);
  /* 跨日减少：后端单列（不进 usage），这里汇总成一句提示，避免「凭空扣分」的观感。 */
  const totalCarry = useMemo(() => {
    if (!stats) return 0;
    const keys = new Set(usageWindowKeys(viewWindow));
    return stats.daily
      .filter((point) => keys.has(point.date))
      .reduce((sum, point) => sum + (point.carry ?? 0), 0);
  }, [stats, viewWindow]);

  const balancePoints = useMemo(
    () => (stats ? balanceCurve(bars, stats.summary.currentRemaining) : []),
    [bars, stats],
  );

  /** 到期分布数据源：把各账号的资源包并成一份（`CreditExpiry` 形状）。 */
  const mergedExpiry = useMemo<CreditExpiry>(() => {
    const resources: CreditResource[] = [];
    for (const entry of Object.values(creditMap)) {
      if (entry?.resources) resources.push(...entry.resources);
    }
    return { ok: true, resources };
  }, [creditMap]);

  const buckets = useMemo(() => expiryBuckets(mergedExpiry), [mergedExpiry]);
  const hasExpiry = buckets.some((bucket) => bucket.value > 0);
  const expiringTotal = useMemo(
    () => Object.values(creditMap).reduce((sum, entry) => sum + (entry?.expiringSoonRemaining ?? 0), 0),
    [creditMap],
  );
  const soonestDay = buckets.find((bucket) => bucket.value > 0)?.day;

  /** 当前视图窗口的显示名（表头直接用，跟参数条同源）。 */
  const windowLabelOf = useUsageWindowLabel();

  /* ★ 会话归属的是 **uid**（`sessions.user_id`），而积分明细行的 `accountId` 是
     **快照账号 ID**（`account.id`）—— 两套 ID 不同。早先直接拿 `accountId` 查
     uid 键的表 ⇒ 永远 miss ⇒ 全部显示 0。桥接见上方 `uidBySnapshotId`。 */
  /** 会话侧积分：**窗口内**逐日 `credit` 按归属 uid 聚合（老后端无逐日 ⇒ 退全量）。 */
  const creditByUid = useMemo(() => {
    const map = new Map<string, number>();
    if (!tokenSource) return map;
    const keys = new Set(usageWindowKeys(viewWindow));
    for (const session of tokenSource.sessions) {
      const uid = session.accountId ?? "unknown";
      const daily = session.daily ?? [];
      let credit = 0;
      if (daily.length > 0) {
        for (const point of daily) {
          if (!keys.has(point.key)) continue;
          credit += point.credit ?? 0;
        }
      } else {
        credit = session.credit ?? 0;
      }
      if (credit === 0) continue;
      map.set(uid, (map.get(uid) ?? 0) + credit);
    }
    return map;
  }, [tokenSource, viewWindow]);

  /** 某账号在**当前窗口**内的积分消耗（请求口径）。 */
  const windowCredit = (account: CreditStatsAccount): number => {
    const uid = uidBySnapshotId.get(account.accountId) ?? account.accountId;
    return creditByUid.get(uid) ?? 0;
  };

  /* ── 官方口径 ──
     后端 `credit_usage` 本来就把 `official_usage` 一起返回了（`stats.officialUsage`），
     只是这一页一直没用它：消耗走的是「会话 credit 聚合」和「快照差值」，
     两者都会把副本、跨日、过期混进来（实测同一账号本周 1,054 vs 官方 891）。
     官方逐日是按请求记账的权威数据，优先用它；官方不可用 / 窗口超出采集范围时
     再回退本地口径，并在卡片上标明，避免「数字变了但不知道为什么」。 */
  const officialUsageData = stats?.officialUsage;
  const officialUsable =
    officialUsageData?.status === "complete" || officialUsageData?.status === "partial";

  const officialDailyByAccount = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const account of officialUsageData?.accounts ?? []) {
      if (!account.ok) continue;
      const dayMap = new Map<string, number>();
      for (const point of account.daily ?? []) {
        dayMap.set(point.date, point.usage ?? 0);
      }
      map.set(account.accountId, dayMap);
    }
    return map;
  }, [officialUsageData]);

  /* 窗口与官方采集范围的**交集**。
     ⚠️ 不能要求「窗口起点 >= rangeStart」：官方只从 10-02 开始，而「上月」的起点是
     10-01 —— 只早一天，整窗被判超出 ⇒ 回退本地口径 ⇒ 大多数账号本地没有会话记录 ⇒ 全是 0。
     改为裁剪到交集：范围内的日期照常用官方，超出部分不计（并在卡片上标明起点）。 */
  const officialRangeKeys = useMemo(() => {
    if (!officialUsable || !officialUsageData) return null;
    const keys = usageWindowKeys(viewWindow).filter(
      (key) => key >= officialUsageData.rangeStart && key <= officialUsageData.rangeEnd,
    );
    return keys.length > 0 ? keys : null;
  }, [officialUsable, officialUsageData, viewWindow]);

  /** 窗口是否有部分日期落在官方范围之外（用于提示「官方数据自 X 起」）。 */
  const officialClipped = useMemo(() => {
    if (!officialRangeKeys) return false;
    return officialRangeKeys.length < usageWindowKeys(viewWindow).length;
  }, [officialRangeKeys, viewWindow]);

  /** 某账号在窗口内的**官方**消耗；不可用时返回 null。 */
  const officialCreditOf = (accountId: string): number | null => {
    if (!officialRangeKeys) return null;
    const dayMap = officialDailyByAccount.get(accountId);
    if (!dayMap) return null;
    let sum = 0;
    for (const key of officialRangeKeys) {
      sum += dayMap.get(key) ?? 0;
    }
    return sum;
  };

  /** 全账号在窗口内的官方消耗合计（顶部「区间消耗」卡用）。 */
  const officialWindowOut = useMemo(() => {
    if (!officialRangeKeys || !officialUsageData) return null;
    const keys = new Set(officialRangeKeys);
    return officialUsageData.daily
      .filter((point) => keys.has(point.date))
      .reduce((sum, point) => sum + (point.usage ?? 0), 0);
  }, [officialRangeKeys, officialUsageData]);

  const accountCount = stats?.accounts.length ?? 0;
  const hasAnyData =
    Boolean(stats) &&
    (bars.some((bar) => bar.outAmt > 0) || hasExpiry);

  /* ── 请求口径（按来源拆消耗）──
     客户端：`token_stats` 的 `credit`（逐日 / 逐模型）；网关：三维度桶的 `credit`。 */
  const clientCreditMap = useMemo(
    () => (tokenSource ? clientCreditDaily(tokenSource, viewWindow) : new Map<string, number>()),
    [tokenSource, viewWindow],
  );
  const gatewayCreditMap = useMemo(
    () => new Map(creditDailySeries(dim, viewWindow).map((day) => [day.key, day.credit])),
    [dim, viewWindow],
  );
  const creditColumns = useMemo<DailyModelColumn[]>(
    () =>
      bars.map((bar) => {
        const client = showsClient(ledger) ? (clientCreditMap.get(bar.date) ?? 0) : 0;
        const gateway = showsGateway(ledger) ? (gatewayCreditMap.get(bar.date) ?? 0) : 0;
        const segments: { name: string; value: number }[] = [];
        if (client > 0) segments.push({ name: LEDGER_CLIENT_SEGMENT, value: client });
        if (gateway > 0) segments.push({ name: LEDGER_GATEWAY_SEGMENT, value: gateway });
        return { day: bar.date, label: bar.label, total: client + gateway, segments };
      }),
    [bars, clientCreditMap, gatewayCreditMap, ledger],
  );

  const tiles: StatTile[] = [
    {
      icon: Coins,
      label: t("wbStats.usage.credits.available"),
      value: formatCredits(stats?.summary.currentRemaining),
      hint: t("wbStats.usage.credits.accountsHint", { count: accountCount }),
    },
    {
      icon: TrendingDown,
      label: t("wbStats.usage.credits.out"),
      value: signedCredits(officialWindowOut ?? totalOut, "-"),
      hint:
        officialWindowOut !== null
          ? officialClipped && officialUsageData
            ? t("wbStats.usage.credits.outHintClipped", {
                date: officialUsageData.rangeStart.slice(5).replace("-", "/"),
              })
            : t("wbStats.usage.credits.outHintOfficial")
          : totalCarry > 0
            ? t("wbStats.usage.credits.carryHint", { value: formatCredits(totalCarry) })
            : t("wbStats.usage.credits.outHintLocal"),
    },
    {
      icon: CalendarDays,
      label: t("wbStats.usage.credits.expiring"),
      value: formatCredits(expiringTotal),
      /* 金额是**7 天内**到期额度之和，光写「D+1」会让人以为只有明天那点 —— 把窗口写出来。 */
      hint: soonestDay
        ? t("wbStats.usage.credits.expiringHint", { value: `D+${soonestDay}` })
        : undefined,
    },
  ];

  const balanceCaptionText =
    balancePoints.length > 0
      ? balanceCaption(
          t,
          balancePoints[0].value,
          balancePoints[balancePoints.length - 1].value,
          balancePoints[0].baseline,
        )
      : "";

  return (
    /* ⚠️ 页头 / 子 Tab / **视图参数条**都由**上层** `UsagePage` 统一渲染
       （原型 `viewUsage` 只有一个「用量」页头、一条参数条）⇒ 本页只渲染视图内容。 */
    <div className="min-w-0">
      {error && (
        <Alert variant="destructive" className="mb-5">
          <CircleAlert />
          <AlertTitle>{t("wbStats.credit.loadFailed")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{error}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => load(region, true))}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("wbStats.credit.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && !stats ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : !stats ? (
        <EmptyState
          icon={CircleAlert}
          title={t("wbStats.usage.empty.credits")}
          description={t("wbStats.usage.empty.creditsHint")}
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => load(region, true))}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("wbStats.usage.empty.refresh")}
            </Button>
          }
        />
      ) : (
        <div className="min-w-0 space-y-6">
          {/* 积分页顶部条（原型 `creditsHeadBar`）：说明 + 「刷新积分」入口。 */}
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">{t("wbStats.credit.headBarHint")}</span>
            <span className="text-xs text-muted-foreground">
              {t("shared.credit.autoEvery", { n: REFRESH_INTERVAL_MINUTES })}
            </span>
            {/* 「上次刷新」是**事实**（这份数字何时取的）：用绝对时刻而不是「x 分钟前」——
                相对时间不会自己走，停在那里会一直说「刚刚」。 */}
            {lastRefreshAt !== null && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("shared.credit.lastRefresh", { time: formatDate(lastRefreshAt) })}
              </span>
            )}
            <div className="grow" />
            {/* 「刷新积分」按钮已删除：页头的「刷新统计」一次重算积分 + Token，
                两个按钮做同一件事只会让人不知道该点哪个。积分仍按 10 分钟自动刷新。 */}
          </div>

          <StatTiles tiles={tiles} ariaLabel={t("wbStats.credit.overviewAria")} />

          {/* 「本机会话账本」已移除。
              原因（实测数据）：这张表的积分取自会话 jsonl 的 `providerData.rawUsage.credit`，
              ① 它**按请求标价**，与官方账单的实际扣费不是一回事；
              ② 同组副本会被各算一遍（`dailyByModel` 没有参与副本去重）——
                 11-01 本地 947.9 vs 官方 193.67，差 4.9 倍，倍数正好等于副本份数。
              两个偏差叠在一起，用户看到的永远是「跟官方对不上」的数。积分一律以官方为准，
              本机只保留 Token 口径（在「Token」页签）。 */}

          {accountCount > 0 ? (
            <section className="min-w-0 space-y-2.5" aria-labelledby="credit-resource-title">
              <h2 id="credit-resource-title" className="flex items-baseline gap-2 px-1 text-[13px] font-medium leading-5">
                {t("wbStats.credit.creditDetailTitle")}
                <span className="text-[11px] font-normal text-muted-foreground">
                  {windowLabelOf(viewWindow)}
                </span>
              </h2>
              <Card className="min-w-0 gap-0 overflow-hidden rounded-xl py-0 shadow-none">
                <div className="divide-y divide-border/60">
                  {/* 表头只出一列：**跟随上方视图参数**（今天 / 近 7 天 / 近 14 天 /
                      近 30 天 / 自定义），不再固定摊三档 —— 用户选什么窗口就看什么窗口。 */}
                  <div className="flex min-w-0 items-center gap-3 border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
                    <span className="min-w-0 flex-1">{t("wbStats.credit.accountColumn")}</span>
                    <span className="w-[96px] shrink-0 text-right" title={windowLabelOf(viewWindow)}>
                      {t("wbStats.credit.usageColumn")}
                    </span>
                  </div>
                  {stats.accounts.map((account) => {
                    const name = displayText(account.accountName) || account.accountId;
                    /* 本期额度（周期包）：来自实时额度接口，`creditMap` 的键就是账号库 id。 */
                    const cycle = creditMap[account.accountId]?.cycle ?? null;
                    const cycleEndText =
                      cycle?.endAt != null
                        ? new Date(cycle.endAt).toLocaleDateString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                          })
                        : "—";
                    return (
                      <div
                        key={account.accountId}
                        className="flex min-w-0 items-center gap-3 px-4 py-2.5 sm:px-5"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium" title={name}>
                            {name}
                          </span>
                          {cycle && (cycle.total ?? 0) > 0 ? (
                            <span className="block truncate text-[10px] text-muted-foreground">
                              {t("wbStats.credit.cycleLine", {
                                used: formatCredits(cycle.used ?? 0),
                                total: formatCredits(cycle.total ?? 0),
                                date: cycleEndText,
                              })}
                            </span>
                          ) : null}
                        </span>
                        <span className="w-[96px] shrink-0 text-right text-[11.5px] font-medium tabular-nums">
                          {signedCredits(officialCreditOf(account.accountId) ?? windowCredit(account), "-")}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </section>
          ) : null}

          {/* ── 请求口径：**按来源**拆积分消耗（余额口径拆不到来源，见下面这行说明）── */}
          <div className="flex items-center gap-2.5 rounded-[10px] border border-[color:var(--data-series-indigo)]/25 bg-[color:var(--data-series-indigo)]/10 px-3.5 py-2.5 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0 text-[color:var(--data-series-indigo)]" />
            <span>{t("wbStats.usage.credits.caliberNote")}</span>
          </div>

          {creditColumns.some((column) => column.total > 0) ? (
            <ChartFrame
              title={t("wbStats.usage.credits.requestCaliber")}
              caption={t("wbStats.usage.credits.dailyHint")}
              ariaLabel={t("wbStats.usage.credits.requestCaliber")}
            >
              <StackedDailyBar
                columns={creditColumns}
                palette={[LEDGER_CLIENT_COLOR, LEDGER_GATEWAY_COLOR]}
                valueFormat={(value) => formatCredits(value)}
              />
            </ChartFrame>
          ) : null}

          {bars.length > 0 ? (
            <ChartFrame
              title={t("wbStats.usage.credits.dailyTitle")}
              caption={singleSideCaption(t)}
              ariaLabel={t("wbStats.usage.credits.dailyAria")}
            >
              <CreditDivergingBar bars={bars} />
            </ChartFrame>
          ) : null}

          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            {balancePoints.length > 0 ? (
              <ChartFrame
                title={t("wbStats.usage.credits.balanceTitle")}
                caption={balanceCaptionText}
                ariaLabel={t("wbStats.usage.credits.balanceTitle")}
              >
                <CreditBalanceArea points={balancePoints} />
              </ChartFrame>
            ) : null}
            {hasExpiry ? (
              <ChartFrame
                title={t("wbStats.usage.credits.expiryTitle")}
                caption={t("wbStats.usage.credits.expiryDesc")}
                ariaLabel={t("wbStats.usage.credits.expiryAria")}
              >
                <CreditExpiryBars buckets={buckets} />
              </ChartFrame>
            ) : null}
          </div>

          {!hasAnyData ? (
            <EmptyState
              icon={Coins}
              title={t("wbStats.usage.empty.credits")}
              description={t("wbStats.usage.empty.creditsHint")}
              action={
                <Button size="sm" variant="outline" onClick={() => void load(region, true)}>
                  {t("wbStats.usage.empty.refresh")}
                </Button>
              }
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
