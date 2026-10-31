
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { lostLinesFor } from "@/lib/session-replicas";
import type { SessionGroupView } from "@/lib/session-replicas";

export interface UnifyReplicasDialogProps {
  /** 要处理的分歧组；`null` = 关闭。 */
  group: SessionGroupView | null;
  onOpenChange: (open: boolean) => void;
  /** 统一进行中（按钮进「操作进行中」态，防止重复提交）。 */
  busy: boolean;
  /** 用户确认后回调，参数是**要保留的那一份**的会话 id。 */
  onConfirm: (keepSessionId: string) => void;
}

export function UnifyReplicasDialog({
  group,
  onOpenChange,
  busy,
  onConfirm,
}: UnifyReplicasDialogProps) {
  const t = useT();
  const [keep, setKeep] = useState("");

  /* 每次打开都重置选择 —— 默认选**内容最全**的那一份（delta 最大）。 */
  useEffect(() => {
    if (!group) {
      setKeep("");
      return;
    }
    const deltaOf = (id: string) => group.deltas.get(id) ?? 0;
    const best = [...group.rows].sort((a, b) => deltaOf(b.sessionId) - deltaOf(a.sessionId))[0];
    setKeep(best?.sessionId ?? "");
  }, [group]);

  if (!group) return null;

  const deltaOf = (id: string) => group.deltas.get(id) ?? 0;
  const maxDelta = Math.max(...group.rows.map((row) => deltaOf(row.sessionId)));
  const targets = group.rows.filter((row) => row.sessionId !== keep);

  const losses = targets.map((row) => lostLinesFor(group, row.sessionId));
  const totalLost = losses.every((n) => n !== null)
    ? losses.reduce<number>((sum, n) => sum + (n ?? 0), 0)
    : null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-slot="unify-dialog">
        <DialogHeader>
          <DialogTitle>{t("sessions.unify.title")}</DialogTitle>
          <DialogDescription>{t("sessions.unify.desc")}</DialogDescription>
        </DialogHeader>

        <RadioGroup value={keep} onValueChange={setKeep} aria-label={t("sessions.unify.title")}>
          {group.rows.map((row) => {
            const delta = deltaOf(row.sessionId);
            const isBest = delta === maxDelta;
            return (
              <div
                key={row.sessionId}
                className="flex items-start gap-3 rounded-lg border px-3 py-2"
                data-unify-row={row.sessionId}
              >
                <RadioGroupItem
                  value={row.sessionId}
                  id={`unify-${row.sessionId}`}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={`unify-${row.sessionId}`}
                  className="min-w-0 flex-1 cursor-pointer font-normal"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{row.accountLabel}</span>
                    {/* 「最完整」是**内容级**事实（行数最多），不是猜测。 */}
                    {isBest ? <Badge variant="secondary">{t("sessions.unify.mostComplete")}</Badge> : null}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                    {row.sessionId}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t("sessions.replica.delta", { count: delta })}
                  </span>
                </Label>
              </div>
            );
          })}
        </RadioGroup>

        {/* ★ 代价必须写在按钮**旁边**，不能只藏在描述里 —— 这是不可逆操作（§3.5）。 */}
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>
            {totalLost === null
              ? t("sessions.unify.overwriteUnknown", { n: targets.length })
              : t("sessions.unify.overwrite", { n: targets.length, lost: totalLost })}
          </AlertDescription>
        </Alert>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("sessions.unify.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || keep === ""}
            data-slot="unify-confirm"
            onClick={() => onConfirm(keep)}
          >
            {t("sessions.unify.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
