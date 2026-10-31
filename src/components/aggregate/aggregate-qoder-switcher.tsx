
import { useCallback, useState } from "react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import { useT } from "@/lib/i18n";
import { aggregateDisplayName, type AggregateAccount } from "@/lib/aggregate-accounts";
import type { QoderProgramStatus } from "@/lib/api";

export interface AggregateQoderSwitcher {
  /** 请求切换（**先弹确认框**，不直接执行）。 */
  request: (account: AggregateAccount, program: QoderProgramStatus) => void;
  /** 正在切换中的账号 uid（用于禁用该卡的程序位按钮）。 */
  busyUid: string | null;
  /** 任一账号正在切换中 ⇒ 锁住所有切换按钮。 */
  switchBusy: boolean;
  /** 确认框 props（页面渲染普通 `Dialog`）。 */
  confirmProps: {
    open: boolean;
    /** 账号展示名（确认框正文要能指名道姓）。 */
    name: string;
    /** 目标程序位名（取后端下发的 `label`，不由区域反推）。 */
    programLabel: string;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
  };
}

interface Pending {
  account: AggregateAccount;
  program: QoderProgramStatus;
}

/** @param onSwitched 切换成功后的回调（页面据此重取账号列表与程序位信号）。 */
export function useAggregateQoderSwitcher(onSwitched?: () => void): AggregateQoderSwitcher {
  const t = useT();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  const request = useCallback((account: AggregateAccount, program: QoderProgramStatus) => {
    setPending({ account, program });
  }, []);

  const onConfirm = useCallback(() => {
    const target = pending;
    setPending(null);
    if (!target || target.account.platform !== "qoder") return;
    const scope = target.account.scope;
    const uid = target.account.data.uid;
    const description = `${aggregateDisplayName(target.account)} · ${target.program.label}`;
    setBusyUid(uid);
    const toastId = toast.loading(t("aggregate.toast.switching"), { description });
    void (async () => {
      try {
        await api.qoderSwitchAccount(scope, target.program.id, uid);
        toast.success(t("wbAccounts.toast.configUpdated"), { id: toastId, description });
        onSwitched?.();
      } catch (error) {
        toast.error(api.asError(error), { id: toastId });
      } finally {
        setBusyUid(null);
      }
    })();
  }, [onSwitched, pending, t]);

  return {
    request,
    busyUid,
    switchBusy: busyUid !== null,
    confirmProps: {
      open: pending !== null,
      name: pending ? aggregateDisplayName(pending.account) : "",
      programLabel: pending?.program.label ?? "",
      onConfirm,
      onOpenChange: (open) => {
        if (!open) setPending(null);
      },
    },
  };
}
