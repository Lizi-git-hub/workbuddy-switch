
import { displayText } from "@/lib/display-text";
import { usageWindowKeys, type UsageWindow } from "@/lib/usage-window";
import type {
  CreditExpiry,
  CreditStatistics,
  GatewayTokenTrend,
  TokenStatsGroup,
  TokenStatsSource,
  TokenStatsTotals,
} from "@/lib/types";

/** 四视图标识（与原型 `tabs` 一一对应）。 */
export type UsageView = "trend" | "models" | "sessions" | "credits";

/** 趋势 · 堆叠柱：一天一列，`segments` 之和 === `total`（契约 1）。 */
export interface DailyModelColumn {
  /** ISO 日期。 */
  day: string;
  /** 轴短标签（MM/DD）。 */
  label: string;
  total: number;
  /** 末段吃舍入余数，保证求和 === total。 */
  segments: { name: string; value: number }[];
}

/** 趋势 · 热力图：7 行（周一..周日）× 24 列。 */
export interface HeatmapMatrix {
  rows: 7;
  cols: 24;
  /** `[weekday][hour]`，缺失补 0。 */
  cells: number[][];
  /** 用于相对强度着色（非绝对量）。 */
  max: number;
}

/** 模型：占比 + 迷你趋势线（契约 3 / 7）。 */
export interface ModelSlice {
  name: string;
  value: number;
  /** 逐日序列（`dailyByModel`）；后端未提供时为空数组。 */
  spark: number[];
}

/** 会话：散点。x 是**记录数**不是「消息数」（见文件头注释）。 */
export interface SessionPoint {
  id: string;
  title: string;
  /** records。 */
  x: number;
  /** total tokens。 */
  y: number;
  value: number;
}

export interface CreditDailyBar {
  /** 轴短标签（`MM/DD`）。 */
  label: string;
  /** 本地日期键 `YYYY-MM-DD` —— 窗口切片要靠它，**不能**靠 `label`。 */
  date: string;
  inAmt: number;
  outAmt: number;
}

/** 积分：余额曲线点（`value` 回推；`baseline` 非 0）。 */
export interface BalancePoint {
  label: string;
  value: number;
  baseline: number;
}

/** 积分：到期分布（完整 30 天）。 */
export interface ExpiryBucket {
  /** 1..30。 */
  day: number;
  value: number;
}

/** 堆叠柱 / 环形在「无模型明细」时使用的哨兵名，由渲染层翻译。 */
export const TOTAL_SEGMENT = "__total__";

/**
 * 网关逐日图的**哨兵段名**（单段柱），由渲染层翻成「网关」。
 *
 * 为什么是哨兵而不是直接穿文案：系列名会进 `ChartConfig` 的键与 legend，
 * 穿本地化字符串进去等于让**数据带语言**（与模型名保持 id 的做法分叉）。
 */
export const GATEWAY_SEGMENT = "__gateway__";

/** 一天毫秒数。⚠️ 只用于「按天回推日期键」这类**整除**场景；
 *  「窗口内有几天」一律走 `usageWindowKeys`（夏令时那天不是 24 小时）。 */
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyTotals(): TokenStatsTotals {
  return {
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    uncachedInput: 0,
    records: 0,
    cacheHitRate: null,
    credit: 0,
  };
}

function addTotals(a: TokenStatsTotals, b: TokenStatsTotals): TokenStatsTotals {
  /* ⚠️ cacheHitRate 是**比例字段**，不能跟着白名单相加 —— 早先这里无条件置 null，
     结果只要走了合并（多来源 / mergeGroup 的每一条分组），summary 与各分组的
     命中率就全部变「—」，而单来源页面看起来正常（与下方 credit 是同一类坑）。
     正确做法与后端 `merge_summary` / `recompute_cache_hit_rate` 一致：
     按**合并后的分子分母**重算 `cacheRead / (cacheRead + uncachedInput)`。 */
  const cacheRead = a.cacheRead + b.cacheRead;
  const uncachedInput = a.uncachedInput + b.uncachedInput;
  const hitDenominator = cacheRead + uncachedInput;
  return {
    total: a.total + b.total,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    uncachedInput,
    records: a.records + b.records,
    cacheHitRate: hitDenominator > 0 ? cacheRead / hitDenominator : null,
    credit: (a.credit ?? 0) + (b.credit ?? 0),
  };
}

/**
 * 合并两个分组的**逐日拆分**（`sessions[].daily`）。
 *
 * 两版（如 cn + global 的同名源）各自的逐日必须**按日求和**；任何一侧缺字段
 * （旧后端）就原样保留另一侧 —— 不得凭「有/无」把已有数据丢掉。
 */
function mergeDayList(
  base?: TokenStatsGroup[],
  extra?: TokenStatsGroup[],
): TokenStatsGroup[] | undefined {
  if (!base) return extra;
  if (!extra) return base;
  const map = new Map<string, TokenStatsGroup>();
  for (const group of base) map.set(group.key, { ...group });
  for (const group of extra) {
    const current = map.get(group.key);
    map.set(group.key, current ? addGroup(current, group) : { ...group });
  }
  return [...map.values()];
}

function addGroup(a: TokenStatsGroup, b: TokenStatsGroup): TokenStatsGroup {
  return {
    ...addTotals(a, b),
    key: a.key,
    title: a.title ?? b.title ?? null,
    project: a.project ?? b.project,
    sessionId: a.sessionId ?? b.sessionId,
    // 逐日拆分同样要合并（`sessions[].daily`）；缺字段时保留存在的那侧。
    daily: mergeDayList(a.daily, b.daily),
  };
}

/** 按 `key` 合并分组（数值求和），按 `total` 降序。 */
function mergeGroups(list: TokenStatsGroup[]): TokenStatsGroup[] {
  const map = new Map<string, TokenStatsGroup>();
  for (const group of list) {
    const current = map.get(group.key);
    map.set(group.key, current ? addGroup(current, group) : { ...group });
  }
  return [...map.values()].sort((left, right) => right.total - left.total);
}

function minDefined(values: (number | null | undefined)[]): number | null {
  const defined = values.filter((value): value is number => typeof value === "number");
  return defined.length ? Math.min(...defined) : null;
}

function maxDefined(values: (number | null | undefined)[]): number | null {
  const defined = values.filter((value): value is number => typeof value === "number");
  return defined.length ? Math.max(...defined) : null;
}

function emptySource(): TokenStatsSource {
  return {
    source: "workbuddy",
    summary: emptyTotals(),
    models: [],
    projects: [],
    sessions: [],
    daily: [],
    dailyByModel: {},
    hours: [],
    filesScanned: 0,
    parseErrors: 0,
    coverageStartAt: null,
    coverageEndAt: null,
  };
}

export function mergeSources(sources: TokenStatsSource[]): TokenStatsSource {
  if (sources.length === 0) return emptySource();
  if (sources.length === 1) return sources[0];

  const summary = sources.reduce((acc, source) => addTotals(acc, source.summary), emptyTotals());

  /** `dailyByModel` / `hourlyByModel` 同构：模型 → 逐日(逐小时)点，按 key 求和合并。 */
  const mergeModelSeries = (
    pick: (source: TokenStatsSource) => Record<string, TokenStatsGroup[]> | undefined,
  ): Record<string, TokenStatsGroup[]> => {
    const byModel = new Map<string, Map<string, TokenStatsGroup>>();
    for (const source of sources) {
      for (const [model, points] of Object.entries(pick(source) ?? {})) {
        let dayMap = byModel.get(model);
        if (!dayMap) {
          dayMap = new Map<string, TokenStatsGroup>();
          byModel.set(model, dayMap);
        }
        for (const point of points) {
          const current = dayMap.get(point.key);
          dayMap.set(point.key, current ? addGroup(current, point) : { ...point });
        }
      }
    }
    const merged: Record<string, TokenStatsGroup[]> = {};
    for (const [model, dayMap] of byModel) {
      merged[model] = [...dayMap.values()].sort((left, right) =>
        left.key.localeCompare(right.key),
      );
    }
    return merged;
  };

  const dailyByModel = mergeModelSeries((source) => source.dailyByModel);
  /* ⚠️ hourlyByModel 也要合并：漏掉它，多来源合并后前端拿不到逐小时明细，
     等效花费就会退回「全量模型表」口径 —— 不随窗口变化（实测正是这个症状）。 */
  const hourlyByModel = mergeModelSeries((source) => source.hourlyByModel);

  return {
    source: sources[0].source,
    summary,
    models: mergeGroups(sources.flatMap((source) => source.models)),
    projects: mergeGroups(sources.flatMap((source) => source.projects)),
    sessions: mergeGroups(sources.flatMap((source) => source.sessions)),
    daily: mergeGroups(sources.flatMap((source) => source.daily)).sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
    dailyByModel,
    hourlyByModel,
    hours: mergeGroups(sources.flatMap((source) => source.hours)),
    filesScanned: sources.reduce((sum, source) => sum + source.filesScanned, 0),
    parseErrors: sources.reduce((sum, source) => sum + source.parseErrors, 0),
    coverageStartAt: minDefined(sources.map((source) => source.coverageStartAt)),
    coverageEndAt: maxDefined(sources.map((source) => source.coverageEndAt)),
  };
}

export function calendarWindowKeys(window: UsageWindow, now: number = Date.now()): string[] {
  return usageWindowKeys(window, now);
}

function lastDays(daily: TokenStatsGroup[], window: UsageWindow): TokenStatsGroup[] {
  const byKey = new Map(daily.map((point) => [point.key, point]));
  // 缺失日补 0（`records: 0`）—— 这是「当天确实没有记录」，不是「读不到」。
  // 补的是**零值分组**，各分项字段一并归零，避免下游读到 `undefined`。
  return usageWindowKeys(window).map((key) => byKey.get(key) ?? emptyDay(key));
}

/** 一个「当天无记录」的零值日（补 0 用；字段与 `TokenStatsGroup` 严格同形）。 */
function emptyDay(key: string): TokenStatsGroup {
  return {
    key,
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    uncachedInput: 0,
    records: 0,
    cacheHitRate: null,
  };
}

export function dateAxisLabel(date: string): string {
  return date.length >= 10 ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : date;
}

/**
 * 趋势 · 每日按模型堆叠柱（契约 1：每列分段之和 === 当日总量）。
 *
 * 模型来自 `dailyByModel`；某天某模型的缺失值补 0。若某天**没有**模型明细
 * （旧后端 / 无 `dailyByModel`），退化为单段（哨兵 `TOTAL_SEGMENT`）。
 */
export function dailyModelSeries(source: TokenStatsSource, window: UsageWindow): DailyModelColumn[] {
  const days = lastDays(source.daily, window);
  if (days.length === 0) return [];

  const dailyByModel = source.dailyByModel ?? {};
  const lookup = new Map<string, Map<string, number>>();
  const modelTotals = new Map<string, number>();
  for (const [model, points] of Object.entries(dailyByModel)) {
    const byDate = new Map<string, number>();
    for (const point of points) byDate.set(point.key, point.total);
    lookup.set(model, byDate);
    let sum = 0;
    for (const day of days) sum += byDate.get(day.key) ?? 0;
    modelTotals.set(model, sum);
  }
  const orderedModels = [...modelTotals.entries()]
    .filter(([, total]) => total > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([model]) => model);

  return days.map((day) => {
    const segments = orderedModels.map((name) => ({
      name,
      value: lookup.get(name)?.get(day.key) ?? 0,
    }));
    if (segments.length === 0) {
      return {
        day: day.key,
        label: dateAxisLabel(day.key),
        total: day.total,
        segments: day.total > 0 ? [{ name: TOTAL_SEGMENT, value: day.total }] : [],
      };
    }
    const sum = segments.reduce((acc, segment) => acc + segment.value, 0);
    const remainder = day.total - sum;
    if (remainder !== 0) {
      const last = segments[segments.length - 1];
      last.value = Math.max(0, last.value + remainder);
    }
    return { day: day.key, label: dateAxisLabel(day.key), total: day.total, segments };
  });
}

/**
 * 趋势 · **网关**逐日柱（与主堆叠柱同窗对齐；复用 {@link StackedDailyBar} 渲染）。
 *
 * ## 为什么不并进主堆叠柱（`dailyModelSeries`）
 *
 * ① 主柱的「末柱 = 概览统计块 = 账号卡今日合计」是**跨视图一致性契约**，
 *    把网关量并进去会静默改变那个口径（老用户的首屏数字全变）；
 * ② 客户端与网关是**两条独立记录**（配置重叠时同一请求两处各记一次），
 *    求和会让重复计数**看不见** —— 卡片至少在明细里披露，图不能比卡片更不诚实。
 *
 * ## 未记录日怎么画
 *
 * `trend.days` **只含落库日**（App 运行过 + 后台记录在跑）⇒ 缺日是「未记录」而**不是 0**。
 * 这里给缺日**空分段**（不画柱）而不是 0 段：两者视觉相同，但覆盖率由
 * {@link gatewayCoverage} 单独给出、由图注披露 —— 「没有可画的值」与「当天没用量」
 * 必须能区分。
 */
export function gatewayDailyColumns(
  trend: GatewayTokenTrend | null,
  window: UsageWindow,
): DailyModelColumn[] {
  if (!trend) return [];
  const byDate = new Map(trend.days.map((point) => [point.key, point]));
  return usageWindowKeys(window).map((key) => {
    const point = byDate.get(key);
    return {
      day: key,
      label: dateAxisLabel(key),
      total: point?.total ?? 0,
      segments: point && point.total > 0 ? [{ name: GATEWAY_SEGMENT, value: point.total }] : [],
    };
  });
}

/**
 * 网关趋势在窗口内的**覆盖率**（图注披露用）。
 *
 * - `recorded`：窗口内**有落库记录**的天数（含 gateway 量为 0 的 —— 那是**真实 0**）；
 * - `truncated`：其中有几天标了「可能被裁」（那些天的值是**下界**）；
 * - `total`：窗口天数。
 */
export function gatewayCoverage(
  trend: GatewayTokenTrend | null,
  window: UsageWindow,
): { recorded: number; total: number; truncated: number } {
  if (!trend) return { recorded: 0, total: 0, truncated: 0 };
  const byDate = new Map(trend.days.map((point) => [point.key, point]));
  let recorded = 0;
  let truncated = 0;
  const keys = usageWindowKeys(window);
  for (const key of keys) {
    const point = byDate.get(key);
    if (!point) continue;
    recorded += 1;
    if (point.truncated) truncated += 1;
  }
  return { recorded, total: keys.length, truncated };
}

/**
 * 合并两个 region 的网关趋势（`region === "all"` 时前端求和）。
 *
 * 与 {@link mergeSources} 同哲学：**合并作用域是前端的事**，后端命令保持单 region。
 * 同一天两区都有记录时逐字段求和；`truncated` 取**或**（任一侧可能是下界就是下界）。
 */
export function mergeGatewayTrends(
  trends: readonly (GatewayTokenTrend | null)[],
): GatewayTokenTrend | null {
  const present = trends.filter((trend): trend is GatewayTokenTrend => Boolean(trend));
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  const byDate = new Map<string, GatewayTokenTrend["days"][number]>();
  for (const trend of present) {
    for (const point of trend.days) {
      const current = byDate.get(point.key);
      if (!current) {
        byDate.set(point.key, { ...point });
        continue;
      }
      current.input += point.input;
      current.output += point.output;
      current.total += point.total;
      current.truncated = current.truncated || point.truncated;
    }
  }
  const days = [...byDate.values()].sort((left, right) => left.key.localeCompare(right.key));
  return {
    date: present[0].date,
    retentionDays: present[0].retentionDays,
    days,
    total: days.reduce((sum, point) => sum + point.total, 0),
  };
}

/**
 * 趋势 · 7×24 热力图（契约 2）。
 *
 * 从 `hours` 的 `"{weekday}-{hour}"` key 还原；非法 key 忽略，缺失格补 0。
 */
export function heatmapMatrix(hours: readonly { key?: string | null; total: number }[]): HeatmapMatrix {
  const cells: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const group of hours) {
    const [weekdayRaw, hourRaw] = (group.key ?? "").split("-");
    const weekday = Number.parseInt(weekdayRaw, 10);
    const hour = Number.parseInt(hourRaw, 10);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    cells[weekday][hour] += group.total;
  }
  const max = Math.max(1, ...cells.flat());
  return { rows: 7, cols: 24, cells, max };
}

/** 把某模型的逐日序列对齐到 `days` 的日期窗口。 */
function alignSeries(series: TokenStatsGroup[], days: TokenStatsGroup[]): number[] {
  const byDate = new Map(series.map((point) => [point.key, point.total]));
  return days.map((day) => byDate.get(day.key) ?? 0);
}

export function modelSlices(source: TokenStatsSource, window: UsageWindow): ModelSlice[] {
  const days = lastDays(source.daily, window);
  const dailyByModel = source.dailyByModel ?? {};
  const slices: ModelSlice[] = Object.keys(dailyByModel).map((name) => {
    const series = dailyByModel[name];
    const spark = days.length > 0 ? alignSeries(series, days) : [];
    return { name, value: spark.reduce((acc, item) => acc + item, 0), spark };
  });
  return slices.filter((slice) => slice.value > 0).sort((left, right) => right.value - left.value);
}

export const SESSION_RENDER_LIMIT = 100;

export function sessionPoints(source: TokenStatsSource, window: UsageWindow): SessionPoint[] {
  const inWindow = new Set(usageWindowKeys(window));
  return source.sessions
    .map((session) => {
      if (!session.daily) return { session, total: session.total, records: session.records };
      let total = 0;
      let records = 0;
      for (const day of session.daily) {
        if (!inWindow.has(day.key)) continue;
        total += day.total;
        records += day.records;
      }
      return { session, total, records };
    })
    .filter(({ total, records }) => total > 0 || records > 0)
    .map(({ session, total, records }) => {
      const rawTitle = displayText(session.title);
      const title = rawTitle && rawTitle.trim().length > 0 ? rawTitle.trim() : session.key;
      return {
        id: session.key,
        title,
        x: records,
        y: total,
        value: total,
      };
    })
    .sort((left, right) => right.value - left.value);
}

export function creditDailyBars(stats: CreditStatistics, window: UsageWindow): CreditDailyBar[] {
  /* WB 的入账**不可得**（`events` 无金额字段）⇒ `inAmt` 恒 0，渲染层据此只画消耗侧。 */
  const byDate = new Map(stats.daily.map((point) => [point.date, point.usage]));
  return creditBars(
    usageWindowKeys(window).map((key) => ({ date: key, outAmt: byDate.get(key) ?? 0 })),
  );
}

/**
 * 积分 · 逐日收支（**两个数据源共用**）。
 *
 * `inAmt` 可选：WorkBuddy 的入账不可得（恒 0 ⇒ 渲染层画单向柱）；
 * Trae 的每日快照**两侧都有**（`earned` / `consumed`）⇒ 同一函数直接产出双向柱。
 * 共用的好处是**标签口径与排序只有一份**（各写一份必在补零 / 切位上分叉）。
 */
export function creditBars(
  points: readonly { date: string; outAmt: number; inAmt?: number }[],
): CreditDailyBar[] {
  return [...points]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((point) => ({
      label: dateAxisLabel(point.date),
      date: point.date,
      inAmt: point.inAmt ?? 0,
      outAmt: point.outAmt,
    }));
}

/**
 * 积分 · 余额曲线（**回推值**，基线**非 0**）。
 *
 * 后端无逐日余额快照 ⇒ 以 `currentRemaining` 为终值、按逐日净额回推
 * （`inAmt` 恒 0，故净额 = -消耗）。全部为 0 时返回空数组（**无数据不渲染**）。
 * `baseline = min - (max-min)*0.35`（同原型），恒 < min ⇒ 非 0（只要曲线有值）。
 */
export function balanceCurve(bars: CreditDailyBar[], currentRemaining: number): BalancePoint[] {
  if (bars.length === 0) return [];
  const net = bars.map((bar) => bar.inAmt - bar.outAmt);
  const totalNet = net.reduce((acc, value) => acc + value, 0);
  let balance = currentRemaining - totalNet;
  const values = net.map((value) => {
    balance += value;
    return Math.max(0, balance);
  });
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min && max === 0) return [];
  const baseline = Math.max(0, min - (max - min) * 0.35);
  return bars.map((bar, index) => ({ label: bar.label, value: values[index], baseline }));
}

/**
 * 积分 · 到期分布（契约 5：**完整 30 天轴**，无到期的天补 0）。
 *
 * 只统计未到期、且在未来 30 天内的资源；`day = ceil((expireAt - now) / 天)`，钳到 1..30。
 */
export function expiryBuckets(expiry: CreditExpiry, now: number = Date.now()): ExpiryBucket[] {
  const buckets: ExpiryBucket[] = Array.from({ length: 30 }, (_, index) => ({
    day: index + 1,
    value: 0,
  }));
  for (const resource of expiry.resources ?? []) {
    if (resource.expired) continue;
    if (resource.expireAt == null) continue;
    const diff = resource.expireAt - now;
    if (diff <= 0) continue;
    const day = Math.ceil(diff / DAY_MS);
    if (day < 1 || day > 30) continue;
    buckets[day - 1].value += resource.remaining;
  }
  return buckets;
}
