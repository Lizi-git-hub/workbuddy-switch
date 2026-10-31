
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/zh";

/** 一次重启确认要用到的文案键与结构开关（**纯数据**，便于门禁断言）。 */
export interface RestartConfirmCopy {
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  /** 风险提示键；无风险提示时为 `null`。 */
  warningKey: TranslationKey | null;
  autoReopen: boolean;
  confirmKey: TranslationKey;
}

/**
 * 按 `isCli` 给出确认框的**文案键 + 结构开关**。
 *
 * ⚠️ **CLI 分支不得写「自动重开」**：CLI 切换只更新认证配置、**不重开**客户端，
 * 但**当前 CLI 会话会中断**（`programs.rs` 的 CLI 适配器忽略 `restart`）。
 */
export function restartConfirmCopy(isCli: boolean): RestartConfirmCopy {
  if (isCli) {
    return {
      titleKey: "sessions.restart.cliTitle",
      descriptionKey: "sessions.restart.cliDescription",
      warningKey: "sessions.restart.cliWarning",
      autoReopen: false,
      confirmKey: "sessions.restart.cliConfirm",
    };
  }
  return {
    titleKey: "sessions.restart.title",
    descriptionKey: "sessions.restart.description",
    warningKey: "sessions.restart.unsavedWarning",
    autoReopen: true,
    confirmKey: "sessions.restart.confirm",
  };
}

export interface RestartConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 需要（或不需要）重启的客户端显示名，如「CodeBuddy IDE」「CodeBuddy CLI」「WorkBuddy」。 */
  clientLabel: string;
  /** CLI 例外：`true` ⇒ 不渲染「自动重开」、文案如实写「当前 CLI 会话会中断」。 */
  isCli: boolean;
  /**
   * 用户确认。`restart` 为最终选择（**CLI 恒 `false`**）。
   *
   * 调用方拿到后**先关闭本框**再执行切换 —— 切换进行中的进度由调用方自己的遮罩承担。
   */
  onConfirm: (restart: boolean) => void;
}

export function RestartConfirmDialog({
  open,
  onOpenChange,
  clientLabel,
  isCli,
  onConfirm,
}: RestartConfirmDialogProps) {
  const t = useT();
  const copy = restartConfirmCopy(isCli);
  /** 「自动重开」勾选；非 CLI 场景默认勾选（每次打开复位）。 */
  const [autoReopen, setAutoReopen] = useState(true);

  // 每次打开都复位成默认「自动重开」：上次取消勾选不该影响下一次确认。
  useEffect(() => {
    if (open) setAutoReopen(true);
  }, [open]);

  // CLI 不重开 ⇒ restart 恒 false；非 CLI 由勾选决定。
  const restart = copy.autoReopen ? autoReopen : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(copy.titleKey, { client: clientLabel })}</DialogTitle>
          <DialogDescription>{t(copy.descriptionKey, { client: clientLabel })}</DialogDescription>
        </DialogHeader>

        {copy.warningKey ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{t(copy.warningKey, { client: clientLabel })}</AlertDescription>
          </Alert>
        ) : null}

        {/* ★ CLI 分支**不渲染**勾选（`copy.autoReopen === false`）—— 出现即暗示「可自动重开」。 */}
        {copy.autoReopen ? (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5">
            <Checkbox
              checked={autoReopen}
              onCheckedChange={(value) => setAutoReopen(value === true)}
              aria-label={t("sessions.restart.autoReopen", { client: clientLabel })}
            />
            <span className="min-w-0 flex-1 text-sm">
              {t("sessions.restart.autoReopen", { client: clientLabel })}
            </span>
          </label>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("sessions.restart.cancel")}
          </Button>
          <Button onClick={() => onConfirm(restart)}>{t(copy.confirmKey)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
