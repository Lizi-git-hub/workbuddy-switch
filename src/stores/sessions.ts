
import { create } from "zustand";

import * as api from "@/lib/api";
import {
  buildAccountLabels,
  buildGroupViews,
  buildSessionsByAccount,
} from "@/lib/session-replicas";
import type { SessionGroupView } from "@/lib/session-replicas";
import type { Region, Session, SyncSessionReplicaItem, SyncSessionReplicaResponse, UnifySessionReplicaItem, UnifySessionReplicaResponse } from "@/lib/types";
import { selectRegionSlice, useAccountsStore } from "@/stores/accounts";

interface SessionsState {
  /** 已 join 的可渲染副本组（空数组 = 无副本 / 尚未加载完成）。 */
  groups: SessionGroupView[];
  /**
   * 后端账本来源：`ledger` 有可用登记 / `empty` 无登记；**未加载时为 `null`**
   * （页面据此区分「加载中」与「真的空」，避免闪一下空态）。
   */
  source: "ledger" | "empty" | null;
  /**
   * 本机没有内容的账本组数量（成员 jsonl 全都不在本机）。
   *
   * 换机后旧账本跟着数据目录搬过来就会出现 —— 不渲染这些组，只在页面上给一条
   * 「有 N 条历史残留，可清除」的提示 + 清理入口。
   */
  staleGroups: number;
  loading: boolean;
  error: string | null;
  /** 加载某 region 的副本组（账号显示名 / 会话行 join 一并完成）。 */
  load: (region: Region) => Promise<void>;
  syncItems: (
    region: Region,
    items: SyncSessionReplicaItem[],
  ) => Promise<SyncSessionReplicaResponse>;
  unifyItems: (
    region: Region,
    items: UnifySessionReplicaItem[],
  ) => Promise<UnifySessionReplicaResponse>;
  /** 清除复制账本 / 基线 / 指纹缓存（只删本工具自己的登记），随后重新加载。 */
  clearCache: (region: Region) => Promise<string[]>;
}

/** 该 region 已加载的账号（从账号 store 读，**不另起一份清单**）。 */
function accountsFor(region: Region) {
  return selectRegionSlice(useAccountsStore.getState(), region).accounts;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  groups: [],
  source: null,
  staleGroups: 0,
  loading: false,
  error: null,

  async load(region) {
    set({ loading: true, error: null });
    try {
      const response = await api.listSessionReplicas(region);
      if (response.groups.length === 0) {
        set({
          groups: [],
          source: response.source,
          staleGroups: response.staleGroups ?? 0,
          loading: false,
        });
        return;
      }

      // 账号显示名：从账号 store join。若该 region 尚未加载过账号，先拉一次
      //（`fetchAllRegions` 是账号 store 的公开入口，**唯一事实来源**不变）。
      let accounts = accountsFor(region);
      if (accounts.length === 0) {
        await useAccountsStore.getState().fetchAllRegions();
        accounts = accountsFor(region);
      }
      const accountLabels = buildAccountLabels(accounts);

      // 会话行：只列**当前账号**的会话（`list_sessions` 的既有语义）。取不到不致命 ——
      // 副本组仍可见，标题落兜底（诚实标注由 `partial` 承担）。
      let sessionsByAccount = new Map<string, Map<string, Session>>();
      try {
        const sessionResponse = await api.listSessions(region);
        sessionsByAccount = buildSessionsByAccount(
          sessionResponse.current,
          sessionResponse.sessions ?? [],
        );
      } catch {
        // 会话行不可用：保留空 map ⇒ 标题走 `titleFallback`。
      }

      const groups = buildGroupViews(
        response.groups,
        sessionsByAccount,
        accountLabels,
      );
      set({
        groups,
        source: response.source,
        staleGroups: response.staleGroups ?? 0,
        loading: false,
      });
    } catch (e) {
      set({ groups: [], error: api.asError(e), loading: false });
    }
  },

  syncItems(region, items) {
    return api.syncSessionReplicas(items, region);
  },

  unifyItems(region, items) {
    return api.unifySessionReplicas(items, region);
  },

  async clearCache(region) {
    const result = await api.clearSessionCache(region);
    /* 清完立刻重载：不重载的话页面还挂着旧的 groups，看起来像没生效。 */
    await get().load(region);
    return result.removed;
  },
}));
