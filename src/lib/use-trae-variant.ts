import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { parseScope, scopeOf, scopeParts } from "@/lib/scope";
import { scopeShortcutTarget } from "@/lib/scope-shortcuts";
import type { TraeRegionId } from "@/lib/trae-types";

/** 承载**区域**的 URL 查询参数名。 */
const VARIANT_PARAM = "line";

/** `/s/{scope}/{dest}` 的目的地段（用于在路径形态下改作用域时保住当前页）。 */
function destOfPath(pathname: string): string | null {
  return /^\/s\/[^/]+\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

export function useTraeVariant(): [TraeRegionId, (next: TraeRegionId) => void] {
  const [params, setParams] = useSearchParams();
  const routeParams = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  /** 路径里的 Trae 区域（`/s/trae-global/...`）—— 最权威；非 Trae 作用域时为 `null`。 */
  const pathRegion = useMemo<TraeRegionId | null>(() => {
    const scope = parseScope(routeParams.scope);
    if (!scope) return null;
    const parts = scopeParts(scope);
    return parts.product === "trae" ? parts.region : null;
  }, [routeParams.scope]);

  const region = useMemo<TraeRegionId>(() => {
    if (pathRegion) return pathRegion;
    const raw = (params.get(VARIANT_PARAM) ?? "").trim().toLowerCase().replace(/-/g, "_");
    return raw === "global" || raw === "intl" || raw === "international" ? "global" : "cn";
  }, [params, pathRegion]);

  const setRegion = useCallback(
    (next: TraeRegionId) => {
      // ① 路径形态：改作用域段，保住当前目的地（不再写 `?line=`，避免第二真值）。
      if (pathRegion !== null) {
        if (next === pathRegion) return;
        navigate(scopeShortcutTarget(scopeOf("trae", next), destOfPath(location.pathname) ?? "accounts"), {
          replace: true,
        });
        return;
      }
      // ② 旧形态（`/trae/*` + `?line=`）：写查询参数。
      setParams(
        (prev) => {
          const draft = new URLSearchParams(prev);
          if (next === "cn") {
            // 默认区域**不写进 URL**：让「默认」与「显式指定」产生同一个 URL，
            // 避免两条看起来不同的链接其实等价、也避免默认值污染可读性。
            draft.delete(VARIANT_PARAM);
          } else {
            draft.set(VARIANT_PARAM, next);
          }
          return draft;
        },
        { replace: true },
      );
    },
    [pathRegion, location.pathname, navigate, setParams],
  );

  return [region, setRegion];
}
