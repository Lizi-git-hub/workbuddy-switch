
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ListTree, RotateCw, SearchX, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { AccountCard, cacheReadOf, todayTokenNet, type GuideTarget } from "@/components/account-card";
import { TraeAccountCard } from "@/components/trae-account-card";
import { QoderAccountCard } from "@/components/qoder/qoder-account-card";
import { AggregateFilterPanel } from "@/components/aggregate/aggregate-filter-panel";
import {
  AggregateExportButton,
  AggregateExportDialog,
  groupExportTargets,
} from "@/components/aggregate/aggregate-export-button";
import { useAggregateWbSwitcher } from "@/components/aggregate/aggregate-wb-switcher";
import { useAggregateTraeSwitcher } from "@/components/aggregate/aggregate-trae-switcher";
import { useAggregateQoderSwitcher } from "@/components/aggregate/aggregate-qoder-switcher";
import { RestartConfirmDialog } from "@/components/restart-confirm-dialog";
import { SwitchAccountDialog } from "@/components/switch-account-dialog";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import { ScopeMark, scopeLabel } from "@/components/scope-chip";
import {
  AccountDetailDrawer,
  type DetailActions,
  type DetailSwitchTarget,
} from "@/components/account-detail-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/api";
import { checkinCreditsOf } from "@/lib/api";
import {
  AGGREGATE_SOURCES,
  aggregateAccountKey,
  aggregateDisplayName,
  aggregateNeedsAttention,
  aggregateSubtitle,
  aggregateTotals,
  filterAggregateAccounts,
  groupAggregateAccounts,
  newcomerAccounts,
  pruneVisibleKeys,
  sortByUrgency,
  visibleKeysToStore,
  type AggregateAccount,
} from "@/lib/aggregate-accounts";
import { useAggregateAccounts } from "@/lib/use-aggregate-accounts";
import {
  checkinTodayOf,
  signalKeyOf,
  todayTokensOf,
  traeProgramsOf,
  useAggregateSignals,
} from "@/lib/use-aggregate-signals";
import { useAggregateVisible, subscribeAggregateVisibleStorage } from "@/lib/aggregate-visibility-pref";
import {
  aggregateDetailPacks,
  aggregateDetailPrograms,
  aggregateDetailSections,
  aggregateDetailStats,
  type AggregateDetailContext,
} from "@/lib/aggregate-detail";
import { useT } from "@/lib/i18n";
import { SCOPES, scopeParts, type Scope } from "@/lib/scope";
import type { AccountMeta, CheckinLog, CreditStatsEvent, Region } from "@/lib/types";
import { isWorkbuddyCurrent } from "@/lib/account-current";
import { pickPriorityAccountId } from "@/lib/credit-priority";
import { lastSevenDays, localDateKey } from "@/lib/checkin-history";
import { useWbProgramStatuses, wbProgramAvailability } from "@/lib/wb-program-statuses";
import {
  QODER_REFRESH_KINDS,
  REFRESH_DONE_LABEL,
  useAccountRefreshBusy,
  type AccountRefreshKind,
} from "@/lib/account-refresh";
import { showUndoToast } from "@/lib/undo-toast";
import { useAccountsStore } from "@/stores/accounts";
import { cn } from "@/lib/utils";

type AggregateMode = "group" | "flat";

/** 取该作用域对应的 Trae 账号库变体（删除 / 刷新 JWT 都要它）。 */
function traeVariantOf(scope: Scope) {
  const source = AGGREGATE_SOURCES.find((item) => item.scope === scope);
  return source && source.platform === "trae" ? source.variant : "trae_merged";
}

export default function AggregateAccountsPage() {
  const t = useT();

  const { accounts, failed, loading, pending, reload } = useAggregateAccounts();
  /**
   * 信号层（今日 Token / 签到 / 程序位 / 积分）。
   *
   * ⚠️ 与账号列表**分开取**：账号列表说「有哪些账号」，信号层说「它们今天怎么样」。
   * 合在一起会让 6 个作用域的账号列表被信号层的慢命令拖住。
   */
  const { byScope: signalsByScope, reload: reloadSignals } = useAggregateSignals(accounts);
  const [rawVisible, setRawVisible] = useAggregateVisible();

  /**
   * WorkBuddy 的积分快照（按区域分两份）。
   *
   * ⚠️ **必须订阅 store，不能 `getState()`**：积分是异步刷新的，`getState()` 拿到的
   * 是渲染那一刻的旧值，刷新完不会重渲染 —— 卡片上的积分会一直停在「—」。
   */
  const wbCnCredit = useAccountsStore((s) => s.creditMap);
  const wbGlobalCredit = useAccountsStore((s) => s.global.creditMap);
  const wbCnCreditLoading = useAccountsStore((s) => s.creditLoadingMap);
  const wbGlobalCreditLoading = useAccountsStore((s) => s.global.creditLoadingMap);
  /* 客户端「当前登录」来自 AppStatus（后端读客户端认证文件），与账号库主键不同源。 */
  /* 四个外部程序位（CLI / IDE / VS Code / JetBrains）：**全局**一份（命令无 region 参数）。 */
  const wbPrograms = useWbProgramStatuses();
  /* WB 四个程序位的切换：与账号页**共用统一的重启确认框**（见 aggregate-wb-switcher.tsx）。 */
  const wbSwitch = useAggregateWbSwitcher(() => {
    void reload();
  });
  const traeSwitch = useAggregateTraeSwitcher(() => {
    void reload();
    void reloadSignals();
  });
  const qoderSwitch = useAggregateQoderSwitcher(() => {
    void reload();
    void reloadSignals();
  });
  const [exportTarget, setExportTarget] = useState<AggregateAccount | null>(null);

  const [oauthRegion, setOauthRegion] = useState<Region | null>(null);
  const [qoderPackMap, setQoderPackMap] = useState<Record<string, api.QoderWebCreditPacks>>({});
  /** 上次取数时刻（TTL 用 ref：改它不该触发重渲染）。 */
  const qoderPackFetchedAt = useRef<Record<string, number>>({});

  /** WorkBuddy 主程序位（「WB」那枚）的切换：与账号页同一个向导（含会话迁移）。 */
  const [wbSwitchDialog, setWbSwitchDialog] = useState<{
    account: AccountMeta;
    region: Region;
  } | null>(null);

  const navigate = useNavigate();
  const onGuideToSetting = useCallback(
    (item: AggregateAccount, target: GuideTarget) => {
      toast.info(
        target === "ide"
          ? t("wbAccounts.toast.guideIdeSetting")
          : t("wbAccounts.toast.guideCliSetting"),
      );
      navigate(`/s/${item.scope}/settings?section=diagnostics`);
    },
    [navigate, t],
  );

  const onGuidePlugin = useCallback(
    (programId: string) => {
      const client =
        programId === "vscode_codebuddy_plugin"
          ? t("wbAccounts.program.vscodeCodebuddyPlugin")
          : t("wbAccounts.program.jetbrainsCodebuddyPlugin");
      toast.info(t("wbAccounts.card.guidePlugin", { client }));
    },
    [t],
  );
  const wbProgramAvail = wbProgramAvailability(wbPrograms);
  const wbCnStatus = useAccountsStore((s) => s.status);
  const wbGlobalStatus = useAccountsStore((s) => s.global.status);
  const creditOf = useCallback(
    (scope: Scope, id: string) =>
      scopeParts(scope).region === "cn" ? wbCnCredit[id] : wbGlobalCredit[id],
    [wbCnCredit, wbGlobalCredit],
  );

  const priorityIdByScope = useMemo(() => {
    const grouped = new Map<Scope, AccountMeta[]>();
    for (const account of accounts) {
      if (account.platform !== "workbuddy") continue;
      const list = grouped.get(account.scope) ?? [];
      list.push(account.data);
      grouped.set(account.scope, list);
    }
    const out = new Map<Scope, string>();
    for (const [scope, list] of grouped) {
      const id = pickPriorityAccountId(list, (account) => creditOf(scope, account.id));
      if (id) out.set(scope, id);
    }
    return out;
  }, [accounts, creditOf]);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<AggregateMode>("group");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [panelQuery, setPanelQuery] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<Scope>>(new Set());
  const [detailRef, setDetailRef] = useState<string | null>(null);
  /** 抽屉是否直接进入「备注编辑态」/「分组编辑态」（卡片「更多」里的两个入口）。 */
  const [detailAutoEditRemark, setDetailAutoEditRemark] = useState(false);
  const [detailAutoEditGroup, setDetailAutoEditGroup] = useState(false);
  const [dismissedNewcomers, setDismissedNewcomers] = useState<Set<string>>(new Set());

  /* 跨标签页同步（webui 可能开多个）：别的标签改了筛选，这里要跟着变。 */
  useEffect(() => subscribeAggregateVisibleStorage(), []);

  /** 当前真实存在的全部账号键。**筛选的有效性以它为界**（账号被删 ⇒ 键自动失效）。 */
  const universe = useMemo(() => accounts.map((account) => account.ref), [accounts]);

  /**
   * 可见集。
   *
   * ⚠️ 加载中（`universe` 为空）时 `pruneVisibleKeys` 返回 `null` = 全量 ——
   * **加载中态优先于筛选态**，否则会出现「筛选键已读到、账号还没到」的空白页。
   */
  const visible = useMemo(() => pruneVisibleKeys(rawVisible, universe), [rawVisible, universe]);

  const shown = useMemo(
    () => filterAggregateAccounts(accounts, visible, query),
    [accounts, visible, query],
  );
  const totals = useMemo(() => aggregateTotals(accounts), [accounts]);
  /** 筛选生效期间新出现（因而看不见）的账号（Q3 方案 C）；已「忽略」的不再提示。 */
  const newcomers = useMemo(
    () => newcomerAccounts(accounts, visible).filter((account) => !dismissedNewcomers.has(account.ref)),
    [accounts, dismissedNewcomers, visible],
  );
  const groups = useMemo(() => groupAggregateAccounts(shown), [shown]);
  const flat = useMemo(() => sortByUrgency(shown), [shown]);

  const filtering = visible !== null || Boolean(query.trim());
  const selectedRefs = useMemo(() => [...selected], [selected]);
  /** 导出目标：**选中优先**，没选中则导全部可见的。跨作用域 ⇒ 由按钮让用户选一个作用域。 */
  const exportTargets = useMemo(() => {
    const picked = accounts.filter((account) => selected.has(account.ref));
    const source = picked.length > 0 ? picked : shown;
    return groupExportTargets(source);
  }, [accounts, selected, shown]);

  /* 批量选择只保留仍然存在的账号（删除 / 换筛选后自动收敛，不留幽灵键）。 */
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(universe);
      const next = new Set([...prev].filter((ref) => live.has(ref)));
      return next.size === prev.size ? prev : next;
    });
  }, [universe]);

  const toggleSelect = useCallback((ref: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }, []);

  const applyFilter = useCallback(() => {
    const next = visibleKeysToStore(draft, universe);
    setRawVisible(next);
    setFilterOpen(false);
    /* 可见集变了 ⇒ 旧的批量选择可能已不在屏上。 */
    setSelected(new Set());
    if (next === null) toast.success(t("aggregate.toast.showAll"));
    else toast.success(t("aggregate.toast.filtered", { shown: next.length, total: universe.length }), {
      description: t("aggregate.toast.filteredDesc"),
    });
  }, [draft, universe, setRawVisible, t]);

  const clearFilter = useCallback(() => {
    setRawVisible(null);
    setQuery("");
    setSelected(new Set());
    toast.success(t("aggregate.toast.showAll"), { description: t("aggregate.toast.filterCleared") });
  }, [setRawVisible, t]);

  const openFilter = useCallback(() => {
    setDraft(new Set(visible ?? universe));
    setPanelQuery("");
    setExpanded(new Set());
    setFilterOpen(true);
  }, [visible, universe]);

  const [confirmDelete, setConfirmDelete] = useState<
    { kind: "one"; account: AggregateAccount } | { kind: "batch"; count: number } | null
  >(null);

  const performDelete = useCallback(
    async (account: AggregateAccount) => {
      const scope = account.scope;
      const key = aggregateAccountKey(account);
      const name = aggregateDisplayName(account);
      try {
        if (account.platform === "workbuddy") {
          await useAccountsStore.getState().deleteAccount(key, scopeParts(scope).region);
        } else if (account.platform === "trae") {
          await api.traeDeleteAccount(key, false, traeVariantOf(scope));
        } else {
          await api.qoderDeleteAccount(scope, key);
        }
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(account.ref);
          return next;
        });
        await reload();
        showUndoToast({
          title: t("undo.deletedTitle"),
          description: name,
          undoLabel: t("undo.action"),
          undoneTitle: t("undo.undone"),
          undo: async () => {
            await api.accountRestore(scope, key);
            await reload();
          },
        });
      } catch (error) {
        toast.error(t("wbAccounts.toast.deleteFail"), { description: api.asError(error) });
      }
    },
    [reload, t],
  );

  /* ── 备注 / 分组：就地保存（抽屉负责收起编辑器）──────────────────
     ⚠️ 两个平台的**参数形态不同**，这是最容易写错且不报错的一处：
       · `setAccountRemark` / `setAccountGroup` 吃 **`region`**（不是 scope）；
       · `qoderSetAccountRemark` / `qoderSetAccountGroup` 吃 **`scope`**。
     传错不会抛错，只会静默改到另一个区域的账号上。 */
  const saveRemark = useCallback(
    async (account: AggregateAccount, remark: string): Promise<boolean> => {
      try {
        if (account.platform === "workbuddy") {
          await api.setAccountRemark(account.data.id, remark, scopeParts(account.scope).region);
        } else if (account.platform === "trae") {
          await api.traeSetAccountRemark(account.data.userId, remark, traeVariantOf(account.scope));
        } else {
          await api.qoderSetAccountRemark(account.scope, account.data.uid, remark || null);
        }
        await reload();
        return true;
      } catch (error) {
        toast.error(api.asError(error));
        return false;
      }
    },
    [reload],
  );

  const saveGroup = useCallback(
    async (account: AggregateAccount, group: string): Promise<boolean> => {
      try {
        if (account.platform === "workbuddy") {
          await api.setAccountGroup(account.data.id, group, scopeParts(account.scope).region);
        } else if (account.platform === "qoder") {
          await api.qoderSetAccountGroup(account.scope, account.data.uid, group || null);
        } else {
          /* Trae 的分组是 `groupId`（不是自由文本）⇒ 抽屉不渲染该区块，走到这里说明调用方传错了。 */
          return false;
        }
        await reload();
        return true;
      } catch (error) {
        toast.error(api.asError(error));
        return false;
      }
    },
    [reload],
  );

  /* ── 批量动作 ────────────────────────────────────────────────────
     三个平台的批量能力**不同**，必须分开跑：
       · WorkBuddy：逐账号 `checkin(id, region)`（没有真批量命令）；
       · Trae：`traeCheckin({ userIds, variant })` —— **真批量**，一次调用；
       · Qoder：只有单账号 `qoderCheckinClaim(scope, uid)` ⇒ 前端循环。
     把三者写成「都循环一遍」会让 Trae 侧白白发 N 次请求。 */
  const batchCheckin = useCallback(async () => {
    const targets = accounts.filter((account) => selected.has(account.ref));
    if (targets.length === 0) return;
    let ok = 0;
    let fail = 0;
    for (const account of targets) {
      try {
        if (account.platform === "workbuddy") {
          await api.checkin(account.data.id, scopeParts(account.scope).region);
        } else if (account.platform === "qoder") {
          await api.qoderCheckinClaim(account.scope, account.data.uid);
        }
        /* Trae 在循环外统一发一次（见下）。 */
        if (account.platform !== "trae") ok += 1;
      } catch {
        if (account.platform !== "trae") fail += 1;
      }
    }
    const traeTargets = targets.filter((account) => account.platform === "trae");
    for (const scope of new Set(traeTargets.map((account) => account.scope))) {
      const userIds = traeTargets.filter((account) => account.scope === scope).map((account) => account.data.userId);
      try {
        const report = await api.traeCheckin({ scope: "selected", userIds, variant: traeVariantOf(scope) });
        ok += (report.totalOk ?? 0) + (report.already ?? 0);
        fail += report.failed ?? 0;
      } catch {
        fail += userIds.length;
      }
    }
    await reload();
    if (fail > 0) toast.error(t("aggregate.toast.checkinPartial", { ok, fail }));
    else toast.success(t("aggregate.toast.checkinDone", { n: ok }));
    setSelected(new Set());
  }, [accounts, reload, selected, t]);

  const [traeBusy, setTraeBusy] = useState<string | null>(null);

  /**
   * 跑一个 Trae 单账号动作：置忙 → 执行 → 重取账号与信号 → 失败报错 → 复位。
   *
   * 抽成函数而不是四个内联箭头：内联版本此前**既没有忙标记、也没有统一的失败文案**，
   * 而「同一动作两处实现」正是本仓反复出现的分叉来源。
   */
  const runTraeAction = useCallback(
    async (item: AggregateAccount, key: string, action: () => Promise<void>) => {
      if (item.platform !== "trae") return;
      setTraeBusy(key);
      try {
        await action();
        await reload();
        void reloadSignals();
      } catch (error) {
        toast.error(api.asError(error), { description: aggregateDisplayName(item) });
      } finally {
        setTraeBusy(null);
      }
    },
    [reload, reloadSignals],
  );

  const checkinTrae = useCallback(
    (item: AggregateAccount) => {
      if (item.platform !== "trae") return;
      const variant = traeVariantOf(item.scope);
      void runTraeAction(item, `checkin-${item.data.userId}`, async () => {
        const label = aggregateDisplayName(item);
        const result = await api.traeCheckin({
          scope: "selected",
          userIds: [item.data.userId],
          variant,
        });
        const outcome = result.results[0];
        if (!outcome) {
          toast.info(t("trae.page.accounts.checkinNotRun"), {
            description:
              result.warnings[0] ?? t("trae.page.accounts.checkinSkippedDesc", { name: label }),
          });
        } else if (outcome.action === "skip_already") {
          toast.success(t("trae.page.accounts.alreadyCheckedToday"), { description: label });
        } else if (!outcome.ok) {
          toast.error(t("trae.page.accounts.checkinFailed"), {
            description: t("trae.page.accounts.checkinFailedDesc", {
              name: label,
              reason: outcome.message || outcome.action,
            }),
          });
        } else {
          toast.success(t("trae.page.accounts.checkinSuccess"), {
            description:
              outcome.delta > 0
                ? t("trae.page.accounts.checkinSuccessDesc", { name: label, delta: outcome.delta })
                : label,
          });
        }
      });
    },
    [runTraeAction, t],
  );

  /**
   * 单账号签到（Qoder）。
   *
   * 后端 `qoderCheckinClaim` 返回 `{ ok, disabled, rewardCredits }` 三态：
   * `disabled` = 活动未开放（**不是失败**，报成失败会让用户以为账号有问题）。
   */
  const checkinQoder = useCallback(
    async (item: AggregateAccount) => {
      if (item.platform !== "qoder") return;
      const name = aggregateDisplayName(item);
      try {
        const result = await api.qoderCheckinClaim(item.scope, item.data.uid);
        if (result.ok) {
          toast.success(t("qoder.page.accounts.checkin.done", { name }), {
            description:
              result.rewardCredits && result.rewardCredits > 0 ? `+${result.rewardCredits}` : undefined,
          });
        } else if (result.disabled) {
          /* 活动通道未开放 —— 事实，不是错误。 */
          toast.info(t("qoder.page.accounts.chip.checkinUnavailable"), { description: name });
        } else {
          toast.error(t("qoder.page.accounts.checkin.resultFail", { n: 1 }), { description: name });
        }
        await reload();
        void reloadSignals();
      } catch (error) {
        toast.error(api.asError(error), { description: name });
      }
    },
    [reload, reloadSignals, t],
  );

  const refreshTraeCredits = useCallback(
    async (item: AggregateAccount) => {
      if (item.platform !== "trae") return;
      const description = aggregateDisplayName(item);
      try {
        await api.traeRefreshCredits(item.data.userId, traeVariantOf(item.scope));
        await reloadSignals();
        toast.success(t(REFRESH_DONE_LABEL.credits), { description });
      } catch (error) {
        toast.error(api.asError(error), { description });
      }
    },
    [reloadSignals, t],
  );

  const checkinOne = useCallback(
    async (item: AggregateAccount) => {
      if (item.platform !== "workbuddy") return;
      const region = scopeParts(item.scope).region;
      const description = aggregateDisplayName(item);
      try {
        const res = await api.checkin(item.data.id, region);
        const label =
          res.result === "success"
            ? t("wbAccounts.toast.checkinSuccess")
            : res.result === "already"
              ? t("wbAccounts.toast.checkedInToday")
              : t("wbAccounts.toast.checkinFail");
        if (res.result === "error") {
          toast.error(label, { description: res.error ? `${description} · ${res.error}` : description });
        } else {
          toast.success(label, { description });
        }
        await reload();
        void reloadSignals();
      } catch (error) {
        toast.error(t("wbAccounts.toast.checkinFail"), { description: api.asError(error) });
      }
    },
    [reload, reloadSignals, t],
  );

  /**
   * 批量刷新（**当前可见的全部账号**，不是选中的那些）。
   *
   * ⚠️ 与批量签到/删除**刻意不同**：签到与删除是「作用于选中的」，而刷新是
   * 「让这一屏的数据变新」—— 刷的是**看得到的东西**。若也只刷选中的，用户会问
   * 「我刷新了整页，怎么别的卡片没变」。
   *
   * 逐作用域调用（每类信号一条命令），不逐账号 —— 逐账号会变成 N×N 次上游查询。
   */
  const batchRefresh = useCallback(async () => {
    const scopes = new Set(accounts.map((account) => account.scope));
    try {
      for (const scope of scopes) {
        const items = accounts.filter((account) => account.scope === scope);
        const source = AGGREGATE_SOURCES.find((item) => item.scope === scope);
        if (!source) continue;
        if (source.platform === "workbuddy") {
          const region = scopeParts(scope).region;
          const ids = items
            .filter((item) => item.platform === "workbuddy")
            .map((item) => item.data.id);
          await api.getAccountTokenToday(region, true);
          await api.getCheckinStatusMap(ids, region);
        } else if (source.platform === "trae") {
          await api.getTraeAccountTokenToday(source.variant, true);
          await api.getTraeCheckinStatusMap(
            source.variant,
            items.filter((item) => item.platform === "trae").map((item) => item.data.userId),
          );
        } else {
          await api.qoderCheckinStatusMap(
            scope,
            items.filter((item) => item.platform === "qoder").map((item) => item.data.uid),
          );
          await api.qoderCredits(scope);
        }
      }
      await reload();
      await reloadSignals();
      toast.success(t("aggregate.toast.refreshed", { n: scopes.size }), {
        description: t("aggregate.toast.refreshedDesc", { n: accounts.length }),
      });
    } catch (error) {
      toast.error(t("shared.refreshPart.fail"), { description: api.asError(error) });
    }
  }, [accounts, reload, reloadSignals, t]);

  const batchDelete = useCallback(async () => {
    const targets = accounts.filter((account) => selected.has(account.ref));
    if (targets.length === 0) return;
    const deleted: AggregateAccount[] = [];
    let fail = 0;
    for (const account of targets) {
      try {
        if (account.platform === "workbuddy") {
          await useAccountsStore.getState().deleteAccount(account.data.id, scopeParts(account.scope).region);
        } else if (account.platform === "trae") {
          await api.traeDeleteAccount(account.data.userId, false, traeVariantOf(account.scope));
        } else {
          await api.qoderDeleteAccount(account.scope, account.data.uid);
        }
        deleted.push(account);
      } catch {
        fail += 1;
      }
    }
    setSelected(new Set());
    await reload();
    if (fail > 0) toast.error(t("aggregate.toast.deletePartial", { fail }));
    if (deleted.length > 0) {
      showUndoToast({
        title: t("undo.batchTitle", { n: deleted.length }),
        undoLabel: t("undo.action"),
        undoneTitle: t("undo.undone"),
        /* 撤销逐个恢复：一个失败不阻断其余（与账号页 `offerUndo` 同口径）。 */
        undo: async () => {
          for (const account of deleted) {
            await api.accountRestore(account.scope, aggregateAccountKey(account));
          }
          await reload();
        },
      });
    }
  }, [accounts, reload, selected, t]);

  /**
   * 单项刷新（四项各自独立）—— 与账号页**同一条路径**。
   *
   * ## 刷新后要重拉两层
   *
   * ① **信号层**（今日 Token / 签到 / 积分）：`reloadSignals()`。
   *    信号是**逐作用域**的（一次命令给一批），所以刷新一个账号后重拉该作用域的信号
   *    是最小代价 —— 逐账号精确刷新反而要求后端提供单账号命令（Trae / Qoder 才有）。
   * ② **账号列表**（凭据元信息）：`reload()`。
   *
   * ⚠️ 账号页的教训：**只刷一层会「点了没反应」**（账号页曾因只换 accounts 数组、
   * 不动四张 map 而出现「刷新了却看不到变化」）。
   */
  const refreshBusy = useAccountRefreshBusy();

  const refreshPart = useCallback(
    async (account: AggregateAccount, kind: AccountRefreshKind) => {
      const label = aggregateDisplayName(account);
      await refreshBusy.run(account.ref, kind, async () => {
        try {
          if (account.platform === "workbuddy") {
            const region = scopeParts(account.scope).region;
            if (kind === "credits") {
              await useAccountsStore.getState().refreshCredits([account.data.id], { region });
            } else if (kind === "tokens") {
              /* `force=true`：用户显式点了刷新，绕过后端「距上次扫描不足 TTL」的闸门。 */
              await api.getAccountTokenToday(region, true);
            } else if (kind === "checkin") {
              await api.getCheckinStatusMap([account.data.id], region);
            } else {
              await reload();
            }
          } else if (account.platform === "trae") {
            const variant = traeVariantOf(account.scope);
            if (kind === "credits") {
              await api.traeRefreshCredits(account.data.userId, variant);
            } else if (kind === "tokens") {
              await api.getTraeAccountTokenToday(variant, true);
            } else if (kind === "checkin") {
              await api.getTraeCheckinStatusMap(variant, [account.data.userId]);
            } else {
              await reload();
            }
          } else {
            /* Qoder **没有 token 概念**（见 `qoder::usage` 模块头）⇒ 卡片的刷新项里
               本来就没有「今日 Token」，这里也不会收到。 */
            if (kind === "credits") {
              await api.qoderRefreshAccount(account.scope, account.data.uid);
            } else if (kind === "checkin") {
              await api.qoderCheckinStatusMap(account.scope, [account.data.uid]);
            } else {
              await reload();
            }
          }
          await reloadSignals();
          toast.success(t(REFRESH_DONE_LABEL[kind]), { description: label });
        } catch (error) {
          toast.error(t("shared.refreshPart.fail"), { description: api.asError(error) });
        }
      });
    },
    [refreshBusy, reload, reloadSignals, t],
  );

  /** 打开抽屉（可指定直接进入某个编辑态）。卡片只发信号，状态由页面持有（同账号页）。 */
  const openDetail = useCallback(
    (ref: string, mode?: "remark" | "group") => {
      setDetailAutoEditRemark(mode === "remark");
      setDetailAutoEditGroup(mode === "group");
      setDetailRef(ref);
    },
    [],
  );

  /* ── 卡片分派：**同一张三张卡之一**，不新建第四种 ── */
  const renderCard = useCallback(
    (item: AggregateAccount) => {
      const signals = signalsByScope.get(item.scope);
      const todayTokens = todayTokensOf(signals, item);
      const checkinToday = checkinTodayOf(signals, item);
      const common = {
        selected: selected.has(item.ref),
        onToggleSelect: () => toggleSelect(item.ref),
        onOpenDetail: () => openDetail(item.ref),
        featuresDisabled: false,
      };
      if (item.platform === "workbuddy") {
        const region = scopeParts(item.scope).region;
        return (
          <AccountCard
            key={item.ref}
            account={item.data}
            onDelete={() => setConfirmDelete({ kind: "one", account: item })}
            credit={creditOf(item.scope, item.data.id)}
            creditLoading={region === "cn" ? wbCnCreditLoading[item.data.id] : wbGlobalCreditLoading[item.data.id]}
            /* 「当前登录」判定与账号页**共用** `isWorkbuddyCurrent`（见 `lib/account-current.ts`）。 */
            workbuddyActive={isWorkbuddyCurrent(item.data, (region === "cn" ? wbCnStatus : wbGlobalStatus)?.current)}
            codebuddyCliConfigured={wbProgramAvail.cliConfigured}
            codebuddyCliGatewayMode={wbProgramAvail.cliGatewayMode}
            onSwitch={() => setWbSwitchDialog({ account: item.data, region })}
            onGuideToSetting={(target) => onGuideToSetting(item, target)}
            onGuidePlugin={onGuidePlugin}
            onExport={() => setExportTarget(item)}
            onAddPlaintextAccount={() => setOauthRegion(scopeParts(item.scope).region)}
            onSwitchCodebuddyCli={() => wbSwitch.request("cli", item)}
            onSwitchCodebuddyCnIde={() => wbSwitch.request("ide", item)}
            onSwitchVscodePlugin={() => wbSwitch.request("vscode", item)}
            onSwitchJetbrainsPlugin={() => wbSwitch.request("jetbrains", item)}
            codebuddyCliBusy={wbSwitch.slotBusy("cli")}
            codebuddyCliLoading={wbSwitch.slotLoading("cli", item.data.id)}
            codebuddyCliActive={item.data.id === wbPrograms.cli?.activeAccountId}
            codebuddyCnIdeAvailable={wbProgramAvail.cnIdeAvailable}
            codebuddyCnIdeBusy={wbSwitch.slotBusy("ide")}
            codebuddyCnIdeLoading={wbSwitch.slotLoading("ide", item.data.id)}
            codebuddyCnIdeActive={item.data.id === wbPrograms.cnIde?.activeAccountId}
            vscodePluginAvailable={wbProgramAvail.vscodeAvailable}
            vscodePluginBusy={wbSwitch.slotBusy("vscode")}
            vscodePluginLoading={wbSwitch.slotLoading("vscode", item.data.id)}
            vscodePluginActive={item.data.id === wbPrograms.vscode?.activeAccountId}
            jetbrainsPluginAvailable={wbProgramAvail.jetbrainsAvailable}
            jetbrainsPluginBusy={wbSwitch.slotBusy("jetbrains")}
            jetbrainsPluginLoading={wbSwitch.slotLoading("jetbrains", item.data.id)}
            jetbrainsPluginActive={item.data.id === wbPrograms.jetbrains?.activeAccountId}
            todayCheckedIn={checkinToday ?? undefined}
            travelStatus={signals?.travel.get(item.data.id)}
            creditPriority={item.data.id === priorityIdByScope.get(item.scope)}
            onCheckin={() => void checkinOne(item)}
            onRefreshPart={(_account, kind) => void refreshPart(item, kind)}
            refreshingKinds={refreshBusy.kindsOf(item.ref)}
            doneKinds={refreshBusy.doneKindsOf(item.ref)}
            {...common}
          />
        );
      }
      if (item.platform === "trae") {
        const variant = traeVariantOf(item.scope);
        const programs = traeProgramsOf(signals, item);
        return (
          <TraeAccountCard
            key={item.ref}
            account={{
              ...item.data,
              creditPackages:
                signals?.traeCredits.get(item.data.userId) ?? item.data.creditPackages ?? null,
            }}
            onDelete={() => setConfirmDelete({ kind: "one", account: item })}
            busy={traeSwitch.busy ?? traeBusy}
            switchBusy={traeSwitch.switchBusy}
            programs={programs.length ? programs : undefined}
            current={programs.some((program) => program.current)}
            onSwitchTo={(_account, target, label) => traeSwitch.request(item, target, label)}
            onRefreshCredits={() => void refreshTraeCredits(item)}
            checkedTodayOverride={checkinToday ?? undefined}
            onRefreshPart={(_account, kind) => void refreshPart(item, kind)}
            refreshingKinds={refreshBusy.kindsOf(item.ref)}
            doneKinds={refreshBusy.doneKindsOf(item.ref)}
            todayTokens={todayTokens}
            todayTokensTruncated={signals?.todayTokensTruncated}
            onCheckin={() => checkinTrae(item)}
            onSaveLogin={(account) =>
              void runTraeAction(item, `save-${account.userId}`, () =>
                api.traeSaveLogin(account.userId, variant).then(() => undefined),
              )
            }
            onRefreshJwt={(account) =>
              void runTraeAction(item, `jwt-${account.userId}`, () =>
                api.traeRefreshJwt(account.userId, variant).then(() => undefined),
              )
            }
            onClearCooldown={(account) =>
              void runTraeAction(item, `thaw-${account.userId}`, () =>
                api.traeClearCooldown(account.userId, variant).then(() => undefined),
              )
            }
            {...common}
          />
        );
      }
      const creditsRow = signals?.qoderCredits.get(item.data.uid);
      const qoderPrograms = signals?.qoderPrograms ?? [];
      return (
        <QoderAccountCard
          key={item.ref}
          account={item.data}
          onDelete={() => setConfirmDelete({ kind: "one", account: item })}
          credits={
            creditsRow && creditsRow.ok
              ? { remaining: creditsRow.remaining ?? 0, total: creditsRow.total ?? 0, plan: creditsRow.plan ?? null }
              : null
          }
          checkinToday={checkinToday}
          programs={qoderPrograms.length ? qoderPrograms : null}
          refreshKinds={QODER_REFRESH_KINDS}
          onSwitch={(program) => qoderSwitch.request(item, program)}
          switchBusy={qoderSwitch.switchBusy}
          onCheckin={() => void checkinQoder(item)}
          onEditRemark={() => openDetail(item.ref, "remark")}
          onSetGroup={() => openDetail(item.ref, "group")}
          onExport={() => setExportTarget(item)}
          {...common}
        />
      );
    },
    [
      creditOf,
      performDelete,
      onGuidePlugin,
      onGuideToSetting,
      openDetail,
      priorityIdByScope,
      qoderSwitch.request,
      qoderSwitch.switchBusy,
      refreshBusy,
      refreshPart,
      refreshTraeCredits,
      runTraeAction,
      traeBusy,
      reload,
      reloadSignals,
      saveGroup,
      selected,
      signalsByScope,
      t,
      toggleSelect,
      traeSwitch.busy,
      traeSwitch.request,
      traeSwitch.switchBusy,
      wbCnCreditLoading,
      wbCnStatus,
      wbGlobalCreditLoading,
      wbGlobalStatus,
    ],
  );

  /**
   * 客户端状态（`AppStatus`）—— 卡片的「当前登录」徽章与竖条都读它。
   *
   * ⚠️ 只在 store 里**还没有** status 时才拉：`Layout` 的 `useWorkbuddyStatusRefresh`
   * 会周期性刷新它，账号页进入时也已拉过一次。直接进聚合页（顶栏菜单第一项）时
   * store 是空的，不补这一次就会「徽章与竖条全不亮」，而顶栏还写着「未检测到」。
   */
  useEffect(() => {
    const store = useAccountsStore.getState();
    if (!store.status) void store.refreshRegionStatus("cn");
    if (!store.global.status) void store.refreshRegionStatus("global");
  }, []);

  /**
   * 挂载后主动拉一次 WorkBuddy 的积分。
   *
   * 为什么必须有：卡片上那一格积分来自 `creditMap`，而它只在**账号页**被
   * `ensureCredits` 填充过。用户直接从作用域菜单进聚合页时 store 是空的 ⇒
   * 22 张卡全写「等待积分数据…」，看起来像加载卡死。
   *
   * ⚠️ 一次**批量**拉（每个区域一次），不是逐卡请求 —— 后者是 N×N 次上游查询
   * （`AccountsPage.tsx` 有明文禁止）。Trae / Qoder 的积分在账号对象上，不必额外拉。
   */
  useEffect(() => {
    const cnIds: string[] = [];
    const globalIds: string[] = [];
    for (const account of accounts) {
      if (account.platform !== "workbuddy") continue;
      if (scopeParts(account.scope).region === "cn") cnIds.push(account.data.id);
      else globalIds.push(account.data.id);
    }
    const store = useAccountsStore.getState();
    if (cnIds.length) void store.ensureCredits(cnIds, "cn");
    if (globalIds.length) void store.ensureCredits(globalIds, "global");
  }, [accounts]);

  /* ── 组头 ── */
  function renderGroupHead(scope: Scope, count: number, attention: number, isFailed: boolean) {
    const { product } = scopeParts(scope);
    return (
      <div className="flex items-center gap-2 px-0.5 pb-2.5">
        <span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-muted px-[9px] text-[11px] font-medium text-muted-foreground">
          <ScopeMark product={product} size={14} className="rounded-[4px]" />
          {scopeLabel(t, scope)}
        </span>
        {/* ⚠️ 取数失败时**不写「N 个账号」**：那 N 个账号的数据根本没拿到，写数量等于拿旧值撒谎。 */}
        <span className="text-[11.5px] tabular-nums text-muted-foreground">
          {isFailed ? (
            <span className="text-destructive">{t("aggregate.group.failed")}</span>
          ) : (
            <>
              <b className="font-[550] text-foreground">{count}</b>{" "}
              {t("aggregate.group.count", { n: "" }).replace(/\s*\{?n\}?\s*/g, "").trim() || ""}
              {attention > 0 ? (
                <>
                  {" · "}
                  <span className="text-warning">{t("aggregate.group.attention", { n: attention })}</span>
                </>
              ) : null}
            </>
          )}
        </span>
        <div className="flex-1" />
        {!isFailed && count > 1 ? (
          <Button
            variant="ghost"
            size="sm"
            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/agg-group:opacity-100"
            onClick={() => {
              const refs = shown.filter((item) => item.scope === scope).map((item) => item.ref);
              setSelected((prev) => new Set([...prev, ...refs]));
            }}
          >
            {t("aggregate.group.selectAll")}
          </Button>
        ) : null}
      </div>
    );
  }

  /* ── 列表 ── */
  function renderList() {
    if (loading) {
      return (
        <div className="mt-4 flex flex-col items-center gap-3 py-16 text-muted-foreground">
          <RotateCw className="size-5 animate-spin" />
          <span className="text-[12.5px]">{t("aggregate.loading", { n: SCOPES.length })}</span>
        </div>
      );
    }

    if (shown.length === 0) {
      /* 三种「空」的第三、四种：被筛没 / 搜没。出口必须给，否则用户只能重启。 */
      if (accounts.length === 0) {
        return (
          <EmptyState
            icon={UserPlus}
            title={t("aggregate.empty.none.title")}
            description={t("aggregate.empty.none.desc")}
          />
        );
      }
      if (visible !== null && shown.length === 0) {
        return (
          <EmptyState
            icon={SearchX}
            title={t("aggregate.empty.filtered.title")}
            description={t("aggregate.empty.filtered.desc", { n: accounts.length })}
            action={
              <Button onClick={clearFilter}>{t("aggregate.empty.filtered.action")}</Button>
            }
          />
        );
      }
      return (
        <EmptyState
          icon={SearchX}
          title={t("aggregate.empty.search.title")}
          description={t("aggregate.empty.search.desc")}
          action={
            <Button variant="outline" onClick={() => setQuery("")}>
              {t("aggregate.empty.search.action")}
            </Button>
          }
        />
      );
    }

    /* 平铺：**按紧迫度混排**。若只是「打散分组、顺序仍按作用域」，这个模式就没有新信息。 */
    if (mode === "flat") {
      return (
        <div className="mt-3.5 grid grid-cols-1 gap-3 min-[761px]:grid-cols-2 min-[1101px]:grid-cols-3 min-[1600px]:grid-cols-4">
          {flat.map((item) => renderCard(item))}
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-5">
        {groups.map((group) => {
          const attention = group.items.filter((item) => aggregateNeedsAttention(item)).length;
          return (
            <section key={group.scope} className="group/agg-group min-w-0">
              {renderGroupHead(group.scope, group.items.length, attention, false)}
              <div className="grid grid-cols-1 gap-3 min-[761px]:grid-cols-2 min-[1101px]:grid-cols-3 min-[1600px]:grid-cols-4">
                {group.items.map((item) => renderCard(item))}
              </div>
            </section>
          );
        })}

        {/* 失败 / 未安装：**筛选生效时整组不出现**（用户是在已有账号里缩小范围）。 */}
        {!filtering
          ? SCOPES.filter((scope) => !groups.some((group) => group.scope === scope)).map((scope) => {
              const isFailed = failed.has(scope);
              const empty = !accounts.some((account) => account.scope === scope);
              if (isFailed) {
                return (
                  <section key={scope} className="min-w-0">
                    {renderGroupHead(scope, 0, 0, true)}
                    <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-destructive/45 bg-destructive/[0.06] px-3.5 py-3 text-[12.5px]">
                      <span className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-destructive/16 text-destructive">
                        <AlertTriangle className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <b className="block font-[550]">{t("aggregate.fail.title")}</b>
                        <span className="mt-px block text-[11.5px] text-muted-foreground">
                          {t("aggregate.fail.desc")}
                        </span>
                      </span>
                      <Button size="sm" variant="outline" onClick={() => void reload()}>
                        {t("aggregate.fail.retry")}
                      </Button>
                    </div>
                  </section>
                );
              }
              if (!empty) return null;
              const { product } = scopeParts(scope);
              const client = t(`product.${scopeParts(scope).product}.label` as never);
              return (
                <div
                  key={scope}
                  className="flex items-center gap-2 rounded-[10px] border border-dashed border-border-strong px-3.5 py-3 text-[12px] text-muted-foreground"
                >
                  <span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-muted px-[9px] text-[11px] font-medium">
                    <ScopeMark product={product} size={14} className="rounded-[4px]" />
                    {scopeLabel(t, scope)}
                  </span>
                  <span>
                    {SCOPES.includes(scope) && !empty
                      ? t("aggregate.note.noAccounts")
                      : t("aggregate.note.noClient", { client })}
                  </span>
                </div>
              );
            })
          : null}
      </div>
    );
  }

  const detailAccount = detailRef ? accounts.find((item) => item.ref === detailRef) : undefined;

  useEffect(() => {
    if (!detailAccount || detailAccount.platform !== "qoder") return;
    const uid = detailAccount.data.uid;
    const scope = detailAccount.scope;
    const key = `${scope}:${uid}`;
    const last = qoderPackFetchedAt.current[key] ?? 0;
    if (Date.now() - last < 60_000) return;
    let cancelled = false;
    api
      .qoderWebCreditPacks(scope, uid)
      .then((result) => {
        if (cancelled) return;
        qoderPackFetchedAt.current[key] = Date.now();
        setQoderPackMap((prev) => ({ ...prev, [key]: result }));
      })
      .catch(() => {
        /* 静默：拿不到逐包不是错误，抽屉不渲染该区块即可。 */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailRef]);

  /**
   * 抽屉的数据上下文。**只喂页面已经有的东西**（不为了打开抽屉再发一轮请求）：
   * WB 的积分来自 store，Trae 的积分在账号对象上，Qoder 的积分要单独拉
   * （`qoderCredits`）—— 那一条留空，抽屉就不会渲染「积分」那一格，而不是画一个 0。
   */
  const detailContext = useMemo<AggregateDetailContext | null>(() => {
    if (!detailAccount) return null;
    const region = scopeParts(detailAccount.scope).region;
    const signals = signalsByScope.get(detailAccount.scope);
    const todayEntry = todayTokensOf(signals, detailAccount);
    return {
      t,
      credit:
        detailAccount.platform === "workbuddy"
          ? creditOf(detailAccount.scope, detailAccount.data.id)
          : undefined,
      credits:
        detailAccount.platform === "trae"
          ? { remaining: detailAccount.data.remainingCredits, total: detailAccount.data.credits }
          : null,
      /* 今日 Token 的**真实新增**（非缓存输入 + 输出）；缺席 = 未知 ⇒ 那一格不渲染。 */
      todayTokens: todayEntry ? todayTokenNet(todayEntry) : null,
      todayTokensCache: todayEntry ? cacheReadOf(todayEntry) : null,
      todayCheckedIn: checkinTodayOf(signals, detailAccount),
      currentProgram:
        detailAccount.platform === "workbuddy"
          ? isWorkbuddyCurrent(
              detailAccount.data,
              (region === "cn" ? wbCnStatus : wbGlobalStatus)?.current,
            )
          : false,
      traePrograms:
        detailAccount.platform === "trae" ? traeProgramsOf(signals, detailAccount) : undefined,
      qoderPrograms: detailAccount.platform === "qoder" ? signals?.qoderPrograms : undefined,
      qoderPacks:
        detailAccount.platform === "qoder"
          ? qoderPackMap[`${detailAccount.scope}:${detailAccount.data.uid}`]
          : undefined,
    };
  }, [
    creditOf,
    detailAccount,
    qoderPackMap,
    signalsByScope,
    t,
    wbCnStatus,
    wbGlobalStatus,
  ]);

  const detailCurrent = useMemo(() => {
    if (!detailAccount) return false;
    if (detailAccount.platform === "workbuddy") return Boolean(detailContext?.currentProgram);
    if (detailAccount.platform === "trae") {
      return (detailContext?.traePrograms ?? []).some((program) => program.current);
    }
    return (detailContext?.qoderPrograms ?? []).some(
      (program) => program.currentUid === detailAccount.data.uid,
    );
  }, [detailAccount, detailContext]);

  const detailActions = useMemo<DetailActions | null>(() => {
    if (!detailAccount) return null;
    const checkedIn = checkinTodayOf(signalsByScope.get(detailAccount.scope), detailAccount);
    return {
      onRefresh: () => {
        void reload();
        void reloadSignals();
      },
      onCheckin: () => {
        if (detailAccount.platform === "workbuddy") void checkinOne(detailAccount);
        else if (detailAccount.platform === "trae") checkinTrae(detailAccount);
        else void checkinQoder(detailAccount);
      },
      showCheckin: checkedIn === false,
      onExport: () => setExportTarget(detailAccount),
      /* 诊断区是**单作用域**页面 ⇒ 必须带该账号自己的 scope 与子项锚点。 */
      onPermission: () => navigate(`/s/${detailAccount.scope}/settings?section=diagnostics`),
      onDelete: () => setConfirmDelete({ kind: "one", account: detailAccount }),
    };
  }, [
    checkinOne,
    checkinQoder,
    checkinTrae,
    detailAccount,
    navigate,
    reload,
    reloadSignals,
    signalsByScope,
  ]);

  const detailSwitchTargets = useMemo<DetailSwitchTarget[]>(() => {
    if (!detailAccount) return [];
    if (detailAccount.platform === "workbuddy") {
      const id = detailAccount.data.id;
      const region = scopeParts(detailAccount.scope).region;
      return [
        {
          key: "workbuddy",
          label: t("product.workbuddy"),
          current: isWorkbuddyCurrent(detailAccount.data, (region === "cn" ? wbCnStatus : wbGlobalStatus)?.current),
          available: true,
          onSwitch: () => setWbSwitchDialog({ account: detailAccount.data, region }),
        },
        {
          key: "ide",
          label: t("wbAccounts.program.codebuddyCnIde"),
          current: id === wbPrograms.cnIde?.activeAccountId,
          available: wbProgramAvail.cnIdeAvailable,
          busy: wbSwitch.slotBusy("ide"),
          loading: wbSwitch.slotLoading("ide", id),
          onSwitch: wbProgramAvail.cnIdeAvailable ? () => wbSwitch.request("ide", detailAccount) : undefined,
        },
        {
          key: "cli",
          label: t("wbAccounts.program.codebuddyCli"),
          current: id === wbPrograms.cli?.activeAccountId,
          available: wbProgramAvail.cliConfigured,
          busy: wbSwitch.slotBusy("cli"),
          loading: wbSwitch.slotLoading("cli", id),
          onSwitch: wbProgramAvail.cliConfigured ? () => wbSwitch.request("cli", detailAccount) : undefined,
        },
        {
          key: "vscode",
          label: t("wbAccounts.program.vscodeCodebuddyPlugin"),
          current: id === wbPrograms.vscode?.activeAccountId,
          available: wbProgramAvail.vscodeAvailable,
          busy: wbSwitch.slotBusy("vscode"),
          loading: wbSwitch.slotLoading("vscode", id),
          onSwitch: wbProgramAvail.vscodeAvailable ? () => wbSwitch.request("vscode", detailAccount) : undefined,
        },
        {
          key: "jetbrains",
          label: t("wbAccounts.program.jetbrainsCodebuddyPlugin"),
          current: id === wbPrograms.jetbrains?.activeAccountId,
          available: wbProgramAvail.jetbrainsAvailable,
          busy: wbSwitch.slotBusy("jetbrains"),
          loading: wbSwitch.slotLoading("jetbrains", id),
          onSwitch: wbProgramAvail.jetbrainsAvailable ? () => wbSwitch.request("jetbrains", detailAccount) : undefined,
        },
      ];
    }
    if (detailAccount.platform === "trae") {
      const item = detailAccount;
      return (signalsByScope.get(item.scope) ? traeProgramsOf(signalsByScope.get(item.scope), item) : []).map(
        (program) => ({
          key: `${program.region}:${program.program}`,
          label: program.label,
          current: program.current,
          available: program.installed && program.hasDataDir,
          busy: traeSwitch.switchBusy,
          loading: traeSwitch.busy === `switch-${item.data.userId}@${program.variant}`,
          onSwitch: () => traeSwitch.request(item, program.variant, program.label),
        }),
      );
    }
    const item = detailAccount;
    const uid = item.data.uid;
    return (signalsByScope.get(item.scope)?.qoderPrograms ?? []).map((program) => ({
      key: program.id,
      label: program.label,
      current: program.currentUid === uid,
      available: program.state === "ready" && !program.running,
      busy: qoderSwitch.switchBusy,
      onSwitch: () => qoderSwitch.request(item, program),
    }));
  }, [
    detailAccount,
    qoderSwitch,
    signalsByScope,
    t,
    traeSwitch,
    wbCnStatus,
    wbGlobalStatus,
    wbProgramAvail.cnIdeAvailable,
    wbProgramAvail.cliConfigured,
    wbProgramAvail.jetbrainsAvailable,
    wbProgramAvail.vscodeAvailable,
    wbPrograms.cli?.activeAccountId,
    wbPrograms.cnIde?.activeAccountId,
    wbPrograms.jetbrains?.activeAccountId,
    wbPrograms.vscode?.activeAccountId,
    wbSwitch,
  ]);

  const detailCheckin = useMemo(() => {
    if (!detailAccount) return null;
    const entry = signalsByScope
      .get(detailAccount.scope)
      ?.checkinDetail.get(signalKeyOf(detailAccount));
    if (!entry || !entry.ok || !entry.todayCheckedIn) return null;
    return { todayCheckedIn: entry.todayCheckedIn, ...checkinCreditsOf(entry) };
  }, [detailAccount, signalsByScope]);

  const detailWbId =
    detailAccount?.platform === "workbuddy" ? detailAccount.data.id : null;
  const detailWbRegion =
    detailAccount?.platform === "workbuddy"
      ? scopeParts(detailAccount.scope).region
      : null;
  /* 早期台账条目没有 `accountId`，靠邮箱兜底匹配（与渠道页同口径）。 */
  const detailWbEmail =
    detailAccount?.platform === "workbuddy" ? detailAccount.data.email ?? null : null;
  const [detailCheckinLogs, setDetailCheckinLogs] = useState<CheckinLog[] | null>(null);
  const [detailCreditEvents, setDetailCreditEvents] = useState<CreditStatsEvent[] | null>(null);

  useEffect(() => {
    if (!detailWbId || !detailWbRegion) {
      setDetailCheckinLogs(null);
      setDetailCreditEvents(null);
      return;
    }
    let cancelled = false;
    /* 失败不阻断抽屉：该列回落「—」，绝不臆造固定奖励（与渠道页同口径）。 */
    void api
      .getCheckinLogs()
      .then((res) => {
        if (!cancelled) setDetailCheckinLogs(res.logs);
      })
      .catch(() => {
        if (!cancelled) setDetailCheckinLogs(null);
      });
    void api
      .getCreditStatistics(false, detailWbRegion)
      .then((stats) => {
        if (!cancelled) setDetailCreditEvents(stats.events);
      })
      .catch(() => {
        if (!cancelled) setDetailCreditEvents(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detailWbId, detailWbRegion]);

  /**
   * 「近 7 天」逐日结果 —— 与 `AccountsPage.detailCheckinHistory` **同一口径**：
   * 同一天多条取最新一条；`accountId` 为空的旧记录用邮箱兜底匹配
   * （早期台账没有 `accountId`）。
   */
  const detailCheckinHistory = useMemo(() => {
    if (!detailWbId || !detailCheckinLogs) return null;
    return lastSevenDays().map((day) => {
      const log = detailCheckinLogs
        .filter(
          (entry) =>
            localDateKey(entry.ts) === day &&
            (entry.accountId === detailWbId ||
              (entry.accountId == null && detailWbEmail != null && entry.email === detailWbEmail)),
        )
        .sort((left, right) => right.ts - left.ts)[0];
      const event = (detailCreditEvents ?? []).find(
        (item) => item.kind === "checkin" && item.date === day && item.accountId === detailWbId,
      );
      const amount = event && event.kind === "checkin" ? event.amount ?? null : null;
      if (!log) {
        return {
          date: day,
          resultLabel: t("shared.drawer.checkin.result.none"),
          tone: "none" as const,
          amount,
        };
      }
      if (log.result === "success") {
        return {
          date: day,
          resultLabel: t("shared.drawer.checkin.result.success"),
          tone: "ok" as const,
          amount,
        };
      }
      if (log.result === "already") {
        return {
          date: day,
          resultLabel: t("shared.drawer.checkin.result.already"),
          tone: "warn" as const,
          amount,
        };
      }
      return {
        date: day,
        resultLabel: t("shared.drawer.checkin.result.fail"),
        tone: "fail" as const,
        amount,
      };
    });
  }, [detailCheckinLogs, detailCreditEvents, detailWbEmail, detailWbId, t]);

  const detailGroups = useMemo(() => {
    if (!detailAccount || detailAccount.platform === "trae") return undefined;
    const names = new Set<string>();
    for (const account of accounts) {
      if (account.scope !== detailAccount.scope) continue;
      const group =
        account.platform === "workbuddy"
          ? account.data.groupName
          : account.platform === "qoder"
            ? account.data.group
            : null;
      if (group && group.trim()) names.add(group);
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [accounts, detailAccount]);

  return (
    <div className="mx-auto w-full max-w-[1560px] px-6 pb-16">
      {/* ══ 吸顶工具栏 ══ */}
      <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-border bg-background/90 py-3 backdrop-blur-md">
        <div className="relative w-full max-w-[320px]">
          <Input
            data-testid="agg-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("aggregate.toolbar.searchPlaceholder")}
            aria-label={t("aggregate.toolbar.searchAria")}
            className="h-8 text-xs"
          />
        </div>

        <div className="relative">
          <Button
            data-testid="agg-filter-btn"
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={filterOpen}
            onClick={() => (filterOpen ? setFilterOpen(false) : openFilter())}
            className={cn(
              visible !== null &&
                "border-primary/55 bg-primary/12 text-primary hover:bg-primary/16 hover:text-primary",
            )}
          >
            <ListTree className="size-3.5" />
            {visible !== null
              ? t("aggregate.toolbar.filterCount", { n: visible.size })
              : t("aggregate.toolbar.filter")}
          </Button>
          {filterOpen ? (
            <AggregateFilterPanel
              accounts={accounts}
              draft={draft}
              onDraftChange={setDraft}
              expanded={expanded}
              onToggleExpanded={(scope) =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(scope)) next.delete(scope);
                  else next.add(scope);
                  return next;
                })
              }
              onApply={applyFilter}
              onCancel={() => setFilterOpen(false)}
              query={panelQuery}
              onQueryChange={setPanelQuery}
            />
          ) : null}
        </div>

        <div className="inline-flex gap-0.5 rounded-[10px] bg-muted p-0.5">
          <button
            type="button"
            data-testid="agg-mode-group"
            onClick={() => setMode("group")}
            title={t("aggregate.toolbar.groupHint")}
            className={cn(
              "h-[26px] rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
              mode === "group" && "bg-card font-[550] text-foreground shadow-card",
            )}
          >
            {t("aggregate.toolbar.group")}
          </button>
          <button
            type="button"
            data-testid="agg-mode-flat"
            onClick={() => setMode("flat")}
            title={t("aggregate.toolbar.flatHint")}
            className={cn(
              "h-[26px] rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
              mode === "flat" && "bg-card font-[550] text-foreground shadow-card",
            )}
          >
            {t("aggregate.toolbar.flat")}
          </button>
        </div>

        <div className="flex-1" />

        {filtering ? (
          <span className="inline-flex h-[30px] items-center gap-0.5 rounded-[9px] border border-primary/30 bg-primary/13 pl-2.5 pr-1 text-xs text-primary">
            {t("aggregate.count.filtered", { shown: shown.length, total: accounts.length })}
            <Button variant="ghost" size="sm" className="h-6 px-2 text-primary" onClick={clearFilter}>
              {t("aggregate.count.showAll")}
            </Button>
          </span>
        ) : (
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {mode === "flat"
              ? t("aggregate.count.sorted", { n: totals.total })
              : t("aggregate.count.total", { n: totals.total, scopes: SCOPES.length })}
          </span>
        )}

        <AggregateExportButton
          targets={exportTargets}
          onExported={(count) => toast.success(t("aggregate.export.done", { n: count }))}
        />

        <Button
          data-testid="agg-refresh"
          variant="ghost"
          size="icon"
          aria-label={t("aggregate.toolbar.refresh")}
          title={t("aggregate.toolbar.refresh")}
          onClick={() => void batchRefresh()}
        >
          <RotateCw className={cn("size-4", pending && "animate-spin")} />
        </Button>
      </div>

      {/* ══ Q3 方案 C：新增账号提示（筛选生效期间看不见的那些）══ */}
      {newcomers.length > 0 ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/8 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
            {t("aggregate.newcomer.title", { n: newcomers.length })}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              /* 「加入筛选」= 把这些账号并进可见集（**不清除**整个筛选）——
                 用户的意图是「我想看到这些」，不是「我不要之前的筛选」。 */
              const next = new Set(visible ?? universe);
              for (const account of newcomers) next.add(account.ref);
              const stored = visibleKeysToStore(next, universe);
              setRawVisible(stored);
              toast.success(t("aggregate.toast.newcomerAdded"));
            }}
          >
            {t("aggregate.newcomer.add")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissedNewcomers(new Set(newcomers.map((a) => a.ref)))}>
            {t("aggregate.newcomer.ignore")}
          </Button>
        </div>
      ) : null}

      {/* ══ 批量条（文档流内，与账号页一致）══ */}
      {selected.size > 0 ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-primary/35 bg-primary/10 px-3.5 py-2.5">
          <Badge variant="secondary" className="h-5 border-0 px-1.5 text-[10.5px]">
            {t("aggregate.batch.selected", { n: selected.size })}
          </Badge>
          <span
            className="text-[10.5px] text-muted-foreground"
            title={t("aggregate.batch.acrossScopesHint")}
          >
            {t("aggregate.batch.acrossScopes", {
              n: new Set(selectedRefs.map((ref) => ref.slice(0, ref.indexOf(":")))).size,
            })}
          </span>
          <div className="flex-1" />
          {/* 批量动作：**只摆真能做的**（Qoder 没有批量签到命令，由 `batchCheckin` 内部循环）。
              导出需要选目录的对话框，聚合页暂不提供 —— 少一个按钮比摆一个点不动的强。 */}
          <Button size="sm" variant="outline" onClick={() => void batchCheckin()}>
            {t("shared.batch.checkin")}
          </Button>
          {/* ★ issue #89 · 2.3：批量删除同样先确认（此前点一下就删）。 */}
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete({ kind: "batch", count: selected.size })}
          >
            {t("shared.batch.delete")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {t("shared.batch.clear")}
          </Button>
        </div>
      ) : null}

      {renderList()}

      {/* ══ WB 程序位切换的统一重启确认框（与账号页同一个组件）══ */}
      <RestartConfirmDialog {...wbSwitch.confirmProps} />

      {/* ══ Trae 程序位切换的重启确认（issue #89 · 2.1）══
          与 WB 用同一个组件：Trae 的切换同样是「先关客户端、写登录态、再重开」，
          确认框里的「自动重开」勾选映射到 `api.traeSwitchAccount` 的 `launch`。 */}
      <RestartConfirmDialog {...traeSwitch.confirmProps} />

      {/* ══ Qoder 程序位切换确认（issue #89 · 2.2）══
          Qoder 没有「重启客户端」这一档 ⇒ 普通确认框，不摆无效的「自动重开」勾选。 */}
      <Dialog
        open={qoderSwitch.confirmProps.open}
        onOpenChange={qoderSwitch.confirmProps.onOpenChange}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("qoder.page.accounts.switch.title")}</DialogTitle>
            <DialogDescription>
              {t("qoder.page.accounts.switch.desc", {
                name: qoderSwitch.confirmProps.name,
                program: qoderSwitch.confirmProps.programLabel,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => qoderSwitch.confirmProps.onOpenChange(false)}
              disabled={qoderSwitch.switchBusy}
            >
              {t("qoder.page.accounts.switch.cancel")}
            </Button>
            <Button onClick={qoderSwitch.confirmProps.onConfirm} disabled={qoderSwitch.switchBusy}>
              {t("qoder.page.accounts.switch.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══ 删除确认（issue #89 · 2.3，单个与批量共用）══
          撤销 toast 是**事后**补救，不能替代「删之前问一句」——三个渠道页都是先确认。 */}
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("aggregate.delete.title")}</DialogTitle>
            <DialogDescription>
              {confirmDelete?.kind === "batch"
                ? t("aggregate.delete.batchBody", { n: confirmDelete.count })
                : t("aggregate.delete.body", {
                    name: confirmDelete ? aggregateDisplayName(confirmDelete.account) : "",
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              {t("aggregate.delete.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (!target) return;
                if (target.kind === "batch") void batchDelete();
                else void performDelete(target.account);
              }}
            >
              {t("aggregate.delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══ OAuth 扫码添加（issue #89 · B7）══ 区域取该账号自己的作用域。 */}
      <OAuthLoginDialog
        open={oauthRegion !== null}
        onOpenChange={(open) => {
          if (!open) setOauthRegion(null);
        }}
        region={oauthRegion ?? "cn"}
      />

      {/* ══ 单账号导出（issue #89 · B9）══ 与工具栏共用同一个受控弹窗。 */}
      <AggregateExportDialog
        target={exportTarget ? { scope: exportTarget.scope, accounts: [exportTarget] } : null}
        onOpenChange={(open) => {
          if (!open) setExportTarget(null);
        }}
        onExported={() => {
          void reload();
        }}
      />

      {/* ══ WorkBuddy 主程序位切换向导（issue #89 · B1）══
          与账号页**同一个组件**：它带会话迁移三步（目标与来源 → 迁移内容 → 确认），
          在聚合页重写一遍既不可能也不该。 */}
      <SwitchAccountDialog
        open={wbSwitchDialog !== null}
        onOpenChange={(open) => {
          if (!open) setWbSwitchDialog(null);
        }}
        account={wbSwitchDialog?.account ?? null}
        region={wbSwitchDialog?.region}
        onDone={() => {
          void reload();
        }}
      />

      {/* ══ 详情抽屉（`accountKey` 恰好就是 `${scope}:${key}`，与 ref 同源）══ */}
      <AccountDetailDrawer
        open={detailRef !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailRef(null);
            setDetailAutoEditRemark(false);
            setDetailAutoEditGroup(false);
          }
        }}
        autoEditRemark={detailAutoEditRemark}
        autoEditGroup={detailAutoEditGroup}
        /* `accountKey` 恰好就是 `${scope}:${key}` —— 与 ref 同源，抽屉用它记「上次停在哪个页签」。 */
        accountKey={detailRef ?? ""}
        name={detailAccount ? aggregateDisplayName(detailAccount) : ""}
        subtitle={detailAccount ? aggregateSubtitle(detailAccount) : ""}
        avatarSeed={detailAccount ? aggregateDisplayName(detailAccount) : ""}
        remark={
          detailAccount && detailAccount.platform !== "qoder"
            ? (detailAccount.data.remark ?? "")
            : (detailAccount?.data.remark ?? "")
        }
        /* 分组：Trae 是 `groupId`（不是自由文本）⇒ 不注入 `onSaveGroup`，抽屉就不渲染那一块。 */
        group={
          detailAccount?.platform === "workbuddy"
            ? (detailAccount.data.groupName ?? "")
            : detailAccount?.platform === "qoder"
              ? (detailAccount.data.group ?? "")
              : undefined
        }
        onSaveRemark={
          detailAccount ? (remark: string) => saveRemark(detailAccount, remark) : undefined
        }
        onSaveGroup={
          detailAccount && detailAccount.platform !== "trae"
            ? (group: string) => saveGroup(detailAccount, group)
            : undefined
        }
        stats={detailAccount && detailContext ? aggregateDetailStats(detailAccount, detailContext) : []}
        sections={detailAccount && detailContext ? aggregateDetailSections(detailAccount, detailContext) : []}
        packs={detailAccount && detailContext ? aggregateDetailPacks(detailAccount, detailContext) : []}
        programs={detailAccount && detailContext ? aggregateDetailPrograms(detailAccount, detailContext) : []}
        current={detailCurrent}
        actions={detailActions}
        checkin={detailCheckin}
        checkinHistory={detailCheckinHistory}
        switchTargets={detailSwitchTargets}
        onWizardSwitch={
          detailAccount?.platform === "workbuddy"
            ? () =>
                setWbSwitchDialog({
                  account: (detailAccount as { platform: "workbuddy"; data: AccountMeta }).data,
                  region: scopeParts(detailAccount.scope).region,
                })
            : undefined
        }
        groups={detailGroups}
        loading={loading}
        refreshingKinds={detailAccount ? refreshBusy.kindsOf(detailAccount.ref) : []}
        onRefreshPart={
          detailAccount ? (kind) => void refreshPart(detailAccount, kind) : undefined
        }
        snapshots={[]}
        featuresDisabled={false}
      />
    </div>
  );
}
