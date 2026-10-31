
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, CircleAlert, Coins, Info, Loader2, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
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
import { CreditLedgerTable, LEDGER_CLIENT_COLOR, LEDGER_GATEWAY_COLOR } from "@/components/usage/ledger-parts";
import { useUsageWindowLabel, type UsageViewProps } from "@/components/usage/view-param-bar";
import * as api from "@/lib/api";
import { balanceCaption, singleSideCaption } from "@/lib/chart-caption";
import { formatDate } from "@/lib/format";
import { CREDIT_REFRESH_INTERVAL_MS } from "@/lib/use-credit-auto-refresh";
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
  clientCreditByModel,
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
const REFRESH_INTERVAL_MINUTES = Math.round(CREDIT_REFRESH_INTERVAL_MS / 60_000);

export default function CreditStatsPage({
  viewWindow,
  combineAll,
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
    async (target: RegionFilter, refresh = false, silent = false) => {
      if (!refresh && statisticsCache[target]) {
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
  const clientCreditRows = useMemo(
    () => (tokenSource ? clientCreditByModel(tokenSource, viewWindow) : []),
    [tokenSource, viewWindow],
  );
  const clientCreditTotal = clientCreditRows.reduce((sum, row) => sum + row.credit, 0);

  const tiles: StatTile[] = [
    {
      icon: Coins,
      label: t("wbStats.usage.credits.available"),
      value: formatCredits(stats?.summary.currentRemaining),
      hint: t("wbStats.usage.credits.accountsHint", { count: accountCount }),
    },
    {
      icon: TrendingUp,
      label: t("wbStats.usage.credits.in"),
      value: "—",
      hint: t("wbStats.usage.caption.singleSide"),
    },
    { icon: TrendingDown, label: t("wbStats.usage.credits.out"), value: signedCredits(totalOut, "-") },
    {
      icon: CalendarDays,
      label: t("wbStats.usage.credits.expiring"),
      value: formatCredits(expiringTotal),
      hint: soonestDay ? `D+${soonestDay}` : undefined,
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
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run(() => load(region, true))}
              disabled={busy || loading}
            >
              {busy || loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("wbStats.credit.refreshCredits")}
            </Button>
          </div>

          <StatTiles tiles={tiles} ariaLabel={t("wbStats.credit.overviewAria")} />

          {/* 客户端账本：全宽单表（原来与网关表并排，只剩一张时会被挤成半宽）。 */}
          <CreditLedgerTable book="client" rows={clientCreditRows} total={clientCreditTotal} />

          {accountCount > 0 ? (
            <section className="min-w-0 space-y-2.5" aria-labelledby="credit-resource-title">
              <h2 id="credit-resource-title" className="px-1 text-[13px] font-medium leading-5">
                {t("wbStats.credit.creditDetailTitle")}
              </h2>
              <Card className="min-w-0 gap-0 overflow-hidden rounded-xl py-0 shadow-none">
                <div className="divide-y divide-border/60">
                  {/* 表头只出一列：**跟随上方视图参数**（今天 / 近 7 天 / 近 14 天 /
                      近 30 天 / 自定义），不再固定摊三档 —— 用户选什么窗口就看什么窗口。 */}
                  <div className="flex min-w-0 items-center gap-3 border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
                    <span className="min-w-0 flex-1">{t("wbStats.credit.accountColumn")}</span>
                    <span className="w-[96px] shrink-0 text-right">{windowLabelOf(viewWindow)}</span>
                  </div>
                  {stats.accounts.map((account) => {
                    const name = displayText(account.accountName) || account.accountId;
                    return (
                      <div
                        key={account.accountId}
                        className="flex min-w-0 items-center gap-3 px-4 py-2.5 sm:px-5"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
                          {name}
                        </span>
                        <span className="w-[96px] shrink-0 text-right text-[11.5px] font-medium tabular-nums">
                          {formatCredits(windowCredit(account))}
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
