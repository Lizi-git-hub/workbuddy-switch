import { useEffect, useRef } from "react";

import { useDocumentVisible } from "@/lib/use-document-visible";
import { CREDIT_REFRESH_INTERVAL_MS } from "@/lib/use-credit-auto-refresh";

export function useAutoRefreshWhenVisible(
  at: number,
  refresh: () => void | Promise<unknown>,
  intervalMs: number = CREDIT_REFRESH_INTERVAL_MS,
) {
  const visible = useDocumentVisible();
  /* loader 每次渲染都是新身份（多半是 `useCallback` 带依赖的内联函数），放进 ref，
     否则 effect 会因为它换身份而重建定时器 —— 那等于「每次渲染都重置倒计时」。 */
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!visible) return;
    /* `at === 0` 表示首屏那次还在飞（或第一次就失败了），不叠加第二个请求。 */
    if (at > 0 && Date.now() - at >= intervalMs) void refreshRef.current();
    const timer = window.setInterval(() => {
      void refreshRef.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [visible, at, intervalMs]);
}
