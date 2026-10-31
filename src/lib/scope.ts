
import type { Region } from "./types";
import {
  type Product,
  type PlatformSlug,
  PLATFORM_SLUG,
  SLUG_TO_PRODUCT,
  platformOfPath,
} from "./platforms/registry";

/**
 * 作用域字面量：`{平台短标识}-{区域}`。
 *
 * ⚠️ **用短标识（`wb`）而不是 `Product`（`workbuddy`）**：作用域要进 URL 路径段
 * （`/s/wb-cn/accounts`）与 `localStorage` 键，短标识更省也更易读。
 * 两者的映射只在 `platforms/registry.ts` 一处声明。
 *
 * ⚠️ **刻意用连字符而不是 `/`**：它要能直接进路径段，用 `/` 会与分隔符冲突。
 */
export type Scope = `${PlatformSlug}-${Region}`;

/** 全部作用域，按 UI 展示顺序（平台顺序 → 该平台的区域顺序）。 */
export const SCOPES: readonly Scope[] = [
  "wb-cn",
  "wb-global",
  "trae-cn",
  "trae-global",
  "qoder-cn",
  "qoder-global",
];

export const DEFAULT_SCOPE: Scope = "wb-cn";

/** 作用域的两个组成部分。 */
export interface ScopeParts {
  readonly product: Product;
  readonly region: Region;
}

export function parseScope(value: string | null | undefined): Scope | null {
  if (!value) return null;
  return (SCOPES as readonly string[]).includes(value) ? (value as Scope) : null;
}

/** 由平台与区域拼出作用域。**不做校验**（两个入参都是强类型，非法组合在编译期就被挡住）。 */
export function scopeOf(product: Product, region: Region): Scope {
  return `${PLATFORM_SLUG[product]}-${region}`;
}

/** 拆出平台与区域。**调用前请先 `parseScope`**，否则非法值会得到无意义的结果。 */
export function scopeParts(scope: Scope): ScopeParts {
  const i = scope.lastIndexOf("-");
  return {
    product: SLUG_TO_PRODUCT[scope.slice(0, i) as PlatformSlug],
    region: scope.slice(i + 1) as Region,
  };
}

/**
 * 由**旧状态**推出作用域 —— **兼容旧版本的关键函数**（D4）。
 *
 * P2 之前，路由不带作用域：平台来自路径前缀（`/trae/*`），区域来自页面内状态。
 * 本函数把这两者合起来，**保证旧链接与旧状态都能映射到一个合法作用域**。
 *
 * ⚠️ 区域非法时**回落 `cn`** —— 这里与 `parseScope` 的策略不同，是**有意的**：
 * 区域来自旧状态（可能缺失），缺失时用默认区域是合理的；
 * 而 `parseScope` 处理的是"用户明确给了一个作用域字符串"，非法就该拒绝。
 */
export function scopeFromLegacy(pathname: string, region: string | null | undefined): Scope {
  const product = platformOfPath(pathname);
  const r: Region = region === "global" ? "global" : "cn";
  return scopeOf(product, r);
}

/* ────────────────────────────────────────────────────────────────
 * 「上次作用域」的持久化（P1 接线，P0 只提供纯函数）
 *
 * ⚠️ 键名带 `v1` 前缀：将来语义若变（例如作用域增加维度），
 * 可以换键而**不破坏旧值** —— 旧键留着不读即可，用户回到旧版本仍能用。
 * ──────────────────────────────────────────────────────────────── */

/** `localStorage` 键。**唯一真值在 URL**，这里只是「下次冷启动落到哪」。 */
export const LAST_SCOPE_KEY = "buddy-switch:v1:last-scope";

/**
 * 读取上次作用域。**非法或缺失一律返回 `null`**（不回落默认值 —— 由调用方决定）。
 *
 * 静默吞掉 `localStorage` 异常：隐私模式 / 存储被禁时不该让应用崩掉，
 * 只是「记不住上次的选择」而已。
 */
export function readLastScope(storage: Pick<Storage, "getItem"> | undefined): Scope | null {
  try {
    return parseScope(storage?.getItem(LAST_SCOPE_KEY));
  } catch {
    return null;
  }
}

/** 记住本次作用域。**写失败不抛**（同上：记不住不影响功能）。 */
export function writeLastScope(storage: Pick<Storage, "setItem"> | undefined, scope: Scope): void {
  try {
    storage?.setItem(LAST_SCOPE_KEY, scope);
  } catch {
    /* 忽略：存储不可用时只是记不住上次选择 */
  }
}
