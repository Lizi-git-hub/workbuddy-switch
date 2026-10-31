import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { EmptyState } from "@/components/ui/empty-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import * as api from "@/lib/api";
import { displayText } from "@/lib/display-text";
import { formatDate } from "@/lib/format";
import { useT, type Translate } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import type { TrashEntry } from "@/lib/types";

/** 待二次确认的不可逆操作（purge 单条 / 清空全部）。 */
type PendingConfirm =
  | { kind: "purge"; key: string; name: string }
  | { kind: "clear"; count: number };

export interface RecycleBinSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前作用域（决定读 / 写哪个 `*.trash.<region>.json`；非法 scope ⇒ 后端 fail-closed 报错）。 */
  scope: Scope;
  /**
   * 恢复成功后的回调 —— 账号页据此刷新账号列表（恢复 = 移回 live）。
   *
   * 只传恢复（不传 purge / 清空）：purge 只动回收站、不影响 live 列表；
   * 而恢复会让账号**回到列表**，必须让页面重取。
   */
  onRestored?: () => void;
}

/** 条目展示名（过 `displayText` 白屏防线；空则回落到「未命名账号」）。 */
function entryLabel(entry: TrashEntry, t: Translate): string {
  return displayText(entry.name)?.trim() || t("recycleBin.entry.unnamed");
}

export function RecycleBinSheet({ open, onOpenChange, scope, onRestored }: RecycleBinSheetProps) {
  const t = useT();
  /** `null` = 尚未加载（首帧走骨架）；`[]` = 已加载但为空（走空态）。 */
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 正在执行单条操作的条目（用于**按钮态**的 Loader2 与禁用）。 */
  const [busy, setBusy] = useState<{ key: string; kind: "restore" | "purge" } | null>(null);
  /** 清空进行中（整表按钮态）。 */
  const [clearing, setClearing] = useState(false);
  /** 待二次确认的不可逆操作（`null` = 无）。 */
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.accountTrashList(scope);
      setEntries(res.entries);
    } catch (e) {
      // 失败不是空态：空态会谎报「回收站是空的」，而实际是读不到（fail-closed 的 scope 非法也走这里）。
      setError(api.asError(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    if (!open) {
      // 关闭即复位：下次打开重新取（回收站是低频视图，宁可重取也不要展示过期数据）。
      setEntries(null);
      setError("");
      setBusy(null);
      setClearing(false);
      setConfirm(null);
      return;
    }
    void load();
  }, [open, load]);

  async function restore(entry: TrashEntry) {
    if (busy || clearing) return;
    setBusy({ key: entry.key, kind: "restore" });
    try {
      await api.accountRestore(scope, entry.key);
      toast.success(t("recycleBin.toast.restored"), { description: entryLabel(entry, t) });
      onRestored?.();
      await load();
    } catch (e) {
      toast.error(t("recycleBin.toast.restoreFail"), { description: api.asError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function purge(key: string, name: string) {
    setConfirm(null);
    setBusy({ key, kind: "purge" });
    try {
      await api.accountPurge(scope, key);
      toast.success(t("recycleBin.toast.purged"), { description: name });
      await load();
    } catch (e) {
      toast.error(t("recycleBin.toast.purgeFail"), { description: api.asError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    setConfirm(null);
    setClearing(true);
    try {
      const res = await api.accountTrashClear(scope);
      toast.success(t("recycleBin.toast.cleared", { n: res.removed }));
      await load();
    } catch (e) {
      toast.error(t("recycleBin.toast.clearFail"), { description: api.asError(e) });
    } finally {
      setClearing(false);
    }
  }

  const count = entries?.length ?? 0;
  const rowBusy = busy !== null || clearing;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("recycleBin.title")}</SheetTitle>
            <SheetDescription>{t("recycleBin.description")}</SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-5">
            {loading ? (
              <div className="space-y-3" aria-busy="true" aria-label={t("recycleBin.loading")}>
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : error ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {t("recycleBin.loadFailed")}
                  {t("shared.punct.colon")}
                  {error}
                </AlertDescription>
              </Alert>
            ) : count === 0 ? (
              <EmptyState
                icon={Trash2}
                title={t("recycleBin.empty.title")}
                description={t("recycleBin.empty.description")}
                action={
                  <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                    {t("recycleBin.empty.action")}
                  </Button>
                }
              />
            ) : (
              <ul className="space-y-2">
                {entries?.map((entry) => {
                  const label = entryLabel(entry, t);
                  return (
                    <li key={entry.key} className="min-w-0 rounded-lg border p-3">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={label}>
                          {label}
                        </span>
                        <Badge variant="secondary" className="shrink-0 rounded-md px-1.5 py-0 text-[11px] font-normal">
                          {displayText(entry.originScope) ?? ""}
                        </Badge>
                      </div>
                      <dl className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
                        <div className="flex items-baseline gap-2">
                          <dt>{t("recycleBin.entry.deletedLabel")}</dt>
                          <dd className="tabular-nums">{formatDate(entry.deletedAt)}</dd>
                        </div>
                        {/* ★ 到期时间必须显示（§2.7：避免「以为还在」的假期待）。 */}
                        <div className="flex items-baseline gap-2">
                          <dt>{t("recycleBin.entry.expiresLabel")}</dt>
                          <dd className="tabular-nums text-destructive/80">{formatDate(entry.expiresAt)}</dd>
                        </div>
                      </dl>
                      <div className="mt-2 flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={rowBusy}
                          onClick={() => void restore(entry)}
                        >
                          {busy?.key === entry.key && busy.kind === "restore" ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <RotateCcw />
                          )}
                          {t("recycleBin.restore")}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={rowBusy}
                          onClick={() => setConfirm({ kind: "purge", key: entry.key, name: label })}
                        >
                          {busy?.key === entry.key && busy.kind === "purge" ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Trash2 />
                          )}
                          {t("recycleBin.purge")}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <SheetFooter>
            <Button
              variant="destructive"
              disabled={count === 0 || rowBusy}
              onClick={() => setConfirm({ kind: "clear", count })}
            >
              {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t("recycleBin.clear")}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("recycleBin.close")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ★ 唯一不可逆步的二次确认（purge / 清空）：未确认**绝不执行**（§2.7）。 */}
      <Dialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "clear" ? t("recycleBin.clear.title") : t("recycleBin.purge.title")}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "clear"
                ? t("recycleBin.clear.desc", { n: confirm.count })
                : t("recycleBin.purge.desc", { name: confirm?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {t("recycleBin.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "clear") void clearAll();
                else void purge(confirm.key, confirm.name);
              }}
            >
              {confirm?.kind === "clear" ? t("recycleBin.clear.confirm") : t("recycleBin.purge.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
