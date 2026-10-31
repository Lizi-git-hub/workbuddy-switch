
/** `localStorage` 键。`v1` 前缀：将来语义若变可换键而不破坏旧值。 */
export const FIRST_RUN_HINT_KEY = "buddy-switch:v1:first-run-hint-dismissed";

/**
 * 是否应显示首次引导。**未被关闭过 ⇒ `true`**。
 *
 * 存储不可用或抛异常 ⇒ `true`（显示）：引导是**一次性**的，宁可多显示一次，
 * 也不要在存储受限的环境里彻底丢失这个提示。
 */
export function shouldShowFirstRunHint(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(FIRST_RUN_HINT_KEY) !== "1";
  } catch {
    return true;
  }
}

/** 关闭首次引导（持久化）。**写失败不抛**。 */
export function dismissFirstRunHint(storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(FIRST_RUN_HINT_KEY, "1");
  } catch {
    /* 忽略：存储不可用时只是每次都会再出现 */
  }
}
