
/** 一天的毫秒数。 */
const DAY_MS = 86_400_000;

/** 一批到期：同一时刻到期的剩余积分之和。 */
export interface ExpiringBatch {
  /** 到期时刻（epoch 毫秒）。 */
  expireAt: number;
  /** 该批此刻的剩余积分之和。 */
  amount: number;
}

export interface ExpiringSummary {
  /** 窗口内全部临期剩余积分之和。 */
  total: number;
  /** 窗口内**最晚**到期时刻距今天数（向上取整，≥1）。 */
  days: number;
  /** 按到期时刻升序的逐批明细。 */
  batches: ExpiringBatch[];
}

/** 汇总入参：WorkBuddy 的 `CreditResource` 与 Trae 的 `TraeCreditPackage` 都满足它。 */
export interface ExpiringItem {
  remaining: number;
  expireAt: number | null;
  /** 后端标记：已到期。 */
  expired?: boolean;
  /**
   * 后端标记：临期（窗口见后端 `EXPIRING_SOON_SECS`，**14 天**）。
   * `undefined` 表示数据源没这个字段 ⇒ 视为未知、跳过。
   */
  expiringSoon?: boolean;
}

/**
 * 汇总临期积分。没有可渲染的临期批次时返回 `null`（调用方据此**整条不渲染**，
 * 绝不写一个猜出来的「N 天」标签）。
 *
 * @param items 积分包 / 积分资源列表（可为 `null`）
 * @param options.now 判定基准时刻（毫秒），默认 `Date.now()`
 *   —— 一次渲染里多处汇总应传同一个值，否则同一张卡会出现两个「今天」。
 * @param options.unit 入参 `expireAt` 的单位。**两个平台不同，必须显式给**：
 *   WorkBuddy 的 `CreditResource.expireAt` 是**毫秒**（后端 `parse_timestamp_ms`），
 *   Trae 的 `TraeCreditPackage.expireAt` 是**秒**（后端直接透传上游 `expire_time`）。
 */
export function summarizeExpiring(
  items: readonly ExpiringItem[] | null | undefined,
  options: { now?: number; unit?: "ms" | "s" } = {},
): ExpiringSummary | null {
  if (!items || items.length === 0) return null;
  const now = options.now ?? Date.now();
  const toMs = options.unit === "s" ? (value: number) => value * 1000 : (value: number) => value;

  /* 同一到期时刻合并成一批：上游可能把一次发放拆成多个包，逐包列会让 tooltip 变成流水账。 */
  const merged = new Map<number, number>();
  for (const item of items) {
    if (item.expired) continue;
    // `expiringSoon` 必须显式为 `true`：缺字段 = 未知，不当「临期」也不当「不临期」去推测窗口。
    if (item.expiringSoon !== true) continue;
    if (!Number.isFinite(item.remaining) || item.remaining <= 0) continue;
    if (typeof item.expireAt !== "number" || !Number.isFinite(item.expireAt)) continue;
    const expireAt = toMs(item.expireAt);
    if (!Number.isFinite(expireAt) || expireAt <= now) continue;
    merged.set(expireAt, (merged.get(expireAt) ?? 0) + item.remaining);
  }
  if (merged.size === 0) return null;

  const batches = [...merged.entries()]
    .map(([expireAt, amount]) => ({ expireAt, amount }))
    .sort((left, right) => left.expireAt - right.expireAt);
  const total = batches.reduce((sum, batch) => sum + batch.amount, 0);
  if (total <= 0) return null;

  const latest = batches[batches.length - 1].expireAt;
  return { total, days: Math.max(1, Math.ceil((latest - now) / DAY_MS)), batches };
}

/** 一批「未来到期」：同一时刻到期的剩余积分之和。 */
export interface UpcomingBatch {
  /** 到期时刻（epoch 毫秒）。 */
  expireAt: number;
  /** 该批此刻的剩余积分之和。 */
  amount: number;
}

/**
 * 所有**未来**到期批次：过滤「已过期 / 剩余 ≤ 0 / 无到期时刻 / 已到时刻」，
 * 按到期升序，**同一时刻合并**。
 *
 * @param options.now 判定基准时刻（毫秒），默认 `Date.now()`
 * @param options.unit 入参 `expireAt` 的单位（WB 毫秒 / Trae 秒）—— 同 `summarizeExpiring`。
 */
export function upcomingExpiries(
  items: readonly ExpiringItem[] | null | undefined,
  options: { now?: number; unit?: "ms" | "s" } = {},
): UpcomingBatch[] {
  if (!items || items.length === 0) return [];
  const now = options.now ?? Date.now();
  const toMs = options.unit === "s" ? (value: number) => value * 1000 : (value: number) => value;

  const merged = new Map<number, number>();
  for (const item of items) {
    if (item.expired) continue;
    if (!Number.isFinite(item.remaining) || item.remaining <= 0) continue;
    if (typeof item.expireAt !== "number" || !Number.isFinite(item.expireAt)) continue;
    const expireAt = toMs(item.expireAt);
    if (!Number.isFinite(expireAt) || expireAt <= now) continue;
    merged.set(expireAt, (merged.get(expireAt) ?? 0) + item.remaining);
  }

  return [...merged.entries()]
    .map(([expireAt, amount]) => ({ expireAt, amount }))
    .sort((left, right) => left.expireAt - right.expireAt);
}

/** 最近一批未来到期；没有未来到期返回 `null`（调用方据此**整条不渲染**）。 */
export function nearestExpiringBatch(
  items: readonly ExpiringItem[] | null | undefined,
  options: { now?: number; unit?: "ms" | "s" } = {},
): UpcomingBatch | null {
  return upcomingExpiries(items, options)[0] ?? null;
}

/** 距到期还有几天（向上取整，≥1）。 */
export function daysUntil(expireAt: number, now: number = Date.now()): number {
  return Math.max(1, Math.ceil((expireAt - now) / DAY_MS));
}

/* ══════════════════════ 渲染约束 ══════════════════════ */

export const EXPIRY_TIP_MAX_HEIGHT = "min(56vh, var(--radix-popper-available-height))";
