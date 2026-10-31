import { useCallback, useEffect, useRef, useState } from "react";

export function useRefreshAction(minSpinMs = 500): {
  /** 动作进行中（含最小展示时长的补足段）。 */
  busy: boolean;
  /** 执行动作并管理 `busy` 的进出时机。返回的 Promise 在**展示结束**后 resolve。 */
  run: (action: () => unknown | Promise<unknown>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (action: () => unknown | Promise<unknown>) => {
      setBusy(true);
      const startedAt = Date.now();
      try {
        await action();
      } finally {
        const remaining = minSpinMs - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        if (aliveRef.current) setBusy(false);
      }
    },
    [minSpinMs],
  );

  return { busy, run };
}
