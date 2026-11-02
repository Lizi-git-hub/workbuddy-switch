
import { useState } from "react";
import { Download, GitMerge, History, Info, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/api";
import type { Region } from "@/lib/types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatDate } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { buildSyncItems, titleChoices } from "@/lib/session-replicas";
import type { SessionGroupView } from "@/lib/session-replicas";
import { SyncTitleDialog } from "@/components/sessions/sync-title-dialog";

export interface SessionReplicaViewProps {
  groups: SessionGroupView[];
  onSyncGroup?: (group: SessionGroupView, title?: string) => void;
  busyGroupKeys?: ReadonlySet<string>;
  onUnifyGroup?: (group: SessionGroupView) => void;
  /** 副本所在 region（删除时后端按 region 定位库与 jsonl）。 */
  region?: Region;
  /** 删除成功后让页面重新拉一次组（不做本地乐观更新：状态要由后端重算）。 */
  onDeleted?: () => void;
  /**
   * 非空 ⇒ 客户端正在运行，删除 / 同步 / 统一标题一律禁用。
   *
   * 这些操作会改写 `projects/**` 与 `sessions` 行：客户端运行时会重建被删的会话、
   * 用内存里的标题覆盖刚同步的结果 ⇒ 与其让用户点完看到"没生效"，不如先拦住。
   */
  blockedReason?: string | null;
}

/** 组状态 → 徽标变体（与 `sessions.replica.status.*` 文案配套，**内容级**派生）。 */
function statusVariant(status: SessionGroupView["status"]) {
  if (status === "diverge") return "destructive";
  if (status === "behind") return "warning";
  if (status === "latest") return "success";
  return "secondary";
}

/**
 * 组标题：取任一**有真实标题**的副本（只有当前账号的副本能拿到会话行，其余落兜底文案）。
 * 同一份会话复制出的各副本标题一致 ⇒ 取第一个非兜底的即代表整组；全为兜底则如实显示兜底。
 */
function groupTitle(t: ReturnType<typeof useT>, group: SessionGroupView): string {
  const fallback = t("sessions.replica.titleFallback");
  const named = group.rows.find((row) => row.title !== fallback);
  return named?.title ?? group.rows[0]?.title ?? fallback;
}

/** 组的更新行 = 各副本 `updatedAt` 里**最近**的一个（**只作事实展示**，非状态派生）。 */
function latestUpdatedAt(group: SessionGroupView): number | null {
  const times = group.rows.map((row) => row.updatedAt).filter((v): v is number => v !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

/** 分支徽标变体：由**内容级** `deltas` 决定（分歧优先，其次看谁增量最多）。 */
function branchVariant(group: SessionGroupView, sessionId: string) {
  if (group.status === "diverge") return "destructive";
  const delta = group.deltas.get(sessionId) ?? 0;
  if (delta <= 0) return "secondary";
  const maxDelta = Math.max(...group.rows.map((row) => group.deltas.get(row.sessionId) ?? 0));
  return delta >= maxDelta ? "success" : "warning";
}

/**
 * 组内各副本的**显示标题**是否不一致。
 *
 * 返回去重后的标题列表（长度 > 1 才算「标题不同」）；取不到足够样本 ⇒ `null`。
 *
 * ⚠️ 只用 `group.titles`（后端直读库、跨账号都取得到），**不用** `rows[].title` ——
 * 后者只对当前账号有效，其余是「标题未知」兜底，拿它比较会造出假差异。
 */
function titleSplit(group: SessionGroupView): string[] | null {
  const values = group.rows
    .map((row) => group.titles.get(row.sessionId))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (values.length < 2) return null;
  const unique = Array.from(new Set(values));
  return unique.length > 1 ? unique : null;
}

export function SessionReplicaView({
  groups,
  onSyncGroup,
  busyGroupKeys,
  onUnifyGroup,
  region,
  onDeleted,
  blockedReason,
}: SessionReplicaViewProps) {
  const t = useT();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = groups.find((group) => group.key === openKey) ?? null;

  const [syncTitleGroup, setSyncTitleGroup] = useState<SessionGroupView | null>(null);

  function requestSync(group: SessionGroupView) {
    if (!onSyncGroup) return;
    if (titleChoices(group).length > 1) {
      setSyncTitleGroup(group);
      return;
    }
    onSyncGroup(group);
  }

  return (
    <>
      <SyncTitleDialog
        group={syncTitleGroup}
        onOpenChange={(next) => {
          if (!next) setSyncTitleGroup(null);
        }}
        busy={syncTitleGroup ? busyGroupKeys?.has(syncTitleGroup.key) === true : false}
        onConfirm={(title) => {
          const target = syncTitleGroup;
          setSyncTitleGroup(null);
          if (target) onSyncGroup?.(target, title);
        }}
      />
      {/* `.sg-grid`：`minmax(260px, 1fr)` + gap 12（原型 :794）。 */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}
      >
        {groups.map((group) => {
          const updated = latestUpdatedAt(group);
          return (
            <button
              key={group.key}
              type="button"
              data-session-group={group.key}
              aria-label={t("sessions.card.openAria", { title: groupTitle(t, group) })}
              onClick={() => setOpenKey(group.key)}
              className="flex flex-col items-stretch rounded-xl border bg-card p-3.5 text-left transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <div className="flex items-center justify-between gap-2">
                {/* ★ **内容级**状态（来自 fingerprint 的公共前缀，**不是** updatedAt）。 */}
                <Badge variant={statusVariant(group.status)} data-status={group.status}>
                  {t(`sessions.replica.status.${group.status}`)}
                </Badge>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("sessions.card.replicaCount", { count: group.rows.length })}
                </span>
              </div>
              <h4 className="mt-2 mb-1.5 truncate text-[13px] font-semibold">
                {groupTitle(t, group)}
              </h4>
              {/* ★ 标题差异（**元数据**层面）：内容可以逐行一致，但两边名字被改过。
                  标题不在 jsonl 里 ⇒ 内容指纹看不见它，必须单独标出来。 */}
              {(() => {
                const split = titleSplit(group);
                if (!split) return null;
                return (
                  <Badge
                    variant="outline"
                    className="mt-0.5 mb-1 w-fit text-[10px]"
                    data-title-split
                    title={split.join("  /  ")}
                  >
                    {t("sessions.replica.titleDiffers", { count: split.length })}
                  </Badge>
                );
              })()}
              {/* `updatedAt` **只作事实**展示，不派生「落后 / 最新」（§3.15.2）。 */}
              <div className="text-xs text-muted-foreground">
                {updated !== null ? formatDate(updated) : t("sessions.replica.updatedUnknown")}
              </div>
            </button>
          );
        })}
      </div>

      <Sheet
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpenKey(null);
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {open ? (
            <SessionGraphSheet
              group={open}
              onSyncGroup={onSyncGroup ? requestSync : undefined}
              busy={busyGroupKeys?.has(open.key) === true}
              onUnifyGroup={onUnifyGroup}
              region={region}
              onDeleted={onDeleted}
              blockedReason={blockedReason ?? null}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

interface SessionGraphSheetProps {
  group: SessionGroupView;
  onSyncGroup?: (group: SessionGroupView, title?: string) => void;
  busy: boolean;
  onUnifyGroup?: (group: SessionGroupView) => void;
  region?: Region;
  onDeleted?: () => void;
  blockedReason?: string | null;
}

function SessionGraphSheet({
  group,
  onSyncGroup,
  busy,
  onUnifyGroup,
  region,
  onDeleted,
  blockedReason,
}: SessionGraphSheetProps) {
  const blocked = Boolean(blockedReason);
  const t = useT();
  const items = buildSyncItems(group);
  /* 勾选的副本（`uid\u001f cid`）—— 删除是**按副本**的：只处理选中的账号，
     组内其他副本一个都不动。 */
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const checkedRows = group.rows.filter((row) => checked.has(`${row.accountUid}\u001f${row.sessionId}`));
  const allChecked = group.rows.length > 0 && checkedRows.length === group.rows.length;

  function toggleRow(key: string, next: boolean) {
    setChecked((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
  }

  async function runDelete() {
    if (checkedRows.length === 0) return;
    setDeleting(true);
    try {
      const response = await api.deleteSessionCopies(
        checkedRows.map((row) => ({ uid: row.accountUid, cid: row.sessionId })),
        region,
      );
      if (response.deleted > 0) {
        toast.success(t("sessions.delete.done", { n: response.deleted }));
      }
      if (response.deleted < checkedRows.length) {
        const failed = response.results.filter((item) => !item.ok).length;
        toast.warning(t("sessions.delete.partial", { n: failed }));
      }
      setChecked(new Set());
      setDeleteOpen(false);
      onDeleted?.();
    } catch (e) {
      toast.error(t("sessions.delete.fail", { error: api.asError(e) }));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="truncate">{groupTitle(t, group)}</SheetTitle>
        <SheetDescription>{t("sessions.replica.groupTitle", { count: group.rows.length })}</SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto p-5">
        {/* 客户端运行中：写操作全部禁用，理由摆在最上面（不靠 hover 才发现）。 */}
        {blocked ? (
          <Alert variant="warning" className="mb-3" data-client-running>
            <Info className="size-4" aria-hidden="true" />
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        ) : null}
        {/* ★ 关联图（`commonPrefix === null` ⇒ `unknown`，**无数据不渲染**）。 */}
        {group.commonPrefix !== null ? (
          <div>
            <div className="flex flex-col gap-0.5 rounded-[10px] border-l-[3px] bg-muted px-3 py-2.5">
              <b className="text-[12.5px] font-semibold">
                {t("sessions.replica.commonPrefix", { count: group.commonPrefix })}
              </b>
            </div>
            <div className="mt-2.5 flex flex-col gap-2 border-l-2 border-dashed pl-3.5">
              {group.rows.map((row) => (
                <div
                  key={`${row.accountUid}\u001f${row.sessionId}`}
                  className="flex items-center justify-between gap-2.5 rounded-[10px] bg-muted px-2.5 py-2"
                >
                  <span className="truncate text-[12.5px] font-medium">{row.accountLabel}</span>
                  <Badge variant={branchVariant(group, row.sessionId)} className="shrink-0">
                    {t("sessions.replica.delta", { count: group.deltas.get(row.sessionId) ?? 0 })}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* ★★ P14 S2：**上次一致点** —— 与上面的「共同旧版」**不是一回事**：
            共同旧版 = **当前**内容的公共前缀；上次一致点 = 我们**记录过**的那次逐行相同。
            两者不一致恰恰有信息量：说明有人改写过更早的内容（那时「相对共同旧版的新增条数」
            会凭空放大，而这里给的是**经过前缀验证**的诚实读数）。
            ⚠️ 前缀验证不过 ⇒ 如实说「已改写更早内容」，**不编一个数**。
            无基线 ⇒ 整块不渲染（§3.4 规则 1「无数据不渲染」）。 */}
        {group.baseline ? (
          <div className="mt-2.5 rounded-[10px] border-l-[3px] bg-muted px-3 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-0.5">
              <b className="text-[12.5px] font-semibold">
                {t("sessions.replica.baseline", { count: group.baseline.lineCount })}
              </b>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatDate(group.baseline.createdAt)}
              </span>
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              {group.rows
                .filter((row) => group.sinceBaseline.has(row.sessionId))
                .map((row) => {
                  const delta = group.sinceBaseline.get(row.sessionId);
                  return (
                    <div
                      key={`baseline\u001f${row.accountUid}\u001f${row.sessionId}`}
                      className="flex items-center justify-between gap-2.5"
                    >
                      <span className="truncate text-[12px]">{row.accountLabel}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {delta === null || delta === undefined
                          ? t("sessions.replica.baselineRewritten")
                          : t("sessions.replica.baselineDelta", { count: delta })}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        ) : null}

        {/* ★ 诚实标注：ledger 只覆盖「经本应用复制过」的会话（§3.5）。
            `partial` 恒 true ⇒ 这段文案恒渲染；绑在 `partial` 上是为了让「诚实性」承重。 */}
        {group.partial ? (
          <p className="mt-3 text-xs text-muted-foreground">{t("sessions.replica.partialNote")}</p>
        ) : null}

        <div className="mt-3 divide-y rounded-xl border">
          {group.rows.map((row) => {
            const rowKey = `${row.accountUid}\u001f${row.sessionId}`;
            return (
            <div key={rowKey} className="flex items-start gap-3 px-4 py-3">
              <Checkbox
                className="mt-1 shrink-0"
                checked={checked.has(rowKey)}
                onCheckedChange={(next) => toggleRow(rowKey, next === true)}
                aria-label={t("sessions.delete.rowAria", { name: row.accountLabel })}
                data-session-copy-check={rowKey}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{row.accountLabel}</span>
                  {row.hasHistory ? (
                    <Badge variant="outline" className="shrink-0 gap-1">
                      <History className="size-3" aria-hidden="true" />
                      {t("sessions.replica.hasHistory")}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{row.title}</p>
                {/* 会话 id 是 ledger 里**确有的**身份信息：标题取不到时，用户仍能靠它核对。 */}
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
                  {row.sessionId}
                </p>
              </div>
              {/* `updatedAt` **只作事实**展示，不派生「落后 / 最新」（§3.15.2）。 */}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {row.updatedAt !== null
                  ? formatDate(row.updatedAt)
                  : t("sessions.replica.updatedUnknown")}
              </span>
            </div>
            );
          })}
        </div>

        {/* ★★ D2：未分叉组的**常驻**说明 ——「同步是加法」。
            原先只有按钮的 `title=`（hover 才可见），而这恰恰是用户**最怕被覆盖**时
            最需要看到的一句。`title` 保留（给键盘/读屏用户），但不能是唯一载体。 */}
        {items.length > 0 && onSyncGroup ? (
          <p className="mt-3 text-xs leading-5 text-muted-foreground" data-sync-additive-note>
            {t("sessions.sync.additiveNote")}
          </p>
        ) : null}

        {/* ★★ D1：分叉组的**常驻**分歧提示（`role="alert"`）。
            分歧无法用加法合并、必须让用户先选保留哪一份 —— 这是「不许静默覆盖」
            的最后一道闸。只挂在 `title=` 上等于没有：没人会为了读一句话去 hover 每个按钮。 */}
        {group.status === "diverge" && onUnifyGroup && group.rows.length >= 2 ? (
          <Alert role="alert" variant="destructive" className="mt-3" data-unify-warning>
            <GitMerge className="size-4" aria-hidden="true" />
            <AlertDescription>{t("sessions.unify.hint")}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {/* 全选/取消 —— 删除按副本粒度，勾选与「同步」是两套动作，互不影响。 */}
          <Button
            size="sm"
            variant="ghost"
            disabled={group.rows.length === 0 || blocked}
            data-session-copy-toggle-all
            onClick={() =>
              setChecked(
                allChecked
                  ? new Set()
                  : new Set(group.rows.map((row) => `${row.accountUid}\u001f${row.sessionId}`)),
              )
            }
          >
            {allChecked ? t("sessions.delete.clearAll") : t("sessions.delete.selectAll")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={checkedRows.length === 0 || deleting || blocked}
            data-session-copy-delete
            onClick={() => setDeleteOpen(true)}
          >
            {deleting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="size-3.5" aria-hidden="true" />
            )}
            {t("sessions.delete.action", { n: checkedRows.length })}
          </Button>
          {/* ★ P8「安全同步」：**只在真有可同步内容时**才给出口（`behind` + 有增量）。
              文案如实写「加法」—— 用户对「同步」最大的恐惧是被覆盖（§3.15.4）。 */}
          {(() => {
            const titleConflict = titleChoices(group).length > 1;
            const titleOnly = items.length === 0 && titleConflict && group.status === "latest";
            if (!onSyncGroup) return null;
            if (items.length === 0 && !titleOnly) return null;
            return (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || blocked}
                data-sync-group={group.key}
                title={titleOnly ? t("sessions.sync.titleOnlyHint") : t("sessions.sync.hint")}
                onClick={() => onSyncGroup(group)}
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-3.5" aria-hidden="true" />
                )}
                {titleOnly
                  ? t("sessions.sync.titleOnly")
                  : t("sessions.sync.action", { count: items.length })}
              </Button>
            );
          })()}
          {/* ★ P8「分歧处理」：**只在 `diverge`** 给出口 —— 分歧无法用加法合并，
              必须让用户先选保留哪一份（§3.15.2「不许静默覆盖」）。 */}
          {group.status === "diverge" && onUnifyGroup && group.rows.length >= 2 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={blocked}
              data-unify-group={group.key}
              title={t("sessions.unify.hint")}
              onClick={() => onUnifyGroup(group)}
            >
              <GitMerge className="size-3.5" aria-hidden="true" />
              {t("sessions.unify.action", { count: group.rows.length - 1 })}
            </Button>
          ) : null}
        </div>
      </div>

      {/* 删除确认：说清「只删选中的副本」「正文进备份目录可找回」「其他账号不受影响」。 */}
      <Dialog
        open={deleteOpen}
        onOpenChange={(next) => {
          if (!deleting) setDeleteOpen(next);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("sessions.delete.title", { n: checkedRows.length })}</DialogTitle>
            <DialogDescription>{t("sessions.delete.desc")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-40 overflow-y-auto rounded-lg border p-2 text-xs">
            {checkedRows.map((row) => (
              <li key={`${row.accountUid}\u001f${row.sessionId}`} className="truncate px-1 py-0.5">
                {row.accountLabel} · <span className="font-mono">{row.sessionId.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteOpen(false)}>
              {t("sessions.delete.cancel")}
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void runDelete()}>
              {deleting ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-3.5" aria-hidden="true" />
              )}
              {t("sessions.delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
