
import { useCallback, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import type { Region } from "@/lib/types";
import type { Product } from "@/lib/platforms/registry";
import { LAST_SCOPE_KEY, parseScope, scopeOf, scopeParts } from "@/lib/scope";

/** 承载**区域**的 URL 查询参数名。与既有 `useWorkbuddyRegion` 一致 ⇒ **旧链接继续有效**。 */
export const REGION_PARAM = "region";

export const DEFAULT_REGION: Region = "cn";

export function isScopeUnified(): boolean {
  return import.meta.env.VITE_SCOPE_UNIFIED !== "0";
}

/**
 * 宽容解析区域值。
 *
 * `intl` / `international` 视为 `global` —— 与 Trae 侧既有规则一致，
 * 避免同一个概念在两处接受不同的写法。
 */
export function normalizeRegion(raw: string | null | undefined): Region | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "global" || v === "intl" || v === "international") return "global";
  if (v === "cn") return "cn";
  return null;
}

/** 读「上次作用域」中属于该平台的区域。非法 / 缺失 / 平台不匹配一律返回 `null`。 */
function readRememberedScope(): string | null {
  if (typeof window === "undefined" || !isScopeUnified()) return null;
  try {
    return window.localStorage.getItem(LAST_SCOPE_KEY);
  } catch {
    return null; // 隐私模式 / 存储被禁：只是记不住，不影响功能
  }
}

/**
 * 解析「当前区域」的**纯函数** —— hook 只是它的薄壳。
 *
 * ⚠️ **抽出来是为了可测**：前端没有单测框架，而这条优先级规则
 * （URL > 记忆 > 默认）正是 P1 要修的缺陷所在，必须被门禁守住。
 * hook 里的 `useMemo` 只负责把 `useSearchParams` 的结果喂进来。
 *
 * 优先级：
 * 1. **URL** 有合法值 ⇒ 用它（可分享、可前进后退）；
 * 2. 否则看**记忆**里的「上次作用域」—— **product 匹配时**才用它的 region；
 * 3. 都没有 ⇒ 默认区域。
 *
 * 第 2 步的 product 匹配很关键：记的是 `wb-global` 时，Trae 分区**不该**套用 global。
 */
export function resolveRegion(input: {
  /**
   * **路径里的作用域**（P2 引入的 `/s/{scope}/{dest}` 形态）。
   * 优先级最高 —— 它是显式的、可分享的形态。
   */
  pathScope?: string | null | undefined;
  /** URL 查询串上的原始值（P1 的过渡形态，可能缺失 / 非法 / 带 `intl` 这类别名） */
  urlValue: string | null | undefined;
  /** localStorage 里的「上次作用域」（完整 Scope 字面量，可能非法） */
  rememberedScope: string | null | undefined;
  /** 当前页面所属平台 */
  product: Product;
}): Region {
  // ① 路径里的 scope（`/s/wb-global/accounts`）—— 最显式，优先
  const fromPath = parseScope(input.pathScope);
  if (fromPath) {
    const parts = scopeParts(fromPath);
    // ⚠️ 平台不匹配 ⇒ **不采信**：`/s/trae-cn/accounts` 落在 WB 页面上属于路由错配，
    // 此时宁可往下走，也不要套用别的平台的区域。
    if (parts.product === input.product) return parts.region;
  }

  // ② 查询参数（P1 形态）
  const fromUrl = normalizeRegion(input.urlValue);
  if (fromUrl) return fromUrl;

  // ③ 记忆（跨路由的关键）
  const scope = parseScope(input.rememberedScope);
  if (scope) {
    const parts = scopeParts(scope);
    if (parts.product === input.product) return parts.region;
  }
  return DEFAULT_REGION;
}

function rememberScope(product: Product, region: Region): void {
  if (typeof window === "undefined" || !isScopeUnified()) return;
  try {
    window.localStorage.setItem(LAST_SCOPE_KEY, scopeOf(product, region));
  } catch {
    /* 同上：写失败不抛 */
  }
}

/**
 * 当前**区域**（`cn` / `global`），由 URL 承载、由 localStorage 记忆。
 *
 * @param product 当前页面所属平台（通常来自路由，见 `platformOfPath`）。
 *   **必须传对** —— 它是「记忆里的作用域是否适用于本页」的判据。
 */
export function useScope(product: Product): [Region, (next: Region) => void] {
  const [params, setParams] = useSearchParams();
  const routeParams = useParams();

  const region = useMemo<Region>(
    () =>
      resolveRegion({
        pathScope: routeParams.scope,
        urlValue: params.get(REGION_PARAM),
        rememberedScope: readRememberedScope(),
        product,
      }),
    // ⚠️ `params` 变化要重算；`product` 变化也要（跨分区时记忆的适用性变了）；
    //    `routeParams.scope` 同理（同一条路径切换作用域）
    [params, routeParams.scope, product],
  );

  const setRegion = useCallback(
    (next: Region) => {
      // 先写记忆，再改 URL：即使 URL 更新被 replace 掉，记忆也已生效
      rememberScope(product, next);
      setParams(
        (prev) => {
          const draft = new URLSearchParams(prev);
          if (next === DEFAULT_REGION) {
            // 默认值**不写进 URL**：让「默认」与「显式指定」产生同一个 URL
            draft.delete(REGION_PARAM);
          } else {
            draft.set(REGION_PARAM, next);
          }
          return draft;
        },
        { replace: true },
      );
    },
    [product, setParams],
  );

  return [region, setRegion];
}
