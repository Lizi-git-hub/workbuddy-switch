/**
 * 「用量」工作台 · **Token 三视图**（趋势 / 模型 / 会话）—— P3 重做。
 *
 * ## 为什么重写
 *
 * 改造前本页是**旧实现**：4 组视图参数散在页内（来源切片 / 范围 / 区域 / 合并）、
 * 图表张数与图注口径都不是原型的四视图（COVERAGE-REPORT §2.12，12 条 ⚠️）。
 * 本版改为「**装配数据 → 渲染四视图组件**」：视图参数收敛为**一条** `ViewParamBar`
 * （范围 + 合并），图表逻辑全部下沉到 `components/usage/*` 与纯函数 `lib/usage-charts.ts`。
 *
 * ## 数据装配（关键决策）
 *
 * 原型「一个作用域 = 一份用量」⇒ 本页把当前范围下的**全部来源**
 * （workbuddy / codebuddy-cli / codebuddy-ide / workbuddy-ai）用 `mergeSources` 聚合成**一份**。
 * 合并作用域（`region === "all"`）时后端同时下发两版来源，一并求和 —— 因此
 * **图表数据（模型 / 热力图）真的跟着变多**（契约 12），不是只换 days。
 *
 * ## 网关逐日图（2026-10-15 新增，独立小图）
 *
 * 主堆叠柱的数据源是 `token_stats`（扫客户端日志）；**网关用量走另一条源**：
 * `get_gateway_token_trend`（读 `token_daily` 的 90 天落库历史）。它渲染成趋势视图里的
 * **独立小图**而不是并进主柱，两条理由（详见 `TrendView` 内注释）：
 * ① 主柱的「末柱 = 概览统计块 = 账号卡今日合计」是**跨视图一致性契约**，并进去会静默改口径；
 * ② 客户端与网关是**两条独立记录**（配置重叠时同一请求两处各记一次），求和会把重复计数藏起来。
 * 小图图注**恒披露覆盖率** —— 历史只覆盖「App 运行过」的日子，未记录日**不是 0**。
 *
 * ## 平台
 *
 * 本页只服务 WorkBuddy（`useScope("workbuddy")`）。Trae 侧的 Token 统计数据源形状不同
 * （`TraeTokenStatistics`），由 `TraeTokenStatsPage` 承担 —— 见 UsagePage 的平台映射。
 *
 * ## 契约（详见 `docs/specs/P3-ARCH.md`）
 *
 * - ★ **视图参数是受控的**（`range` / `combineAll` / `onRangeChange` 由 `UsagePage` 传入）：
 *   本页**不持有**范围与合并态 —— 原型 `viewUsage` 的 `state.range` / `state.merge`
 *   是页面级的，切子 Tab 不重置（见 `UsagePage` 文件头）。参数条也由 `UsagePage` 渲染一次。
 * - 空数组**不渲染**该图；整视图空 ⇒ 区块级 `EmptyState`（含出口）；
 * - 区分「真的没有」与「被视图参数筛没」；
 * - 所有展示字段过 `displayText`（白屏防线）；
 * - ★ **四个视图都必须消费 `viewWindow`**（趋势 / 模型 / 积分接口不变，会话是
 *   2026-10-15 补的口径）：会话此前吃全时数据、切时间纹丝不动（用户报障），
 *   现在按 `sessions[].daily`（后端逐日拆分）在 `sessionPoints` 里按窗口求和；
 * - ★ **会话视图只渲染前 `SESSION_RENDER_LIMIT` 个**（**有意偏离** P3 契约 8
 *   「排行条数 = 气泡数 = 会话数」—— 会话数可达 1.5 万，全量渲染要等数秒；
 *   截断由渲染层显式说明「共 M 个」，统计 tile 仍按全量算。理由见该常量注释）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, CircleAlert, Gauge, Info, Loader2, MessagesSquare, Percent, RefreshCw, Server, TrendingUp, Users } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartFrame } from "@/components/usage/chart-frame";
import { compactTokens, exactTokens } from "@/components/usage/format";
import { LEDGER_CLIENT_COLOR, LEDGER_GATEWAY_COLOR } from "@/components/usage/ledger-parts";
import { ModelDonut } from "@/components/usage/model-donut";
import { AccountRanking } from "@/components/usage/account-ranking";
import { CalendarHeatmap } from "@/components/usage/calendar-heatmap";
import { UsageWave } from "@/components/usage/usage-wave";
import { RateEditor } from "@/components/usage/rate-editor";
import { SessionRanking } from "@/components/usage/session-ranking";
import { KeysView } from "@/components/usage/key-ranking";
import { SessionScatter } from "@/components/usage/session-scatter";
import { StackedDailyBar } from "@/components/usage/stacked-daily-bar";
import { StatTiles, type StatTile } from "@/components/usage/stat-tiles";
import { useUsageWindowLabel, type UsageViewProps } from "@/components/usage/view-param-bar";
import * as api from "@/lib/api";
import { scatterAxisCaption } from "@/lib/chart-caption";
import {
  costOf,
  formatCost,
  isPeakSlot,
  loadRates,
  rateOf,
  type TokenBundle,
} from "@/lib/model-pricing";
import {
  dateKey,
  usageWindowEarliestKey,
  usageWindowKeys,
  todayKey,
  type UsageWindow,
} from "@/lib/usage-window";
import { useT } from "@/lib/i18n";
import type {
  GatewayTokenTrend,
  GatewayUsageDim,
  GatewayUsageRecon,
  Region,
  RegionFilter,
  TokenStatistics,
  TokenStatsSource,
  ApiKeyRecord,
} from "@/lib/types";
import { useRefreshAction } from "@/lib/use-refresh-action";
import { useScope } from "@/lib/use-scope";
import {
  SESSION_RENDER_LIMIT,
  calendarWindowKeys,
  mergeGatewayTrends,
  mergeSources,
  sessionPoints,
} from "@/lib/usage-charts";
import {
  clientModelTotals,
  combinedFormula,
  combinedTotal,
  dailyTotalsMap,
  dimTotals,
  endpointKey,
  gatewayDailyInWindow,
  ledgerDailySeries,
  mergeDims,
  mergeRecons,
  modelKey,
  overlapInWindow,
  type UsageLedger,
} from "@/lib/usage-ledger";
import { usageWindowDays } from "@/lib/usage-window";

/** 本页承载的视图（积分视图在 `CreditStatsPage`）。 */
export type TokenUsageView = "trend" | "sessions" | "keys";

/**
 * 「按密钥」视图**只取展示名**：用量来自网关账本（本页已取的 `dim`），
 * 不再读请求日志 —— 那是环形缓冲，窗口对齐不了（见 `src/lib/key-usage.ts`）。
 * 模块级函数 ⇒ 引用稳定（`KeysView` 的 `useEffect` 依赖它）。
 */
async function loadWbKeyNames() {
  const keys = await api.listApiKeys().catch(() => ({ keys: [] as ApiKeyRecord[] }));
  return new Map((keys.keys ?? []).map((key) => [key.id, key.name] as const));
}

/** 会话级缓存：切走再切回不重取（与 `CreditStatsPage` 同一约定）。 */
const statisticsCache: Partial<Record<RegionFilter, TokenStatistics>> = {};

/**
 * 网关逐日趋势的**分 region 缓存**（与 `statisticsCache` 同约定）。
 *
 * 值可以是 `null`（该 region 没有落库历史 / 读取失败）—— 缓存 `null` 与「没取过」
 * 用 `has` 区分，避免每次切回都重发一次注定失败的请求。
 */
const gatewayTrendCache = new Map<RegionFilter, GatewayTokenTrend | null>();

/** 视图为空时的统一空态（四要素：icon + title + description + 出口）。 */
function ViewEmpty({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: typeof MessagesSquare;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      action={
        <Button size="sm" variant="outline" onClick={onAction}>
          {actionLabel}
        </Button>
      }
    />
  );
}

/* ────────────────────────────── 趋势 ────────────────────────────── */

function TrendView({
  source,
  viewWindow,
  onViewWindowChange,
  gatewayTrend,
  dim,
  recon,
  ledger,
}: {
  source: TokenStatsSource;
  viewWindow: UsageWindow;
  onViewWindowChange: (next: UsageWindow) => void;
  gatewayTrend: GatewayTokenTrend | null;
  dim: GatewayUsageDim | null;
  recon: GatewayUsageRecon | null;
  ledger: UsageLedger;
}) {
  const t = useT();
  const windowLabel = useUsageWindowLabel();
  const keys = useMemo(() => calendarWindowKeys(viewWindow), [viewWindow]);

  /* 两本账的逐日值：客户端来自 `source.daily`，网关来自 `get_gateway_token_trend`。 */
  const clientDaily = useMemo(() => dailyTotalsMap(source.daily), [source.daily]);
  const gatewayDaily = useMemo(
    () => new Map(gatewayDailyInWindow(gatewayTrend, viewWindow).map((day) => [day.key, day.total])),
    [gatewayTrend, viewWindow],
  );
  const columns = useMemo(
    () =>
      ledgerDailySeries({
        days: keys.map((key) => ({ key, total: 0 })),
        clientTotals: clientDaily,
        gatewayTotals: gatewayDaily,
        ledger,
        labelOf: (key) => key.slice(5).replace("-", "/"),
      }),
    [keys, clientDaily, gatewayDaily, ledger],
  );
  /* 每日 Token 图的**独立**窗口（默认本月）—— 与页面参数条互不干扰。
     ⚠️ 必须从**原始按天数据**独立构造（clientDaily / gatewayDaily），
     不能过滤全局的  —— 那是按全局窗口生成的键，全局选「今天」时
     它只有一根柱子，独立筛选选本月也变不出别的天。
     轴最短 7 天：即使窗口（或数据）只有今天，也从最后一天向前补足一周，
     否则单根柱子读不出「节奏」。 */
  const [dailyRange, setDailyRange] = useState<UsageWindow>({ kind: "month" });
  const modelColumns = useMemo(() => {
    let dailyKeys = usageWindowKeys(dailyRange);
    if (dailyRange.kind === "month") {
      /* 「本月」在月初只有一天；若像以前那样**向前**补 7 天，轴就变成上周的日期，
         看起来和「本周」一模一样。改为**向后**铺满整月 —— 未来日期留空，
         语义才是「本月」，且会随日子推进自然填满。 */
      const [year, month] = dailyKeys[0].split("-").map(Number);
      const daysInMonth = new Date(year, month, 0).getDate();
      dailyKeys = Array.from({ length: daysInMonth }, (_, index) =>
        `${year}-${String(month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
      );
    } else if (dailyRange.kind === "today" && dailyKeys.length < 7) {
      /* 只有「今天」才补足一周：单根柱子读不出节奏，而补足到过去几天不会误读成别的档位。 */
      const endTime = new Date(`${dailyKeys[dailyKeys.length - 1]}T00:00:00`).getTime();
      dailyKeys = Array.from({ length: 7 }, (_, index) =>
        dateKey(new Date(endTime - (6 - index) * 86_400_000)),
      );
    }
    return ledgerDailySeries({
      days: dailyKeys.map((key) => ({ key, total: 0 })),
      clientTotals: clientDaily,
      gatewayTotals: gatewayDaily,
      ledger,
      labelOf: (key) => key.slice(5).replace("-", "/"),
    });
  }, [dailyRange, clientDaily, gatewayDaily, ledger]);

  const [rates, setRates] = useState(loadRates);
  const cost = useMemo(() => {
    const windowKeys = new Set(usageWindowKeys(viewWindow));
    const hourly = source.hourlyByModel;
    if (hourly && Object.keys(hourly).length > 0) {
      let sum = 0;
      for (const [model, points] of Object.entries(hourly)) {
        const rate = rateOf(rates, model);
        for (const point of points) {
          const parts = point.key.split("-");
          if (!windowKeys.has(parts.slice(0, 3).join("-"))) continue;
          const hour = Number(parts[3]);
          if (!Number.isFinite(hour)) continue;
          const bundle: TokenBundle = {
            input: Math.max(0, point.uncachedInput),
            output: point.output,
            cacheRead: point.cacheRead,
            cacheWrite: point.cacheWrite,
          };
          // 该模型开了峰谷且当前小时在高峰时段（周一~五 9-12 / 14-18）⇒ 峰值卡。
          const dateKey = parts.slice(0, 3).join("-");
          const side = rate.peakEnabled && isPeakSlot(dateKey, hour) ? "peak" : "off";
          sum += costOf(bundle, rate, side);
        }
      }
      return sum;
    }
    /* 回落一：无逐小时明细但有逐日明细 ⇒ **窗口内**的逐日用量 × 非峰价。
       早先这里直接用全量 `source.models`，等效花费就不随窗口变化了。 */
    const dailyByModel = source.dailyByModel ?? {};
    if (Object.keys(dailyByModel).length > 0) {
      let sum = 0;
      for (const [model, points] of Object.entries(dailyByModel)) {
        const rate = rateOf(rates, model);
        for (const point of points) {
          if (!windowKeys.has(point.key)) continue;
          sum += costOf(
            {
              input: Math.max(0, point.uncachedInput),
              output: point.output,
              cacheRead: point.cacheRead,
              cacheWrite: point.cacheWrite,
            },
            rate,
            "off",
          );
        }
      }
      return sum;
    }
    /* 回落二（最老后端）：连逐日都没有 ⇒ 只能按模型全量 × 非峰价。 */
    return source.models.reduce(
      (sum, model) =>
        sum +
        costOf(
          {
            input: Math.max(0, model.uncachedInput),
            output: model.output,
            cacheRead: model.cacheRead,
            cacheWrite: model.cacheWrite,
          },
          rateOf(rates, model.key),
        ),
      0,
    );
  }, [source, rates, viewWindow]);

  const sumOf = (map: Map<string, number>) => keys.reduce((sum, key) => sum + (map.get(key) ?? 0), 0);
  const clientTokens = sumOf(clientDaily);
  const gatewayTokens = sumOf(gatewayDaily);
  const overlap = useMemo(() => overlapInWindow(recon, clientTokens), [recon, clientTokens]);
  const combined = combinedTotal(clientTokens, gatewayTokens, overlap);
  const formula = useMemo(() => {
    const parts = combinedFormula({
      clientTokens,
      gatewayTokens,
      overlapTokens: overlap,
      verdict: recon?.verdict ?? null,
    });
    return parts.kind === "subset"
      ? t("wbStats.usage.trend.formulaSubset", {
          gateway: compactTokens(gatewayTokens),
          direct: compactTokens(parts.directClientTokens),
        })
      : t("wbStats.usage.trend.formulaAdditive", {
          client: compactTokens(clientTokens),
          gateway: compactTokens(gatewayTokens),
          overlap: compactTokens(parts.overlapTokens),
        });
  }, [clientTokens, gatewayTokens, overlap, recon?.verdict, t]);

  const visibleTotal = ledger === "client" ? clientTokens : ledger === "gateway" ? gatewayTokens : combined;
  const total = visibleTotal;
  const dailyTotals = columns.map((column) => column.total);
  const peak = Math.max(0, ...dailyTotals);
  const average = Math.round(total / usageWindowDays(viewWindow));

  /* ★ 窗口内的分项合计。
     `source.summary` 是 **全量**（`mergeSources` 不按窗口切），而总量 / 日均 / 峰值 /
     请求数都读窗口值 —— 早先「输入 / 输出 / 命中率」三张卡直接读 `source.summary`，
     于是同一排卡片里并存两套口径（实测「输入 1.11 亿」比「总量 3324 万」还大）。
     这里统一从 `daily` 按窗口重算，与请求数同一个数据源。 */
  const windowSummary = useMemo(() => {
    const inWindow = new Set(keys);
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let uncachedInput = 0;
    let records = 0;
    let credit = 0;
    for (const point of source.daily) {
      if (!inWindow.has(point.key)) continue;
      input += point.input ?? 0;
      output += point.output ?? 0;
      cacheRead += point.cacheRead ?? 0;
      cacheWrite += point.cacheWrite ?? 0;
      uncachedInput += point.uncachedInput ?? 0;
      records += point.records ?? 0;
      credit += point.credit ?? 0;
    }
    return { input, output, cacheRead, cacheWrite, uncachedInput, records, credit };
  }, [source.daily, keys]);

  const rangeRecords = windowSummary.records;
  const filtered = source.summary.records > 0 && rangeRecords === 0 && gatewayTokens === 0;

  /* 模型占比：**按单本账各画一个环**（跨账本合并占比的分母含重复计数，是假的）。 */
  const clientSlices = useMemo(
    () =>
      clientModelTotals(source, viewWindow).map((model) => ({
        name: model.name,
        value: model.tokens,
        spark: [],
      })),
    [source, viewWindow],
  );
  /* 每模型在**当前窗口**内的四档明细（输入 / 缓存读 / 缓存写 / 输出 + 命中率）：
     `dailyByModel` 的点是完整 Totals，按窗口过滤求和即可 —— 模型页签删掉后
     这些只有占比卡的图例看得到。 */
  const modelDetails = useMemo(() => {
    const keys = new Set(usageWindowKeys(viewWindow));
    const map: Record<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number; hitRate: number | null }
    > = {};
    for (const [model, points] of Object.entries(source.dailyByModel ?? {})) {
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      for (const point of points) {
        if (!keys.has(point.key)) continue;
        input += point.uncachedInput;
        output += point.output;
        cacheRead += point.cacheRead;
        cacheWrite += point.cacheWrite;
      }
      const denom = input + cacheRead;
      map[model] = {
        input,
        output,
        cacheRead,
        cacheWrite,
        hitRate: denom > 0 ? cacheRead / denom : null,
      };
    }
    return map;
  }, [source, viewWindow]);
  const gatewaySlices = useMemo(
    () =>
      dimTotals(dim, viewWindow, modelKey)
        .filter((model) => model.tokens > 0)
        .map((model) => ({ name: model.key || t("wbStats.usage.models.unknown"), value: model.tokens, spark: [] })),
    [dim, viewWindow, t],
  );

  if (filtered) {
    return (
      <ViewEmpty
        icon={MessagesSquare}
        title={t("wbStats.usage.empty.filtered")}
        description={t("wbStats.usage.empty.filteredHint")}
        actionLabel={t("wbStats.usage.empty.viewAll")}
        onAction={() => onViewWindowChange({ kind: "month" })}
      />
    );
  }

  const totalTile: StatTile =
    ledger === "gateway"
      ? {
          icon: Server,
          label: t("wbStats.usage.trend.totalGateway"),
          value: compactTokens(gatewayTokens),
          hint: windowLabel(viewWindow),
          title: t("wbStats.usage.trend.totalGatewayTitle"),
        }
      : ledger === "client"
        ? {
            icon: MessagesSquare,
            label: t("wbStats.usage.trend.totalClient"),
            value: compactTokens(clientTokens),
            hint: windowLabel(viewWindow),
            title: t("wbStats.usage.trend.totalClientTitle"),
          }
        : {
            icon: MessagesSquare,
            label: t("wbStats.usage.trend.totalCombined"),
            value: `≈ ${compactTokens(combined)}`,
            hint: formula,
            title: t("wbStats.usage.trend.totalCombinedTitle"),
          };

  const modelCount =
    ledger === "gateway" ? gatewaySlices.length : ledger === "client" ? clientSlices.length : clientSlices.length + gatewaySlices.length;

  /* 缓存命中率的分母（分子 = cacheRead）：与后端 `recompute_cache_hit_rate` 同式。 */
  const cacheHitDenominator = windowSummary.cacheRead + windowSummary.uncachedInput;

  /* 等效花费：按「模型 × 单价表」折算成人民币。
     后端的 input 已含缓存命中，所以普通输入要减掉 read，否则缓存部分被算两次。 */

  const tiles: StatTile[] = [
    totalTile,
    {
      icon: ArrowDownToLine,
      label: t("wbStats.usage.trend.input"),
      /* 显示**含缓存读**的输入：后端 `total = input + output + write`，其中 `input`
         已含缓存读。若这里给 `uncachedInput`，「输入 + 输出」永远加不出总量
         （实测 128 万 + 1257 万 ≠ 3324 万）。缓存部分在 hint 里单独标出。 */
      value: compactTokens(windowSummary.input),
      hint: t("wbStats.usage.trend.inputHintCached", {
        cached: compactTokens(windowSummary.cacheRead),
      }),
    },
    {
      icon: ArrowUpFromLine,
      label: t("wbStats.usage.trend.output"),
      value: compactTokens(windowSummary.output),
      hint: t("wbStats.usage.trend.outputHint"),
    },
    {
      icon: Percent,
      label: t("wbStats.usage.trend.cacheRate"),
      /* ⚠️ 不读 `summary.cacheHitRate`：它是**比例字段**，早先 `addTotals` 合并时
         无条件置 null ⇒ 只要走了合并（多来源）这卡就恒为「—」，而分母字段
         （cacheRead / uncachedInput）一直是健全的。直接现算，与模型图例同式。 */
      value:
        cacheHitDenominator > 0
          ? `${((windowSummary.cacheRead / cacheHitDenominator) * 100).toFixed(1)}%`
          : "—",
      hint: t("wbStats.usage.trend.cacheRateHint"),
    },
    { icon: TrendingUp, label: t("wbStats.usage.trend.avg"), value: compactTokens(average), hint: t("wbStats.usage.trend.avgHint") },
    { icon: Gauge, label: t("wbStats.usage.trend.peak"), value: compactTokens(peak) },
    { icon: Server, label: t("wbStats.usage.trend.models"), value: exactTokens(modelCount) },
    {
      icon: MessagesSquare,
      label: t("wbStats.usage.trend.requests"),
      value: exactTokens(
        ledger === "gateway"
          ? dimTotals(dim, viewWindow, endpointKey).reduce((sum, row) => sum + row.requests, 0)
          : rangeRecords,
      ),
      hint: t("wbStats.usage.trend.requestsHint"),
    },
  ];

  return (
    <div className="min-w-0 space-y-6">
      {/* 插件式指标条：左侧一个超大费用数（回答「这相当于花了多少钱」），
          右上角单价设置入口，右侧其余小卡。 */}
      <div className="flex min-w-0 flex-wrap items-stretch gap-3">
        <div className="flex min-w-[190px] flex-col justify-center rounded-xl border bg-card px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">
              {t("wbStats.usage.trend.cost")}
            </span>
            <RateEditor
              models={source.models.map((model) => ({ name: model.key, tokens: model.total }))}
              onSaved={() => setRates(loadRates())}
            />
          </div>
          <span
            className="mt-1 text-[28px] font-semibold leading-8 tabular-nums text-foreground"
          >
            {formatCost(cost)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t("wbStats.usage.trend.costHint")}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <StatTiles tiles={tiles} ariaLabel={t("wbStats.usage.view.trend")} />
        </div>
      </div>
      {/* 每日 Token·按模型拆分：**独立筛选**（本月 / 上月 / 近半年 / 近一年 / 自定义），
          不跟随页面参数条 —— 这张图的价值恰恰是换个更大的跨度看节奏。 */}
      <div className="min-w-0 rounded-xl border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[13px] font-medium leading-5">
            {t("wbStats.usage.trend.stackedTitle")}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <div className="inline-flex rounded-full border border-border/70 bg-muted/40 p-0.5">
              {(
                [
                  ["month", "本月"],
                  ["lastMonth", "上月"],
                  ["half", "近半年"],
                  ["year", "近一年"],
                  ["custom", "自定义"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() =>
                    setDailyRange(
                      kind === "custom"
                        ? dailyRange.kind === "custom"
                          ? dailyRange
                          : {
                              kind: "custom",
                              from: usageWindowEarliestKey(),
                              to: usageWindowEarliestKey(),
                            }
                        : { kind },
                    )
                  }
                  className={`rounded-full px-2.5 py-1 transition-colors ${
                    dailyRange.kind === kind
                      ? "bg-primary/15 font-medium text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {dailyRange.kind === "custom" ? (
              <span className="flex items-center gap-1">
                <input
                  type="date"
                  value={dailyRange.from}
                  min={usageWindowEarliestKey()}
                  max={dailyRange.to}
                  onChange={(event) =>
                    setDailyRange({
                      kind: "custom",
                      from: event.target.value,
                      to: dailyRange.to,
                    })
                  }
                  className="h-7 rounded-md border border-border bg-card px-2 text-[11px] tabular-nums"
                />
                <span className="text-muted-foreground">—</span>
                <input
                  type="date"
                  value={dailyRange.to}
                  min={dailyRange.from}
                  max={todayKey()}
                  onChange={(event) =>
                    setDailyRange({
                      kind: "custom",
                      from: dailyRange.from,
                      to: event.target.value,
                    })
                  }
                  className="h-7 rounded-md border border-border bg-card px-2 text-[11px] tabular-nums"
                />
              </span>
            ) : null}
          </div>
        </div>
        {modelColumns.some((column) => column.total > 0) ? (
          <StackedDailyBar
            columns={modelColumns}
            palette={[LEDGER_CLIENT_COLOR, LEDGER_GATEWAY_COLOR]}
          />
        ) : (
          <p className="py-8 text-center text-xs text-muted-foreground">该时间范围内没有用量。</p>
        )}
      </div>
      {source.daily.length > 0 ? (
        <ChartFrame
          title="日历热力图"
          caption="每天一格，颜色深浅按窗口内活跃日的分位划分"
          ariaLabel="按天的用量日历热力图"
        >
          <CalendarHeatmap daily={source.daily} />
        </ChartFrame>
      ) : null}
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
      {/* 用量波浪：插件的中点平滑曲线。窗口 > 31 天时按周折叠，刻度最多 7 个。 */}
      <UsageWave daily={source.daily} />
        {ledger !== "gateway" && clientSlices.length > 0 ? (
          <ChartFrame
            title={t("wbStats.usage.trend.donutTitle")}
            caption={`${exactTokens(clientSlices.length)} · ${compactTokens(clientTokens)}`}
            ariaLabel={t("wbStats.usage.trend.donutTitle")}
            exportable={false}
          >
            <ModelDonut slices={clientSlices} details={modelDetails} size={150} />
          </ChartFrame>
        ) : null}
        {ledger !== "client" && gatewaySlices.length > 0 ? (
          <ChartFrame
            title={t("wbStats.usage.models.gatewayBook")}
            caption={`${exactTokens(gatewaySlices.length)} · ${compactTokens(gatewayTokens)}`}
            ariaLabel={t("wbStats.usage.models.gatewayBook")}
            exportable={false}
          >
            <ModelDonut slices={gatewaySlices} size={150} />
          </ChartFrame>
        ) : null}
      </div>
    </div>
  );
}

/* ────────────────────────────── 模型 ────────────────────────────── */

/* ────────────────────────────── 会话 ────────────────────────────── */

function SessionsView({
  source,
  viewWindow,
  ledger,
  onViewWindowChange,
  onRefresh,
  onSwitchLedger,
}: {
  source: TokenStatsSource;
  viewWindow: UsageWindow;
  dim: GatewayUsageDim | null;
  ledger: UsageLedger;
  onViewWindowChange: (next: UsageWindow) => void;
  onRefresh: () => void | Promise<void>;
  onSwitchLedger: (next: UsageLedger) => void;
}) {
  const t = useT();
  const windowLabel = useUsageWindowLabel();
  const { busy, run } = useRefreshAction();
  const points = useMemo(() => sessionPoints(source, viewWindow), [source, viewWindow]);
  const visible = useMemo(() => points.slice(0, SESSION_RENDER_LIMIT), [points]);
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const capNote =
    points.length > visible.length
      ? t("wbStats.usage.sessions.shownOf", { shown: visible.length, total: points.length })
      : null;

  if (points.length === 0) {
    const hasAnySession = source.sessions.some((session) => session.total > 0 || session.records > 0);
    if (hasAnySession) {
      return (
        <ViewEmpty
          icon={Users}
          title={t("wbStats.usage.empty.filtered")}
          description={t("wbStats.usage.empty.filteredHint")}
          actionLabel={t("wbStats.usage.empty.viewAll")}
          onAction={() => onViewWindowChange({ kind: "month" })}
        />
      );
    }
    return (
      <EmptyState
        icon={Users}
        title={t("wbStats.usage.empty.sessions")}
        description={t("wbStats.usage.empty.sessionsHint")}
        action={
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => onRefresh())}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t("wbStats.usage.empty.refresh")}
          </Button>
        }
      />
    );
  }

  const tiles: StatTile[] = [
    { icon: Users, label: t("wbStats.usage.sessions.count"), value: exactTokens(points.length), hint: windowLabel(viewWindow) },
    { icon: MessagesSquare, label: t("wbStats.usage.sessions.total"), value: compactTokens(total), hint: windowLabel(viewWindow) },
    { icon: Gauge, label: t("wbStats.usage.sessions.avg"), value: compactTokens(Math.round(total / points.length)) },
    { icon: TrendingUp, label: t("wbStats.usage.sessions.max"), value: compactTokens(points[0].value), hint: points[0].title },
  ];

  return (
    <div className="min-w-0 space-y-6">
      {ledger === "all" ? (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-[color:var(--data-series-indigo)]/25 bg-[color:var(--data-series-indigo)]/10 px-3.5 py-2.5 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0 text-[color:var(--data-series-indigo)]" />
          <span>
            {t("wbStats.usage.sessions.gatewayMissing")}
            {" · "}
            <button
              type="button"
              onClick={() => onSwitchLedger("gateway")}
              className="cursor-pointer border-b border-dotted border-current text-[color:var(--data-series-indigo)] hover:text-foreground"
            >
              {t("wbStats.usage.sessions.jumpGateway")}
            </button>
          </span>
        </div>
      ) : null}
      <StatTiles tiles={tiles} ariaLabel={t("wbStats.usage.view.sessions")} />
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <ChartFrame
          title={t("wbStats.usage.sessions.rankTitle")}
          caption={capNote ?? `${exactTokens(points.length)} · ${compactTokens(total)}`}
          ariaLabel={t("wbStats.usage.sessions.rankTitle")}
          exportable={false}
        >
          {/* 按账号：本 fork 新增维度（数据来自会话的 accountId）。 */}
          <AccountRanking sessions={source.sessions} viewWindow={viewWindow} />
          <SessionRanking points={visible} />
        </ChartFrame>
        <ChartFrame
          title={t("wbStats.usage.sessions.scatterTitle")}
          caption={`${scatterAxisCaption(t)} · ${t("wbStats.usage.sessions.scatterDesc")}${capNote ? ` · ${capNote}` : ""}`}
          ariaLabel={t("wbStats.usage.sessions.scatterAria")}
        >
          <SessionScatter points={visible} />
        </ChartFrame>
      </div>
    </div>
  );
}

/* ────────────────────────────── 页面 ────────────────────────────── */

export default function TokenStatsPage({
  view = "trend",
  viewWindow,
  combineAll,
  onViewWindowChange,
  refreshSeq = 0,
  ledger = "all",
  onLedgerChange,
}: { view?: TokenUsageView; ledger?: UsageLedger; onLedgerChange?: (next: UsageLedger) => void } & UsageViewProps) {
  const t = useT();
  const [scopeRegion] = useScope("workbuddy");
  const region: RegionFilter = combineAll ? "all" : scopeRegion;
  const [stats, setStats] = useState<TokenStatistics | null>(() => statisticsCache[region] ?? null);
  const [loading, setLoading] = useState(() => !statisticsCache[region]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  /* 页头「刷新统计」：序号变化 ⇒ 置一次「强制重扫」标记后重跑取数。
     ⚠️ 只重挂载不够：后端按 (mtime,size) 缓存，文件没变就会复用旧读数 ——
     而用户点刷新要的是「重新算一遍」这个动作本身。 */
  const forceNextRef = useRef(false);
  useEffect(() => {
    if ((refreshSeq ?? 0) <= 0) return;
    forceNextRef.current = true;
    setReload((value) => value + 1);
  }, [refreshSeq]);
  /* 三处「重试 / 刷新」出口（错误 Alert、两种空态）共用同一个 reload 触发 ⇒ 共用一个实例。 */
  const { busy: reloadBusy, run: runReload } = useRefreshAction();
  const [gatewayTrend, setGatewayTrend] = useState<GatewayTokenTrend | null>(
    () => gatewayTrendCache.get(region) ?? null,
  );
  const [dim, setDim] = useState<GatewayUsageDim | null>(null);
  const [recon, setRecon] = useState<GatewayUsageRecon | null>(null);

  // region 是页面级数据源：切换即重新取数；旧结果保留到新结果返回，避免闪白。
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    const force = forceNextRef.current;
    forceNextRef.current = false;
    api
      .getTokenStatistics(undefined, region, force)
      .then((result) => {
        if (disposed) return;
        statisticsCache[region] = result;
        setStats(result);
      })
      .catch((cause) => {
        if (!disposed) setError(api.asError(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    /* 网关逐日趋势与统计**并行**取（互不依赖）：单 region 命令，`all` 时前端分区取再合并
       （与 `mergeSources` 同哲学）。单区失败只让该区缺席（`.catch(() => null)`）——
       整条失败 ⇒  trend 为 null ⇒ 网关小图不渲染（渐进增强，不弹错噪屏）。
       ⚠️ 老服务端没有这条路由时会 404：同样按「不出图」处理，不影响主统计。 */
    const gatewayRegions: Region[] = region === "all" ? ["cn", "global"] : [region];
    Promise.all(
      gatewayRegions.map((gatewayRegion) =>
        api.getGatewayTokenTrend(gatewayRegion).catch(() => null),
      ),
    )
      .then((results) => {
        if (disposed) return;
        const merged = mergeGatewayTrends(results);
        gatewayTrendCache.set(region, merged);
        setGatewayTrend(merged);
      })
      .catch(() => {
        if (!disposed) setGatewayTrend(null);
      });
    /* 三维度历史：与趋势同源（`token_daily`），但它是**模型 / 账号 / 端点**的拆分。
       `all` 时分区取再合并（与 `mergeGatewayTrends` 同哲学）。 */
    Promise.all(
      gatewayRegions.map((gatewayRegion) => api.getGatewayUsageDim(gatewayRegion).catch(() => null)),
    )
      .then((results) => {
        if (!disposed) setDim(mergeDims(results));
      })
      .catch(() => {
        if (!disposed) setDim(null);
      });
    /* 对账：只覆盖今日（网关日志是环形窗口）。`all` 时两区各对一次再合并。 */
    Promise.all(
      gatewayRegions.map((gatewayRegion) => api.getUsageReconcile(gatewayRegion).catch(() => null)),
    )
      .then((results) => {
        if (!disposed) setRecon(mergeRecons(results));
      })
      .catch(() => {
        if (!disposed) setRecon(null);
      });
    return () => {
      disposed = true;
    };
  }, [region, reload]);

  const source = useMemo(() => (stats ? mergeSources(stats.sources) : null), [stats]);
  const hasSource = (stats?.sources.length ?? 0) > 0;
  /* 网关用量（`gatewayTrend`，扫 `gateway_logs`）是客户端（扫 `projects/*.jsonl`）
     之外的另一条记录源，按窗口取。 */
  const gatewayInWindow = useMemo(() => {
    const keys = new Set(calendarWindowKeys(viewWindow));
    return (gatewayTrend?.days ?? []).reduce(
      (sum, day) => (keys.has(day.key) ? sum + day.total : sum),
      0,
    );
  }, [gatewayTrend, viewWindow]);
  /**
   * 有来源但**两个数据源都翻不出用量** ⇒ 整页空态（区分于「被视图参数筛没」，后者在视图内处理）。
   *
   * ⚠️ 两侧口径**故意不对称**，勿强行统一：
   * - 网关侧按窗口判：`gatewayTrend` 含 90 天落库历史，不筛窗会把窗外历史算成
   *   「有数据」，而当前窗口其实为空。
   * - 客户端侧按全量判：`getTokenStatistics` 未按窗口传参（`days` 缺省 ⇒ 后端
   *   不加 cutoff），窗口内被筛没的由各视图自行展示 ⇒ 这里只需「有没有任何来源
   *   记录」来决定是否渲染页面，避免空态把可能有值的视图整片吞掉。 */
  const clientHasRecords = (source?.summary.records ?? 0) > 0;
  const trulyEmpty = Boolean(source) && !clientHasRecords && gatewayInWindow === 0;

  return (
    /* ⚠️ 页头 / 子 Tab / **视图参数条**都由**上层** `UsagePage` 统一渲染
       （原型 `viewUsage` 只有一个「用量」页头、一条参数条）⇒ 本页只渲染视图内容。
       `view` 决定画趋势 / 模型 / 会话哪一个。 */
    <div className="min-w-0">
      {error && (
        <Alert variant="destructive" className="mb-5">
          <CircleAlert />
          <AlertTitle>{t("wbStats.token.loadFailed")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{error}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={reloadBusy}
              onClick={() => void runReload(() => setReload((value) => value + 1))}
            >
              {reloadBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("wbStats.token.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && !stats ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : !hasSource || !source ? (
        <EmptyState
          icon={CircleAlert}
          title={t("wbStats.usage.empty.noSource")}
          description={t("wbStats.usage.empty.noSourceHint")}
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={reloadBusy}
              onClick={() => void runReload(() => setReload((value) => value + 1))}
            >
              {reloadBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("wbStats.usage.empty.refresh")}
            </Button>
          }
        />
      ) : trulyEmpty ? (
        <EmptyState
          icon={MessagesSquare}
          title={t("wbStats.usage.empty.noData")}
          description={t("wbStats.usage.empty.noDataHint")}
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={reloadBusy}
              onClick={() => void runReload(() => setReload((value) => value + 1))}
            >
              {reloadBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("wbStats.usage.empty.refresh")}
            </Button>
          }
        />
      ) : view === "keys" ? (
        <KeysView
          dim={dim}
          window={viewWindow}
          selfScope="wb"
          loadNames={loadWbKeyNames}
        />
      ) : view === "sessions" ? (
        <SessionsView
          source={source}
          viewWindow={viewWindow}
          dim={dim}
          ledger={ledger}
          onViewWindowChange={onViewWindowChange}
          onRefresh={() => setReload((value) => value + 1)}
          onSwitchLedger={() => onLedgerChange?.("gateway")}
        />
      ) : (
        <TrendView
          source={source}
          viewWindow={viewWindow}
          onViewWindowChange={onViewWindowChange}
          gatewayTrend={gatewayTrend}
          dim={dim}
          recon={recon}
          ledger={ledger}
        />
      )}
    </div>
  );
}
