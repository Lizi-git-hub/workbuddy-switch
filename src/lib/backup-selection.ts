
import { SCOPES, type Scope } from "./scope";
import type { BackupSelectionState } from "./api";

/** 一个作用域下的三个可备份分区（与后端 `ScopeSelection` 同源）。 */
export const BACKUP_PARTS = ["accounts", "config"] as const;
export type BackupPart = (typeof BACKUP_PARTS)[number];

/** 单个作用域的分区勾选。 */
export interface ScopeParts {
  accounts: boolean;
  config: boolean;
  gateway: boolean;
}

/** 全量勾选：4 作用域 × 3 分区。 */
export type BackupSelection = Record<Scope, ScopeParts>;

/** 逐作用域的**实际**条目数（用于勾选旁的数字与预估）。缺省即 0。 */
export interface ScopeStat {
  accounts: number;
  config: number;
  gateway: number;
}
export type ScopeStats = Record<Scope, ScopeStat>;

export interface BackupEstimate {
  /** 至少勾了一个分区的作用域数。 */
  scopes: number;
  /** 勾选的分区总数。 */
  parts: number;
  /** 预计账号数（只累计勾了「账号」分区的作用域）。 */
  accounts: number;
  /** 预计字节数（量级感，不写盘）。 */
  bytes: number;
  includesCredentials: boolean;
}

/**
 * 单条记录的粗略体量（字节）。
 *
 * ⚠️ **不是契约**：只用来给「预计 ~N KB」一个量级。真值由后端导出时决定。
 */
const ESTIMATE_BYTES = {
  base: 320,
  account: 620,
  credential: 900,
  config: 480,
  gatewayKey: 180,
} as const;

/** 每个作用域的**配置分区条目数**（签到 / 旅行 / 自动轮换 / 切换行为 —— 与 envelope 同源）。 */
export const CONFIG_SECTIONS_PER_SCOPE = 4;

/** 默认全选：4 作用域 × 3 分区（D14）。 */
export function defaultBackupSelection(): BackupSelection {
  const out = {} as BackupSelection;
  for (const scope of SCOPES) out[scope] = { accounts: true, config: true, gateway: true };
  return out;
}

/** 切换某作用域的**某一个分区**。 */
export function toggleScopePart(
  selection: BackupSelection,
  scope: Scope,
  part: BackupPart,
): BackupSelection {
  const current = selection[scope];
  return { ...selection, [scope]: { ...current, [part]: !current[part] } };
}

/** 某作用域是否三个分区全勾。 */
export function isScopeAll(selection: BackupSelection, scope: Scope): boolean {
  const parts = selection[scope];
  return parts.accounts && parts.config && parts.gateway;
}

/** 某作用域是否三个分区全不勾。 */
export function isScopeNone(selection: BackupSelection, scope: Scope): boolean {
  const parts = selection[scope];
  return !parts.accounts && !parts.config && !parts.gateway;
}

export function scopeCheckState(selection: BackupSelection, scope: Scope): "all" | "none" | "mixed" {
  if (isScopeAll(selection, scope)) return "all";
  if (isScopeNone(selection, scope)) return "none";
  return "mixed";
}

/** 点作用域头：**全不勾 ⇒ 全勾；否则 ⇒ 全不勾**（含半选，一步收敛到「全勾」）。 */
export function toggleScopeAll(selection: BackupSelection, scope: Scope): BackupSelection {
  const next = !isScopeAll(selection, scope);
  return { ...selection, [scope]: { accounts: next, config: next, gateway: next } };
}

/** 至少勾了一个分区的作用域数。 */
export function selectedScopeCount(selection: BackupSelection): number {
  return SCOPES.filter((scope) => !isScopeNone(selection, scope)).length;
}

/** 勾选的分区总数。 */
export function selectedPartCount(selection: BackupSelection): number {
  let total = 0;
  for (const scope of SCOPES) {
    for (const part of BACKUP_PARTS) if (selection[scope][part]) total += 1;
  }
  return total;
}

/** 是否有任何可导出内容。**全不勾 ⇒ false**（导出按钮据此 `disabled`，R10）。 */
export function hasAnySelection(selection: BackupSelection): boolean {
  return selectedPartCount(selection) > 0;
}

/**
 * 组装后端入参（`BackupSelectionState`）。
 *
 * `appSettings` 只在**有内容**时带上（缺省即「不含」）—— 传一个空对象会让后端把
 * `appSettings` 写成 `{}`，看起来像「已备份了应用设置，只是全空」，那是误导。
 */
export function buildSelectionState(
  selection: BackupSelection,
  includesCredentials: boolean,
  appSettings?: Record<string, unknown>,
): BackupSelectionState {
  const scopes: BackupSelectionState["scopes"] = {};
  for (const scope of SCOPES) scopes[scope] = { ...selection[scope] };
  if (appSettings && Object.keys(appSettings).length > 0) {
    return { scopes, includesCredentials, appSettings };
  }
  return { scopes, includesCredentials };
}

/** 由实际勾选 + 实际条目数推导导出预估。 */
export function estimateBackup(
  selection: BackupSelection,
  includesCredentials: boolean,
  scopeStats: ScopeStats,
): BackupEstimate {
  let bytes: number = ESTIMATE_BYTES.base;
  let accounts = 0;
  let scopes = 0;
  let parts = 0;

  for (const scope of SCOPES) {
    const picked = selection[scope];
    const stat = scopeStats[scope];
    if (picked.accounts || picked.config || picked.gateway) scopes += 1;
    if (picked.accounts) {
      parts += 1;
      accounts += stat.accounts;
      bytes += stat.accounts * ESTIMATE_BYTES.account;
    }
    if (picked.config) {
      parts += 1;
      bytes += stat.config * ESTIMATE_BYTES.config;
    }
    if (picked.gateway) {
      parts += 1;
      bytes += stat.gateway * ESTIMATE_BYTES.gatewayKey;
    }
  }
  if (includesCredentials) bytes += accounts * ESTIMATE_BYTES.credential;

  return { scopes, parts, accounts, bytes, includesCredentials };
}
