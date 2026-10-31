/**
 * 「同步后使用哪个名字」—— 标题冲突时的选择框。
 *
 * ## 为什么必须让用户选、而不是定一条优先级
 *
 * 标题**不在 jsonl 里**（存在 `workbuddy.db` 的 `sessions` 表），所以内容同步完全不带它。
 * 同一组的几个副本可能各自被改过名，任何「源优先」或「目标优先」的规则都会覆盖掉
 * 某个账号上用户亲手起的名字。⇒ 让用户挑，并且**列清每个名字来自谁**
 * （在一堆同名副本里挑一个、却不知道它属于哪个账号，是没有意义的）。
 *
 * 用户挑定的标题会写进**其余所有副本**的 `custom_title`。
 */

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useT } from "@/lib/i18n";
import { titleChoices } from "@/lib/session-replicas";
import type { SessionGroupView } from "@/lib/session-replicas";

export interface SyncTitleDialogProps {
  /** 要同步的组；`null` = 关闭。 */
  group: SessionGroupView | null;
  onOpenChange: (open: boolean) => void;
  /** 同步进行中（按钮进「操作进行中」态，防重复提交）。 */
  busy: boolean;
  /** 用户确认：参数是**选定要写入的标题文本**。 */
  onConfirm: (title: string) => void;
}

export function SyncTitleDialog({
  group,
  onOpenChange,
  busy,
  onConfirm,
}: SyncTitleDialogProps) {
  const t = useT();
  const [chosen, setChosen] = useState("");

  const choices = group ? titleChoices(group) : [];

  /* 每次打开重置：默认选**第一个出现**的那个名字（行顺序稳定 ⇒ 默认值可复现）。 */
  useEffect(() => {
    if (!group) {
      setChosen("");
      return;
    }
    setChosen(titleChoices(group)[0]?.title ?? "");
  }, [group]);

  if (!group) return null;

  const others = Math.max(group.rows.length - 1, 0);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-slot="sync-title-dialog">
        <DialogHeader>
          <DialogTitle>{t("sessions.sync.titlePick.title")}</DialogTitle>
          <DialogDescription>{t("sessions.sync.titlePick.desc")}</DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={chosen}
          onValueChange={setChosen}
          aria-label={t("sessions.sync.titlePick.title")}
        >
          {choices.map((choice) => (
            <div
              key={choice.title}
              className="flex items-start gap-3 rounded-lg border px-3 py-2"
              data-title-choice={choice.title}
            >
              <RadioGroupItem
                value={choice.title}
                id={`sync-title-${choice.title}`}
                className="mt-0.5"
              />
              <Label
                htmlFor={`sync-title-${choice.title}`}
                className="min-w-0 flex-1 cursor-pointer font-normal"
              >
                <span className="block truncate text-sm font-medium">{choice.title}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {t("sessions.sync.titlePick.owners", { owners: choice.owners.join(" / ") })}
                </span>
              </Label>
            </div>
          ))}
        </RadioGroup>

        <Alert>
          <AlertDescription>
            {t("sessions.sync.titlePick.warn", { n: others })}
          </AlertDescription>
        </Alert>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("sessions.sync.titlePick.cancel")}
          </Button>
          <Button
            disabled={busy || chosen === ""}
            data-slot="sync-title-confirm"
            onClick={() => onConfirm(chosen)}
          >
            {t("sessions.sync.titlePick.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
