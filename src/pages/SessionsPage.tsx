import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, Download, Filter, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { SessionReplicaView } from "@/components/sessions/session-replica-view";
import { UnifyReplicasDialog } from "@/components/sessions/unify-replicas-dialog";
import { ScopeChip, scopeLabel } from "@/components/scope-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import * as api from "@/lib/api";
import { useT } from "@/lib/i18n";
import { platformOfPath } from "@/lib/platforms/registry";
import { scopeOf } from "@/lib/scope";
import { buildSyncItems, buildTitleOnlyItems, buildUnifyItems, failedGroupKeys } from "@/lib/session-replicas";
import type { SessionGroupStatus, SessionGroupView } from "@/lib/session-replicas";
import type { SyncSessionReplicaItem, UnifySessionReplicaItem } from "@/lib/types";
import { useRefreshAction } from "@/lib/use-refresh-action";
import { useScope } from "@/lib/use-scope";
import { useSessionsStore } from "@/stores/sessions";

export default function SessionsPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  /* 平台从**路由**推（`/s/{scope}/sessions` 的 scope 里就带着它）——
     这样同一个骨架在 WB 分区下可用，也不必写平台判断。 */
  const product = platformOfPath(location.pathname);
  const [region] = useScope(product);
  const scope = scopeOf(product, region);

  const groups = useSessionsStore((s) => s.groups);
  const loading = useSessionsStore((s) => s.loading);
  const error = useSessionsStore((s) => s.error);
  const load = useSessionsStore((s) => s.load);
  const syncItems = useSessionsStore((s) => s.syncItems);
  const unifyItems = useSessionsStore((s) => s.unifyItems);
  /* 错误态「重试」的进行中态（按钮态，同 `syncBusy` 用 Loader2 的语言）。 */
  const { busy: retryBusy, run: runRetry } = useRefreshAction();

  /* region 变化即重载（副本按 region 分文件，P8 ✅ #2）。 */
  useEffect(() => {
    void load(region);
  }, [load, region]);

  const [statusFilter, setStatusFilter] = useState<SessionGroupStatus | "all">("all");

  const [syncBusy, setSyncBusy] = useState(false);
  const [busyGroupKeys, setBusyGroupKeys] = useState<ReadonlySet<string>>(new Set());
  const statusCounts = useMemo(() => {
    const counts = new Map<SessionGroupStatus, number>();
    for (const group of groups) {
      counts.set(group.status, (counts.get(group.status) ?? 0) + 1);
    }
    return counts;
  }, [groups]);
  const availableStatuses = useMemo(() => [...statusCounts.keys()], [statusCounts]);
  const filteredGroups = useMemo(
    () => (statusFilter === "all" ? groups : groups.filter((g) => g.status === statusFilter)),
    [groups, statusFilter],
  );
  const [sortOrder, setSortOrder] = useState<"recent" | "oldest">("recent");
  const sortedGroups = useMemo(() => {
    /* updatedAt 只用于列表排序，不参与副本状态推断；无时间戳的组稳定排在末尾。 */
    const timestampOf = (group: SessionGroupView) => {
      const timestamps = group.rows.flatMap((row) => row.updatedAt === null ? [] : [row.updatedAt]);
      return timestamps.length > 0 ? Math.max(...timestamps) : null;
    };
    return filteredGroups
      .map((group, index) => ({ group, index, timestamp: timestampOf(group) }))
      .sort((a, b) => {
        if (a.timestamp === null && b.timestamp !== null) return 1;
        if (a.timestamp !== null && b.timestamp === null) return -1;
        if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
          return sortOrder === "recent" ? b.timestamp - a.timestamp : a.timestamp - b.timestamp;
        }
        return a.index - b.index;
      })
      .map(({ group }) => group);
  }, [filteredGroups, sortOrder]);

  /* 筛选态在数据变化后可能失效（该状态已无组）⇒ 自动回落到 `all`，避免"空屏 + 假筛选"。 */
  useEffect(() => {
    if (statusFilter !== "all" && !statusCounts.has(statusFilter)) setStatusFilter("all");
  }, [statusCounts, statusFilter]);

  async function runSync(items: SyncSessionReplicaItem[], groupKeys: string[]) {
    if (syncBusy || items.length === 0) return;
    setSyncBusy(true);
    setBusyGroupKeys(new Set(groupKeys));
    try {
      const response = await syncItems(region, items);
      await load(region);

      const appended = response.results.reduce((sum, r) => sum + (r.appendedLines ?? 0), 0);

      const parts: string[] = [];
      if (response.okCount > 0) {
        parts.push(t("sessions.sync.toast.ok", { n: response.okCount, lines: appended }));
      }
      const titleFailed = response.results.filter((r) => r.titleError).length;
      if (titleFailed > 0) {
        parts.push(t("sessions.sync.toast.titleFailed", { n: titleFailed }));
      }
      if (response.failCount > 0) {
        parts.push(t("sessions.sync.toast.failed", { n: response.failCount }));
      }
      const summary = parts.join(t("shared.punct.comma"));

      const failedGroups = failedGroupKeys(response.results);
      const retryAction =
        failedGroups.length > 0
          ? {
              label: t("sessions.sync.toast.retryFailed"),
              onClick: () => retrySync(failedGroups),
            }
          : undefined;

      if (response.okCount === 0) {
        toast.error(t("sessions.sync.toast.failAll"), {
          description: summary,
          action: retryAction,
        });
      } else {
        toast.success(t("sessions.sync.toast.done"), {
          description: summary,
          action: retryAction,
        });
      }
    } catch (e) {
      toast.error(t("sessions.sync.toast.error"), { description: api.asError(e) });
    } finally {
      setSyncBusy(false);
      setBusyGroupKeys(new Set());
    }
  }

  function retrySync(groupKeys: string[]) {
    const wanted = new Set(groupKeys);
    const items = useSessionsStore
      .getState()
      .groups.filter((group) => wanted.has(group.key))
      .flatMap((group) => buildSyncItems(group));
    if (items.length === 0) {
      toast.info(t("sessions.sync.toast.nothingToRetry"));
      return;
    }
    void runSync(items, groupKeys);
  }

  /** 单个组：同步它所有落后的副本。 */
  function syncGroup(group: SessionGroupView, title?: string) {
    const items =
      title && group.status !== "behind"
        ? buildTitleOnlyItems(group, title)
        : buildSyncItems(group, title);
    void runSync(items, [group.key]);
  }

  /** 页头批量：把所有「有可同步内容」的组一次跑完（仍逐条返回 ⇒ 部分失败可重试）。 */
  const allSyncable = useMemo(
    () => groups.map((group) => ({ group, items: buildSyncItems(group) })).filter((x) => x.items.length > 0),
    [groups],
  );

  function syncAll() {
    void runSync(
      allSyncable.flatMap((x) => x.items),
      allSyncable.map((x) => x.group.key),
    );
  }

  const [unifyTarget, setUnifyTarget] = useState<SessionGroupView | null>(null);
  const [unifyBusy, setUnifyBusy] = useState(false);

  async function runUnify(items: UnifySessionReplicaItem[], keepSessionId: string) {
    if (unifyBusy || items.length === 0) return;
    setUnifyBusy(true);
    try {
      const response = await unifyItems(region, items);
      // 列表状态来自内容指纹 ⇒ 不重载会继续显示「有分歧」（看起来像没生效）。
      await load(region);

      const lost = response.results.reduce((sum, r) => sum + (r.lostLines ?? 0), 0);

      const parts: string[] = [];
      if (response.okCount > 0) {
        parts.push(t("sessions.unify.toast.ok", { n: response.okCount, lost }));
      }
      if (response.failCount > 0) {
        parts.push(t("sessions.unify.toast.failed", { n: response.failCount }));
      }
      const summary = parts.join(t("shared.punct.comma"));

      /* ⚠️ 与同步同款：重试**按组重算**（保留用户选的那一份不变），不复用旧 items。 */
      const failedGroups = failedGroupKeys(response.results);
      const retryAction =
        failedGroups.length > 0
          ? {
              label: t("sessions.unify.toast.retryFailed"),
              onClick: () => retryUnify(failedGroups, keepSessionId),
            }
          : undefined;

      if (response.okCount === 0) {
        toast.error(t("sessions.unify.toast.failAll"), { description: summary, action: retryAction });
      } else {
        toast.success(t("sessions.unify.toast.done"), { description: summary, action: retryAction });
      }
    } catch (e) {
      toast.error(t("sessions.unify.toast.error"), { description: api.asError(e) });
    } finally {
      setUnifyBusy(false);
      // 无论成败都收起对话框：失败项留在 toast 的「只重试失败项」里，不必让用户重选。
      setUnifyTarget(null);
    }
  }

  function retryUnify(groupKeys: string[], keepSessionId: string) {
    const wanted = new Set(groupKeys);
    const items = useSessionsStore
      .getState()
      .groups.filter((group) => wanted.has(group.key))
      .flatMap((group) => buildUnifyItems(group, keepSessionId));
    if (items.length === 0) {
      toast.info(t("sessions.unify.toast.nothingToRetry"));
      return;
    }
    void runUnify(items, keepSessionId);
  }

  /** 对话框确认：把「选定保留的那一份」换算成覆盖任务（`buildUnifyItems` 会挡住非法输入）。 */
  function confirmUnify(keepSessionId: string) {
    if (!unifyTarget) return;
    void runUnify(buildUnifyItems(unifyTarget, keepSessionId), keepSessionId);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5 px-7 pt-[26px] pb-[60px]">
      {/* 页头（原型 `viewSessions`）：28px 标题 + 作用域副标题 + 只读 scope-chip。
          批量出口仍**只在真有可同步项时**出现（§3.4 规则 1，不摆假控件）。 */}
      <header className="flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-[640] tracking-[-0.02em]">{t("sessions.title")}</h1>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">
            {t("pageHead.sessions", { scope: scopeLabel(t, scope) })}
          </p>
        </div>
        <div className="grow" />
        {allSyncable.length > 0 ? (
          <Button
            size="default"
            variant="outline"
            disabled={syncBusy}
            data-sync-all="true"
            title={t("sessions.sync.hint")}
            onClick={syncAll}
          >
            {syncBusy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-3.5" aria-hidden="true" />
            )}
            {t("sessions.sync.all", { count: allSyncable.reduce((n, x) => n + x.items.length, 0) })}
          </Button>
        ) : null}
        <ScopeChip scope={scope} />
      </header>

      {loading ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      ) : error ? (
        // 失败不静默：给出原因 + 重试（**不**退化成「暂无数据」，那会误导用户）。
        <Card className="items-center gap-3 py-8">
          <AlertTriangle className="size-8 text-muted-foreground/60" aria-hidden="true" />
          <p className="max-w-md text-center text-sm text-muted-foreground">{error}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={retryBusy}
            onClick={() => void runRetry(() => load(region))}
          >
            {retryBusy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden="true" />
            )}
            {t("sessions.error.retry")}
          </Button>
        </Card>
      ) : groups.length > 0 ? (
        <>
          {/* ★ 工具栏（原型 `viewSessions`，:3183）：标题 =「{客户端} 会话」+ 计数徽标。
              ⚠️ **不渲染客户端 Tab**（会话复制只有 WorkBuddy ⇒ 单选项是假控件，§3.15.1）
              ⇒ 标题退化成静态文本。状态筛选**按需出现**：**至少 2 个可选状态**才渲染整条
              （单选项的切换器依旧是假控件），且**只列数据里真有的状态**（§3.4 规则 1）。 */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2.5">
            <h2 className="flex items-center gap-2 text-[13.5px] font-semibold">
              {t("sessions.toolbar.title", { client: t("sessions.toolbar.client") })}
              <Badge variant="secondary">{groups.length}</Badge>
            </h2>
            <div className="grow" />
            {availableStatuses.length >= 2 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <Filter className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Button
                  size="sm"
                  variant={statusFilter === "all" ? "default" : "outline"}
                  onClick={() => setStatusFilter("all")}
                  data-status-filter="all"
                >
                  {t("sessions.filter.all", { count: groups.length })}
                </Button>
                {availableStatuses.map((status) => (
                  <Button
                    key={status}
                    size="sm"
                    variant={statusFilter === status ? "default" : "outline"}
                    onClick={() => setStatusFilter(status)}
                    data-status-filter={status}
                  >
                    {t(`sessions.replica.status.${status}`)}
                    {` (${statusCounts.get(status) ?? 0})`}
                  </Button>
                ))}
              </div>
            ) : null}
            {/* ★ 排序（原型 `.sess-sort-seg`，:3187-3190）：最近更新 / 最早更新。
                ⚠️ 这里只排**列表顺序**，绝不参与「落后 / 分叉」状态推断（§3.15.2）。 */}
            <div
              className="flex items-center gap-1 rounded-lg bg-muted p-1"
              role="group"
              aria-label={t("sessions.sort.aria")}
            >
              <Button
                size="sm"
                variant={sortOrder === "recent" ? "default" : "ghost"}
                className="h-6 px-2 text-xs"
                onClick={() => setSortOrder("recent")}
                data-sort-order="recent"
                aria-pressed={sortOrder === "recent"}
              >
                {t("sessions.sort.recent")}
              </Button>
              <Button
                size="sm"
                variant={sortOrder === "oldest" ? "default" : "ghost"}
                className="h-6 px-2 text-xs"
                onClick={() => setSortOrder("oldest")}
                data-sort-order="oldest"
                aria-pressed={sortOrder === "oldest"}
              >
                {t("sessions.sort.oldest")}
              </Button>
            </div>
          </div>
          <SessionReplicaView
            groups={sortedGroups}
            onSyncGroup={syncGroup}
            busyGroupKeys={busyGroupKeys}
            onUnifyGroup={setUnifyTarget}
          />
        </>
      ) : (
        <Card className="gap-0 py-0">
          {/* 空态四要素（§3.6）：图标 + 标题 + 说明 + **出口**。
              ⚠️ 出口是「去账号页复制」——空态必须告诉用户下一步做什么，
              只给一句「暂无数据」等于把用户丢在原地（见 EmptyState 头注释）。 */}
          <EmptyState
            icon={GitBranch}
            title={t("sessions.empty.title")}
            description={t("sessions.empty.description")}
            action={
              <Button size="sm" onClick={() => navigate(`/s/${scopeOf(product, region)}/accounts`)}>
                {t("sessions.empty.action")}
              </Button>
            }
          />
        </Card>
      )}

      {/* ★ P8 分歧处理：**覆盖式**统一 —— 必须「先选保留哪一份、再确认」（§3.15.2）。
          `group` 为 null ⇒ 不渲染（`UnifyReplicasDialog` 内部亦早退）。 */}
      <UnifyReplicasDialog
        group={unifyTarget}
        onOpenChange={(open) => {
          if (!open) setUnifyTarget(null);
        }}
        busy={unifyBusy}
        onConfirm={confirmUnify}
      />
    </div>
  );
}
