/**
 * 四个作用域的**环境状态汇总** —— 顶栏作用域选择器的唯一取数来源。
 *
 * ## 为什么要有这一层（而不是各组件自己拼）
 *
 * 顶栏的触发按钮与作用域菜单都要展示**全部 4 个作用域**的同一组事实
 * （`已登录 xxx / 未登录 / 未检测到 · N 个账号`，外加运行点）。两处各拼一遍
 * 迟早漂移成「触发按钮说 8 个账号、菜单里说 7 个」—— 那正是本项目反复要消灭的那类不一致。
 *
 * ## 四条事实分别从哪来
 *
 * - **WorkBuddy 侧**（`wb-cn` / `wb-global`）：直接读 `useAccountsStore` 的
 *   当前切片（`status` / `status.global`）。它由既有的 `useWorkbuddyStatusRefresh`
 *   与账号页维护，本 hook **不额外取数**。
 * - **Trae 侧**（`trae-cn` / `trae-global`）：一次聚合快照 ——
 *   安装 / 运行态取自 `trae-variant-status` 的同一次探测（`loadTraeVariantStatuses`，
 *   即侧栏运行点的数据源），「当前登录」与「账号数」在其上各取一次。
 *   快照走 `useCachedResource` + **本 hook 自己的 60 秒轮询**（见 [`TRAE_SCOPE_STATUS_POLL_MS`]）。
 * - **Qoder 侧**（`qoder-cn` / `qoder-global`）：同样是一次聚合快照 ——
 *   `get_qoder_accounts`（账号数 / 当前登录 / 需处理）+ `qoder_program_status`
 *   （两处程序位的安装与运行态），**与 Trae 侧同一节奏**。
 *   ⚠️ 2026-10-17 之前 Qoder 两条恒为 `UNKNOWN_STATUS`（当时确实没有数据源）——
 *   后果是顶栏写着「未检测到 · 0 个账号」，而账号页里明明躺着两条账号。
 *   「不知道」与「0」必须分开，所以要么取到真数，要么保持未知，不能编。
 *
 * ## 为什么 Trae 侧要在 WorkBuddy 作用域下也探测
 *
 * 作用域菜单要并排展示 4 个作用域 ⇒ Trae 的状态必须可得，否则菜单里两条 Trae
 * 永远是「未检测到」。这与旧的「不在 Trae 分区就不探测」的取舍不同：那时只有
 * 侧栏一颗圆点，现在是一张跨作用域的状态表 —— 信息的范围变了，取数范围随之改变。
 */

import { useCallback, useEffect, useMemo } from "react";

import * as api from "@/lib/api";
import type { AccountMeta, AppStatus } from "@/lib/types";
import type { TraeRegionId, TraeVariantStatus } from "@/lib/trae-types";
import type { Scope } from "@/lib/scope";
import {
  findRegionStatus,
  loadTraeVariantLogins,
  loadTraeVariantStatuses,
  type TraeVariantLogins,
} from "@/lib/trae-variant-status";
import { useCachedResource } from "@/lib/use-cached-resource";
import { useDocumentVisible } from "@/lib/use-document-visible";
import { useAccountsStore } from "@/stores/accounts";
import { useResourceStore } from "@/stores/resources";
import { identityDisplayName } from "@/components/account-card";

/** 单个作用域的环境状态。 */
export interface ScopeStatus {
  /** 该作用域的客户端是否已安装。 */
  installed: boolean;
  /** 该作用域的客户端是否在运行。 */
  running: boolean;
  /** 当前登录账号展示名；未登录 / 读不到时为 `null`。 */
  loggedInName: string | null;
  /** 账号库里的账号数。 */
  accountCount: number;
  /**
   * 「需处理」账号数（凭据已过期 / 需重新登录）—— 原型 `scope-menu` 的
   * `· N 个需处理`（`buddy-switch-prototype.html:3889`）。
   *
   * ⚠️ **`null` = 未知，不是「0」**：Trae 侧的聚合快照只取账号**总数**
   * （逐账号的过期 / 重登事实要再拉一次账号列表）。不知道就说不知道 ——
   * 菜单里**不渲染**该段，而不是用「0 个需处理」暗示「那边没事」。
   */
  attentionCount: number | null;
}

/** 四个作用域的状态表。 */
export type ScopeStatusMap = Record<Scope, ScopeStatus>;

/** 尚未取到数据时的占位（诚实：不确定就不说已安装 / 已登录）。 */
const UNKNOWN_STATUS: ScopeStatus = {
  installed: false,
  running: false,
  loggedInName: null,
  accountCount: 0,
  attentionCount: null,
};

/**
 * Trae 聚合快照的缓存键。
 *
 * ⚠️ **与 `TRAE_VARIANTS_KEY` 分开**：后者只装 `get_trae_variants` 的探测结果
 * （侧栏运行点直接复用），本快照在其上**再加**两次登录态 / 账号数请求。
 * 合成一个键会让「只想读运行点」的调用方被迫承担那两次请求。
 */
const TRAE_SCOPE_STATUS_KEY = "trae:scope-status";

/**
 * 快照的新鲜窗口：**50 秒**。
 *
 * 它是 [`TRAE_SCOPE_STATUS_POLL_MS`] 的**减数**，两个值必须满足「窗口 < 间隔」。
 */
const TRAE_SCOPE_STATUS_FRESH_MS = 50 * 1000;

const TRAE_SCOPE_STATUS_POLL_MS = TRAE_SCOPE_STATUS_FRESH_MS + 10 * 1000;

interface TraeScopeSnapshot {
  cn: ScopeStatus;
  global: ScopeStatus;
}

/**
 * 取一个区域下「当前登录」的展示名：区域有两条程序位（TraeWork / TraeCode），
 * 取**第一条有登录态**的 —— 与原型 `currentAccount()` 的口径一致。
 */
function regionLoginName(
  statuses: TraeVariantStatus[],
  logins: TraeVariantLogins,
  region: TraeRegionId,
): string | null {
  for (const program of findRegionStatus(statuses, region)?.programs ?? []) {
    const login = logins[program.variant];
    if (login) return login.name;
  }
  return null;
}

async function loadTraeScopeSnapshot(): Promise<TraeScopeSnapshot> {  const statuses = await loadTraeVariantStatuses();
  const [logins, cnAccounts, globalAccounts] = await Promise.all([
    loadTraeVariantLogins(statuses),
    api.getTraeAccounts("trae_merged").catch(() => null),
    api.getTraeAccounts("global_trae_merged").catch(() => null),
  ]);

  const build = (region: TraeRegionId, accountCount: number): ScopeStatus => {
    const entry = findRegionStatus(statuses, region);
    return {
      installed: entry?.installed ?? false,
      running: entry?.running ?? false,
      loggedInName: regionLoginName(statuses, logins, region),
      accountCount,
      // 本次只取了总数 ⇒ 「需处理」**未知**（不拿 0 冒充，见 `ScopeStatus.attentionCount`）。
      attentionCount: null,
    };
  };

  return {
    cn: build("cn", cnAccounts?.total ?? 0),
    global: build("global", globalAccounts?.total ?? 0),
  };
}

/** Qoder 聚合快照的缓存键（与 Trae 侧分开：两者取数路径完全不同）。 */
const QODER_SCOPE_STATUS_KEY = "qoder:scope-status";

/**
 * Qoder 快照的新鲜窗口：**50 秒**，与 Trae 侧同值。
 *
 * 轮询**共用** [`TRAE_SCOPE_STATUS_POLL_MS`]（同一个 60 秒定时器里两条都 revalidate）——
 * 两条快照同一档期，分开起定时器只会让同一秒打两轮请求。
 */
const QODER_SCOPE_STATUS_FRESH_MS = TRAE_SCOPE_STATUS_FRESH_MS;

interface QoderScopeSnapshot {
  cn: ScopeStatus;
  global: ScopeStatus;
}

/**
 * Qoder 两个区域的状态快照。
 *
 * 两个事实源在**同一次**快照里取齐：
 * - `get_qoder_accounts(scope)` → 账号数 / 当前登录 uid / 是否有可用凭据；
 * - `qoder_program_status(scope)` → 桌面版与 CLI 两处程序位的 `state` 与 `running`。
 *
 * ⚠️ **安装判据用 `state`，不用「有账号」**：Qoder 允许先粘 PAT 再装客户端
 * （`state = missing` 而账号库非空）—— 那时说「已安装」是假的。
 * `empty` / `ready` 都表示「客户端在、只是登录态空/有」，都算装过。
 */
async function loadQoderScopeSnapshot(): Promise<QoderScopeSnapshot> {
  const build = async (scope: Scope): Promise<ScopeStatus> => {
    const [view, programs] = await Promise.all([
      api.getQoderAccounts(scope).catch(() => null),
      api.qoderProgramStatus(scope).catch(() => null),
    ]);
    const accounts = view?.accounts ?? [];
    const list = programs?.programs ?? [];
    const currentUid = list.find((program) => program.currentUid)?.currentUid ?? null;
    const logged = currentUid ? accounts.find((account) => account.uid === currentUid) : undefined;
    const now = Date.now();
    return {
      installed: list.some(
        (program) => program.running || program.state === "ready" || program.state === "empty",
      ),
      running: list.some((program) => program.running),
      loggedInName: logged ? (logged.nickname ?? logged.name) : null,
      accountCount: accounts.length,
      // 与 WorkBuddy 侧同一口径（过期 or 无可用凭据 ⇒ 需处理）；Qoder 没有「需重登」概念。
      attentionCount: accounts.filter(
        (account) =>
          !account.hasCredential ||
          (account.expiresAt != null && account.expiresAt <= now),
      ).length,
    };
  };
  const [cn, global] = await Promise.all([build("qoder-cn"), build("qoder-global")]);
  return { cn, global };
}

/** WorkBuddy 一个区域的切片 → 状态（登录名优先昵称、其次邮箱）。 */
function workbuddyStatus(status: AppStatus | null, accounts: AccountMeta[]): ScopeStatus {
  const now = Date.now();
  return {
    // 后端缺省 `installed` 时按「账号库非空即视为装过」兜底（与账号页口径一致）。
    installed: status?.installed ?? accounts.length > 0,
    running: Boolean(status?.running),
    loggedInName: identityDisplayName(status?.current) || null,
    accountCount: accounts.length,
    // 与侧栏账号徽章的警示判据**同一口径**（原型的 `expiredCount()`）：过期 or 需重登。
    attentionCount: accounts.filter(
      (a) => a.needsRelogin || (a.expiresAt != null && a.expiresAt <= now),
    ).length,
  };
}

export function useScopeStatus(): {
  statuses: ScopeStatusMap;
  /**
   * 强制刷新**非 WorkBuddy** 作用域的聚合快照（Trae / Qoder）；**返回错误文案**（`null` = 成功）。
   *
   * WorkBuddy 的刷新不在这里：它走账号 store 自己的命令（见 `Layout.refreshCurrentScope`）。
   * ⚠️ 两个产品线的快照**来自不同键**，所以刷新也必须按产品分派 —— 用同一个函数刷另一条，
   * 只会让顶栏那个「已刷新」toast 说谎。
   *
   * ⚠️ 为什么返回值不是 `void`：`useCachedResource.refresh` 吞掉异常（失败写进
   * 快照的 `error`，见 `stores/resources.ts` 的 `load`）⇒ 顶栏刷新若只看
   * 「await 有没有抛」，Trae / Qoder 的失败会被当成成功去报「已刷新」。这里在刷新结束
   * 后直接读 store 的**最新** entry（不受 React 渲染时序影响），把结果转成
   * 显式值给调用方。
   */
  refreshProduct: (product: "trae" | "qoder") => Promise<string | null>;
} {
  const cnStatus = useAccountsStore((s) => s.status);
  const cnAccounts = useAccountsStore((s) => s.accounts);
  const globalStatus = useAccountsStore((s) => s.global.status);
  const globalAccounts = useAccountsStore((s) => s.global.accounts);

  const trae = useCachedResource<TraeScopeSnapshot>(
    TRAE_SCOPE_STATUS_KEY,
    loadTraeScopeSnapshot,
    { freshMs: TRAE_SCOPE_STATUS_FRESH_MS },
  );

  const qoder = useCachedResource<QoderScopeSnapshot>(
    QODER_SCOPE_STATUS_KEY,
    loadQoderScopeSnapshot,
    { freshMs: QODER_SCOPE_STATUS_FRESH_MS },
  );

  const visible = useDocumentVisible();
  // 取出函数本体再进依赖：`trae` 对象每次渲染都是新的，直接用它会每帧重建定时器。
  const revalidateTrae = trae.revalidate;
  const revalidateQoder = qoder.revalidate;

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => {
      void revalidateTrae();
      // 两条快照同一个周期触发：分开起定时器只会在同一秒打两轮请求。
      void revalidateQoder();
    }, TRAE_SCOPE_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [visible, revalidateTrae, revalidateQoder]);

  const statuses = useMemo<ScopeStatusMap>(
    () => ({
      "wb-cn": workbuddyStatus(cnStatus, cnAccounts),
      "wb-global": workbuddyStatus(globalStatus, globalAccounts),
      "trae-cn": trae.data?.cn ?? UNKNOWN_STATUS,
      "trae-global": trae.data?.global ?? UNKNOWN_STATUS,
      "qoder-cn": qoder.data?.cn ?? UNKNOWN_STATUS,
      "qoder-global": qoder.data?.global ?? UNKNOWN_STATUS,
    }),
    [cnStatus, cnAccounts, globalStatus, globalAccounts, trae.data, qoder.data],
  );

  // 见返回类型处的说明：refresh 不抛错 ⇒ 刷新完成后从 store 读最新 entry 判成败。
  const refreshProduct = useCallback(
    async (product: "trae" | "qoder"): Promise<string | null> => {
      const key = product === "trae" ? TRAE_SCOPE_STATUS_KEY : QODER_SCOPE_STATUS_KEY;
      await (product === "trae" ? trae.refresh() : qoder.refresh());
      const entry = useResourceStore.getState().entries[key];
      return entry?.error == null ? null : api.asError(entry.error);
    },
    [trae.refresh, qoder.refresh],
  );

  return { statuses, refreshProduct };
}