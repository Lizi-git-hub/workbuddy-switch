
import { useCallback, useSyncExternalStore } from "react";

/**
 * `localStorage` 键前缀。`v1` 前缀是仓内惯例（语义若变可换键而不破坏旧值）。
 *
 * ⚠️ 这是**动态键**（每个账号一条），**不得**登记进
 * `src/lib/app-settings-snapshot.ts` 的 `APP_SETTINGS_STORAGE_KEYS` ——
 * 那份清单只收固定键，且被门禁逐字断言。
 */
export const DRAWER_TAB_KEY_PREFIX = "buddy-switch:v1:drawer-tab:";

/** 五枚页签的稳定 id（与 Radix `Tabs` 的 `value` 逐字一致）。 */
export const DRAWER_TABS = ["overview", "credits", "checkin", "credential", "snapshot"] as const;

export type DrawerTab = (typeof DRAWER_TABS)[number];

/** 缺省页签：也是「没有记忆」时的回落目标。 */
export const DEFAULT_DRAWER_TAB: DrawerTab = "overview";

/** 收窄到合法页签 id（`onValueChange` 拿到的是裸 `string`）。 */
export function isDrawerTab(value: unknown): value is DrawerTab {
  return typeof value === "string" && (DRAWER_TABS as readonly string[]).includes(value);
}

/** 键 = 前缀 + 账号键（调用方传 `${scope}:${id}`，**必须**带作用域）。 */
export function drawerTabKey(accountKey: string): string {
  return `${DRAWER_TAB_KEY_PREFIX}${accountKey}`;
}

/**
 * 读取记忆页签。缺失 / 非法值 / 空账号键 / 存储抛异常 ⇒ 一律 `null`
 * （读不到就不假装记住，让调用方回落到第一枚可用页签）。
 */
export function readDrawerTab(
  storage: Pick<Storage, "getItem"> | undefined,
  accountKey: string | undefined,
): DrawerTab | null {
  if (!accountKey) return null;
  try {
    const raw = storage?.getItem(drawerTabKey(accountKey));
    return isDrawerTab(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 写入记忆页签。**写失败不抛**（记不住不影响功能）。 */
export function writeDrawerTab(
  storage: Pick<Storage, "setItem"> | undefined,
  accountKey: string,
  tab: DrawerTab,
): void {
  if (!accountKey) return;
  try {
    storage?.setItem(drawerTabKey(accountKey), tab);
  } catch {
    /* 忽略：存储不可用时只是记不住 */
  }
}

/**
 * R3 / R4 的唯一出口：记住的值**当前可用**就用它，否则回落**渲染顺序第一枚**可用页签。
 *
 * 回落**不写盘** —— 「这次显示哪一枚」与「记住了什么」是两件事：记住的「积分」页签
 * 在该账号暂无资源包时不可用，但资源包刷新回来之后仍应回到「积分」。
 */
export function resolveDrawerTab(
  remembered: DrawerTab | null,
  available: readonly DrawerTab[],
): DrawerTab {
  if (remembered && available.includes(remembered)) return remembered;
  return available[0] ?? DEFAULT_DRAWER_TAB;
}

/** 取可用的 `localStorage`（不可用返回 `undefined`）。 */
function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** 每个账号的缓存 —— 保证 `useSyncExternalStore` 的快照在两次渲染间稳定。 */
const cache = new Map<string, DrawerTab | null>();
const listeners = new Set<() => void>();

function cached(accountKey: string): DrawerTab | null {
  if (!cache.has(accountKey)) {
    cache.set(accountKey, readDrawerTab(safeStorage(), accountKey));
  }
  return cache.get(accountKey) ?? null;
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 记住页签：持久化 + 更新缓存 + 通知订阅者。 */
export function setDrawerTab(accountKey: string, tab: DrawerTab): void {
  writeDrawerTab(safeStorage(), accountKey, tab);
  cache.set(accountKey, tab);
  for (const listener of listeners) listener();
}

/**
 * 订阅某账号的记忆页签。返回 `[remembered, remember]`。
 *
 * `remembered` 为 `null` 表示「这个账号还没记过」，由 [`resolveDrawerTab`] 决定显示哪一枚。
 */
export function useDrawerTab(
  accountKey: string,
): [DrawerTab | null, (tab: DrawerTab) => void] {
  const subscribe = useCallback((listener: () => void) => subscribeStore(listener), []);
  const getSnapshot = useCallback(() => cached(accountKey), [accountKey]);
  const remembered = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const remember = useCallback((tab: DrawerTab) => setDrawerTab(accountKey, tab), [accountKey]);
  return [remembered, remember];
}
