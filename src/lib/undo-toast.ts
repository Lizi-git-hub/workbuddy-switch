import { toast } from "sonner";

import { asError } from "@/lib/api";
import { t } from "@/lib/i18n";

/**
 * 撤销窗口时长（ms）。**仅决定 toast 停留多久**，与「账号会不会被永久删除」无关 ——
 * 超时后账号仍在回收站（见文件头「超时」）。
 */
export const UNDO_TOAST_DURATION_MS = 8000;

export interface UndoToastInput {
  /** 主标题（已 i18n），如「已删除，可撤销」。 */
  title: string;
  /** 副标题（已 i18n，通常是被删账号的展示名）。 */
  description?: string;
  /** 「撤销」按钮文案（已 i18n）。 */
  undoLabel: string;
  /** 撤销成功后的 toast 文案（已 i18n）。 */
  undoneTitle: string;
  undo: () => Promise<void>;
}

/**
 * 弹一条带「撤销」的**成功** toast。
 *
 * 点「撤销」就地执行 `input.undo()`：成功 → 原 toast 变为「已恢复」；失败 → 变为
 * 一条 error（含后端原因）。全程不静默。
 */
export function showUndoToast(input: UndoToastInput): void {
  // 防重入：连点「撤销」只跑一次恢复（按钮不会因此重复打后端）。
  let running = false;
  const toastId = toast.success(input.title, {
    description: input.description,
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: input.undoLabel,
      onClick: (event) => {
        // 保持本条 toast 可见（不立即消失），等恢复结果**就地**更新 —— 否则「点一下没反应」。
        event.preventDefault();
        if (running) return;
        running = true;
        void (async () => {
          try {
            await input.undo();
            toast.success(input.undoneTitle, { id: toastId, description: input.description });
          } catch (error) {
            toast.error(t("undo.failedTitle"), { id: toastId, description: asError(error) });
          } finally {
            running = false;
          }
        })();
      },
    },
  });
}
