/**
 * 账号页「客户端限流」× 网关页「限流探测」的**唯一对齐口径**（纯函数，无副作用）。
 *
 * ## 为什么需要这一层
 *
 * 两个界面回答的是**同一个问题**的两种证据：
 *
 * | 界面 | 证据 | 数据源 | 局限 |
 * |---|---|---|---|
 * | 账号页 · 客户端限流 | **日志反推**：客户端 jsonl 里报过 429、何时恢复 | core `client_limits` | 没跑过的模型 = **不在台账 ≠ 没被限流** |
 * | 网关页 · 限流探测 | **真发一次最小请求**的实判 | `model_probe` 作业 | 有成本（积分 / 上游留痕），不可能一直跑 |
 *
 * 两者此前各自成篇：账号页看不到实测结论，网关页的「被动底色」只单向取台账里 `active` 的格。
 * 本模块把二者按 `(uid, model)` 对齐，**两侧读同一份派生值** —— 两处各自拼一份必然漂移。
 *
 * ## 三条硬口径（改动前先读）
 *
 * 1. **实测结论跨作业累积**：后端作业是**单槽**，新作业从空 `cells` 开始（网关卡就是这么用的）。
 *    账号页的「逐行实测」若只读「本次作业」，探第二行就把第一行的结论冲掉。
 *    ⇒ 前端按 `(uid, model)` 合并各次作业（{@link mergeProbeCells}），与后端单槽不冲突：
 *    合并只发生在**读侧**，不改变作业语义。
 * 2. **只合并、不擦除**：某格探出 `ok` 就覆盖该格；**没有**「某次作业没包含它 ⇒ 删掉它」——
 *    那会让「探了一格」把整张矩阵清空。
 * 3. **不篡改台账**：台账状态是历史证据，实测是此刻证据。冲突只**并列**呈现
 *    （{@link limitConflict}），谁对不归 UI 裁定。
 *
 * ⚠️ 三档「限流」的口径与 `model_probe::ProbeState` 的注释一致：只有
 * `rate_limited_model` / `rate_limited_account` / `model_blocked` 算限流；
 * `no_credits`（402）与 `auth_dead` 必须分列（`client_limits` 已踩过「把没积分报成限流 ⇒
 * 用户去傻等解锁」的坑）。
 */

import type { ClientLimitEntry, ModelProbeCell, ModelProbeState } from "./types";

/** 只有这三档算「限流」（与 `PROBE_LIMIT_STATES` 同源；这里放在 lib 侧供纯函数复用）。 */
export const LIMIT_STATES: readonly ModelProbeState[] = [
  "rate_limited_model",
  "rate_limited_account",
  "model_blocked",
];

/** 该状态是否算「限流」。 */
export function isLimitState(state: ModelProbeState | null | undefined): boolean {
  return state != null && (LIMIT_STATES as readonly string[]).includes(state);
}

/**
 * 状态的**语义色调**（框架无关；调用方自行映射到 Badge variant / 颜色）。
 *
 * 与网关卡矩阵同口径：只有三档限流 + 「可用」有强色；402 / 网络类都算**中性提醒**
 * 而不是「限流」，否则用户会去等一个永远不来的解锁。
 */
export function probeTone(state: ModelProbeState | null | undefined): "ok" | "warn" | "bad" | "muted" {
  switch (state) {
    case "ok":
      return "ok";
    case "rate_limited_model":
    case "no_credits":
    case "upstream_error":
    case "upstream_queued":
    case "transport_error":
      return "warn";
    case "rate_limited_account":
    case "model_blocked":
    case "auth_dead":
    case "model_unavailable":
      return "bad";
    default:
      return "muted";
  }
}

export type ProbeCellIndex = Record<string, Record<string, Record<string, ModelProbeCell>>>;

/**
 * 把一次作业快照的格合并进索引（返回**新对象**；zustand 靠引用变化触发重渲染）。
 *
 * 合并规则（见模块头第 2 条）：**同格覆盖、异格保留**。没有任何新格时**原样返回同一个引用**
 * —— 探测进行中每秒拉一次快照，若每次都造新对象，账号页会跟着空转重渲染。
 */
export function mergeProbeCells(
  index: ProbeCellIndex,
  scope: string,
  cells: readonly ModelProbeCell[],
): ProbeCellIndex {
  if (cells.length === 0) return index;
  const bucket = index[scope] ?? {};
  let next: ProbeCellIndex | null = null;
  for (const cell of cells) {
    if (!cell.uid || !cell.model) continue;
    const models = next ? next[scope] : bucket;
    const previous = models[cell.uid]?.[cell.model];
    if (previous && previous.http_status === cell.http_status && previous.state === cell.state
      && previous.latency_ms === cell.latency_ms
      && previous.reset_at_ms === cell.reset_at_ms
      && previous.probed_at_ms === cell.probed_at_ms) {
      continue;
    }
    next ??= { ...index, [scope]: { ...bucket } };
    const uidBucket = { ...(next[scope][cell.uid] ?? {}) };
    uidBucket[cell.model] = cell;
    next[scope] = { ...next[scope], [cell.uid]: uidBucket };
  }
  return next ?? index;
}

/**
 * 取某格的实测结论（没有 ⇒ `null`，**不是**「可用」）。
 *
 * 入参与 {@link probeOnlyLimits} 一致：**已按作用域收窄**的那一层
 * （`useProbeCells(scope)` 的返回值）。
 */
export function probeCellOf(
  cells: Readonly<Record<string, Record<string, ModelProbeCell>>>,
  uid: string | null | undefined,
  model: string | null | undefined,
): ModelProbeCell | null {
  if (!uid || !model) return null;
  return cells[uid]?.[model] ?? null;
}

/** 一次探测的目标集合。 */
export interface ProbeTargets {
  pairs: { uid: string; model: string }[];
  uids: string[];
  models: string[];
  /** 真实格数 = `pairs.length`。 */
  cells: number;
}

export function isProbeWorthy(entry: ClientLimitEntry): boolean {
  if (!entry.accountUid || !entry.model) return false;
  return entry.state === "active" || entry.state === "unknown";
}

export function probeTargets(entries: readonly ClientLimitEntry[]): ProbeTargets {
  const pairs: { uid: string; model: string }[] = [];
  for (const entry of entries) {
    if (!isProbeWorthy(entry)) continue;
    pairs.push({ uid: entry.accountUid as string, model: entry.model as string });
  }
  return probeTargetsOfPairs(pairs);
}

export function probeTargetsOfPairs(
  pairs: readonly { uid: string | null | undefined; model: string | null | undefined }[],
): ProbeTargets {
  const dedup: { uid: string; model: string }[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (!pair.uid || !pair.model) continue;
    const key = `${pair.uid}\u0000${pair.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push({ uid: pair.uid, model: pair.model });
  }
  return {
    pairs: dedup,
    uids: [...new Set(dedup.map((pair) => pair.uid))],
    models: [...new Set(dedup.map((pair) => pair.model))],
    cells: dedup.length,
  };
}

export type LimitConflict = "recovered_by_probe" | "limited_after_recovery";

/**
 * 台账结论 vs 实测结论是否冲突。
 *
 * - `recovered_by_probe`：台账仍受限/未知，但此刻实测**可用**（最常见，也是真正有用的信息）；
 * - `limited_after_recovery`：台账已恢复，但此刻实测**受限**（限流又回来了）。
 *
 * 其余（一致 / 实测是 402、登录失效等非限流档）⇒ `null`，由界面只显示实测结论。
 */
export function limitConflict(
  entry: ClientLimitEntry,
  cell: ModelProbeCell | null,
): LimitConflict | null {
  if (!cell) return null;
  const ledgerLimited = entry.state === "active" || entry.state === "unknown";
  if (ledgerLimited && cell.state === "ok") return "recovered_by_probe";
  if (entry.state === "recovered" && isLimitState(cell.state)) return "limited_after_recovery";
  return null;
}

/**
 * 取**全部限流格**（确定性排序：账号 → 模型）。
 *
 * 无「客户端限流台账」的平台（Qoder / Trae 的账号页卡，`ClientLimitsCard ledger={false}`）用它 ——
 * 那边没有台账可对照，结论只可能来自实测。WB 的「实测独有」是它的**子集**（再滤掉台账已覆盖的格），
 * 故 `probeOnlyLimits` 建在它之上，排序口径只此一处。
 */
export function limitedCells(
  cells: Readonly<Record<string, Record<string, ModelProbeCell>>>,
): ModelProbeCell[] {
  const out: ModelProbeCell[] = [];
  for (const models of Object.values(cells)) {
    for (const cell of Object.values(models)) {
      if (isLimitState(cell.state)) out.push(cell);
    }
  }
  out.sort((a, b) => a.uid.localeCompare(b.uid) || a.model.localeCompare(b.model));
  return out;
}

export function probeOnlyLimits(
  cells: Readonly<Record<string, Record<string, ModelProbeCell>>>,
  entries: readonly ClientLimitEntry[],
): ModelProbeCell[] {
  const covered = new Set<string>();
  for (const entry of entries) {
    if (!entry.accountUid || !entry.model) continue;
    covered.add(`${entry.accountUid}\u0000${entry.model}`);
  }
  if (covered.size === 0) return limitedCells(cells);
  return limitedCells(cells).filter((cell) => !covered.has(`${cell.uid}\u0000${cell.model}`));
}

/** 一次作业的汇总（用于卡头/进度）。 */
export interface ProbeTally {
  cells: number;
  limited: number;
  ok: number;
}

export function tallyCells(
  cells: Readonly<Record<string, Record<string, ModelProbeCell>>>,
): ProbeTally | null {
  let total = 0;
  let limited = 0;
  let ok = 0;
  for (const models of Object.values(cells)) {
    for (const cell of Object.values(models)) {
      total += 1;
      if (isLimitState(cell.state)) limited += 1;
      else if (cell.state === "ok") ok += 1;
    }
  }
  return total === 0 ? null : { cells: total, limited, ok };
}
