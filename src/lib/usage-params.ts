
/** 两个历史键（Token 页 / 积分页各一份）。 */
const LEGACY_COMBINE_KEYS = [
  "buddy-switch:token-stats:region",
  "buddy-switch:credit-stats:region",
] as const;

/** 读合并态初始值；storage 不可用 / 无记录 ⇒ `false`（与原型默认「仅本作用域」一致）。 */
export function readPreferredCombineAll(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return LEGACY_COMBINE_KEYS.some((key) => window.localStorage.getItem(key) === "all");
  } catch {
    return false;
  }
}
