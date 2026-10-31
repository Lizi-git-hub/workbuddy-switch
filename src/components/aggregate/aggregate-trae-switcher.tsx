
import { useCallback, useState } from "react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import { useT } from "@/lib/i18n";
import { aggregateDisplayName, type AggregateAccount } from "@/lib/aggregate-accounts";
import type { TraeVariantId } from "@/lib/trae-types";

export interface AggregateTraeSwitcher {
  /** 请求切换（**先弹确认框**，不直接执行）。 */
  request: (account: AggregateAccount, variant: TraeVariantId, label: string) => void;
  /**
   * 正在执行的动作 key，形状与卡片约定一致：`switch-<userId>@<变体>`。
   *
   * 卡片的 `busy` 派生出「切换中」文案与菜单项的 `disabled`
   * （`trae-account-card.tsx` 的 `switchingVariant` / `saving` / `thawing` …）——
   * 键形状对不上就**不转圈、不互斥、可重复点**，重复点会真的发第二次请求。
   */
  busy: string | null;
  /** 任一账号正在切换中 ⇒ 锁住所有切换按钮（与渠道页 `switchBusy` 同义）。 */
  switchBusy: boolean;
  /** 确认框 props（页面渲染 `RestartConfirmDialog`）。 */
  confirmProps: {
    open: boolean;
    clientLabel: string;
    isCli: false;
    onConfirm: (restart: boolean) => void;
    onOpenChange: (open: boolean) => void;
  };
}

interface Pending {
  account: AggregateAccount;
  variant: TraeVariantId;
  label: string;
}

/**
 * @param onSwitched 切换成功后的回调（页面据此重取账号列表与程序位信号）。
 */
export function useAggregateTraeSwitcher(onSwitched?: () => void): AggregateTraeSwitcher {
  const t = useT();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const request = useCallback((account: AggregateAccount, variant: TraeVariantId, label: string) => {
    setPending({ account, variant, label });
  }, []);

  const onConfirm = useCallback(
    (restart: boolean) => {
      const target = pending;
      setPending(null);
      if (!target || target.account.platform !== "trae") return;
      const userId = target.account.data.userId;
      const key = `switch-${userId}@${target.variant}`;
      setBusy(key);
      const toastId = toast.loading(t("aggregate.toast.switching"), {
        description: `${aggregateDisplayName(target.account)} · ${target.label}`,
      });
      void (async () => {
        try {
          await api.traeSwitchAccount({
            userId,
            variant: target.variant,
            launch: restart,
          });
          toast.success(t("wbAccounts.toast.configUpdated"), {
            id: toastId,
            description: `${aggregateDisplayName(target.account)} · ${target.label}`,
          });
          onSwitched?.();
        } catch (error) {
          toast.error(api.asError(error), { id: toastId });
        } finally {
          setBusy(null);
        }
      })();
    },
    [onSwitched, pending, t],
  );

  return {
    request,
    busy,
    switchBusy: busy !== null,
    confirmProps: {
      open: pending !== null,
      clientLabel: pending?.label ?? "",
      isCli: false,
      onConfirm,
      onOpenChange: (open) => {
        if (!open) setPending(null);
      },
    },
  };
}
