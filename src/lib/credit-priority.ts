
import type { CreditExpiry } from "@/lib/types";
import { nearestExpiringBatch } from "@/lib/credit-expiry";

/** 临期窗口内的剩余积分（查询失败 / 无数据按 0）。 */
export function expiringSoonAmount(credit?: CreditExpiry): number {
  return credit?.ok ? credit.expiringSoonRemaining ?? 0 : 0;
}

/** 是否有临期积分（**只有 `ok === true` 且金额 > 0** 才算，未知不算）。 */
export function hasExpiringSoonCredits(credit?: CreditExpiry): boolean {
  return credit?.ok === true && expiringSoonAmount(credit) > 0;
}

/**
 * 「最近一批未来到期」的到期时刻；没有则 `Infinity`（排最后）。
 *
 * ⚠️ **不看 `expiringSoon`**（那只是警告窗口），**不看 `credit.soonestExpireAt`**
 * （它把已过期资源也算进最小值 ⇒「已经浪费的」会抢占「先消耗」的位）。
 * 统一走 `nearestExpiringBatch` —— 只认「未来 + 剩余 > 0 + 有到期时刻」。
 */
export function nearestCreditExpiry(credit?: CreditExpiry): number {
  const batch = credit?.ok ? nearestExpiringBatch(credit.resources) : null;
  return batch ? batch.expireAt : Number.POSITIVE_INFINITY;
}

/** 分档（见文件头表格）。 */
export function creditPriorityRank(credit?: CreditExpiry): number {
  if (!credit?.ok) return 3;
  if (hasExpiringSoonCredits(credit)) return 0;
  if (credit.expired) return 2;
  return 1;
}

/**
 * 「积分优先级」比较器 —— **账号页的排序**与**聚合页的徽章**共用这一个。
 *
 * 三级键：分档 → 最近到期升序 → 临期金额降序。
 */
export function compareCreditPriority(left?: CreditExpiry, right?: CreditExpiry): number {
  const rankDifference = creditPriorityRank(left) - creditPriorityRank(right);
  if (rankDifference !== 0) return rankDifference;
  const leftExpiry = nearestCreditExpiry(left);
  const rightExpiry = nearestCreditExpiry(right);
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  return expiringSoonAmount(right) - expiringSoonAmount(left);
}

/**
 * 挑出「该给 ⭐ 建议优先 徽章」的账号 id（**每组只给一个**）。
 *
 * 语义与账号页逐字一致：按积分优先级排一遍，取**第一个**有临期积分的账号 ——
 * 没有临期积分的组返回 `undefined`（徽章不出现，而不是给一个「其实不紧急」的号）。
 *
 * @param rows 同一作用域内的账号
 * @param creditOf 取该账号的积分快照
 */
export function pickPriorityAccountId<T extends { id: string }>(
  rows: readonly T[],
  creditOf: (row: T) => CreditExpiry | undefined,
): string | undefined {
  /* `Array.prototype.sort` 自 ES2019 起保证稳定 ⇒ 与账号页「先 sortAccounts 再 find」
     的结果逐项相同（相等项保持原序）。 */
  return [...rows]
    .sort((left, right) => compareCreditPriority(creditOf(left), creditOf(right)))
    .find((row) => hasExpiringSoonCredits(creditOf(row)))?.id;
}
