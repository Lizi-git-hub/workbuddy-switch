
import { displayText } from "@/lib/display-text";
import { t } from "@/lib/i18n";
import type {
  AccountMeta,
  Session,
  SessionReplicaContent,
  SessionReplicaGroup,
  SyncSessionReplicaItem,
  UnifySessionReplicaItem,
} from "@/lib/types";

/** 一行副本（已 join 账号显示名 + 会话行，标题已过 `displayText`）。 */
export interface SessionReplicaRow {
  /** 副本所属账号 uid（ledger 的 source_uid / target_uid）。 */
  accountUid: string;
  /** 账号显示名；**uid 不在账号库 ⇒ `uid 前缀 + 「未知账号」`**（✅ #3，**绝不**留空）。 */
  accountLabel: string;
  /** 该账号里的会话 id。 */
  sessionId: string;
  title: string;
  /** 来自 `list_sessions` 会话行；取不到为 `null`（**不臆造**）。 */
  updatedAt: number | null;
  /** 来自 `list_sessions` 会话行；取不到为 `false`。 */
  hasHistory: boolean;
}

export type SessionGroupStatus = "latest" | "behind" | "diverge" | "unknown";

/** 一组副本的可渲染视图。 */
export interface SessionGroupView {
  /** 稳定组键（= 后端给的 `key`；用于 React key）。 */
  key: string;
  rows: SessionReplicaRow[];
  partial: true;
  status: SessionGroupStatus;
  /** 共同旧版的**条数**（所有副本两两公共前缀的**最小值**）；`unknown` 时为 `null`。 */
  commonPrefix: number | null;
  /** 各组员相对共同旧版的**新增条数**（`sessionId → delta`）；`unknown` 时为空。 */
  deltas: Map<string, number>;
  /** 行数最多的副本的条数（`latestLineCount`）；`unknown` 时为 `null`。 */
  latestLineCount: number | null;
  previewToken: string | null;
  baseline: SessionBaselineView | null;
  sinceBaseline: Map<string, number | null>;
  titles: Map<string, string>;
}

/** [`SessionGroupView.baseline`] 的展示形态（只带界面要用的两个字段）。 */
export interface SessionBaselineView {
  createdAt: number;
  lineCount: number;
}

/** 一组「内容结论」的**诚实空值**（缺字段 / 脏值 / 旧后端 ⇒ 落这里，**不臆造**）。 */
function unknownContent(): Pick<
  SessionGroupView,
  "status" | "commonPrefix" | "deltas" | "latestLineCount" | "sinceBaseline"
> {
  return {
    status: "unknown",
    commonPrefix: null,
    deltas: new Map<string, number>(),
    latestLineCount: null,
    sinceBaseline: new Map<string, number | null>(),
  };
}

/** 后端 `content.status` 的合法取值（越界一律落 `unknown`，不把脏值透到 UI）。 */
const CONTENT_STATUSES: readonly SessionGroupStatus[] = ["latest", "behind", "diverge", "unknown"];

function contentOf(
  content: SessionReplicaContent | null | undefined,
): Pick<SessionGroupView, "status" | "commonPrefix" | "deltas" | "latestLineCount" | "sinceBaseline"> {
  if (!content) return unknownContent();
  const status = CONTENT_STATUSES.includes(content.status) ? content.status : "unknown";
  const deltas = new Map<string, number>();
  for (const [sessionId, delta] of Object.entries(content.deltas ?? {})) {
    if (typeof delta === "number") deltas.set(sessionId, delta);
  }
  const sinceBaseline = new Map<string, number | null>();
  for (const [sessionId, delta] of Object.entries(content.sinceBaseline ?? {})) {
    if (delta === null || typeof delta === "number") sinceBaseline.set(sessionId, delta);
  }
  return {
    status,
    commonPrefix: typeof content.commonPrefix === "number" ? content.commonPrefix : null,
    deltas,
    latestLineCount:
      typeof content.latestLineCount === "number" ? content.latestLineCount : null,
    sinceBaseline,
  };
}

/** 从账号清单建 `uid → 显示名`（`nickname → email → id` 降级链；空值不登记）。 */
export function buildAccountLabels(accounts: AccountMeta[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const account of accounts) {
    const uid = displayText(account.uid);
    if (!uid) continue;
    const label =
      displayText(account.nickname) ?? displayText(account.email) ?? displayText(account.id);
    if (label && label.trim() !== "") labels.set(uid, label);
  }
  return labels;
}

export function buildSessionsByAccount(
  currentUid: string | null,
  sessions: Session[],
): Map<string, Map<string, Session>> {
  const byId = new Map<string, Session>();
  for (const session of sessions) {
    const id = displayText(session.id);
    if (id) byId.set(id, session);
  }
  const map = new Map<string, Map<string, Session>>();
  const key = displayText(currentUid);
  if (key) map.set(key, byId);
  return map;
}

/** 账号显示名：命中账号库用显示名；否则 `uid 前缀 + 「未知账号」`（**绝不**留空）。 */
function resolveAccountLabel(uid: string, labels: Map<string, string>): string {
  const known = displayText(labels.get(uid));
  if (known && known.trim() !== "") return known;
  // 前缀取前 8 位（与账号卡片的短 uid 口径一致）；uid 本身可能很短，兜底用整体。
  const prefix = uid.slice(0, 8) || uid;
  return t("sessions.replica.unknownAccount", { uid: prefix });
}

function findSession(
  sessionsByAccount: Map<string, Map<string, Session>>,
  uid: string,
  sessionId: string,
): Session | undefined {
  return sessionsByAccount.get(uid)?.get(sessionId);
}

/**
 * 把后端副本组 + 账号显示名 + 会话行 → 可渲染视图。
 *
 * **纯函数**（可测）：不读 store、不发请求。`partial` 在此**字面量锁死**为 `true`。
 *
 * ⚠️ **本函数不算内容状态**：`status` / `commonPrefix` / `deltas` / `latestLineCount` /
 * `sinceBaseline` 全部来自后端 `group.content`（core 按 jsonl 指纹算完）；
 * 这里只把「最近一次一致点」从 `group.baseline` 摊平成展示形态，并对脏响应兜底。
 */
export function buildGroupViews(
  groups: SessionReplicaGroup[],
  sessionsByAccount: Map<string, Map<string, Session>>,
  accountLabels: Map<string, string>,
): SessionGroupView[] {
  return groups.map((group) => {
    const rows: SessionReplicaRow[] = group.replicas.map((replica) => {
      const session = findSession(sessionsByAccount, replica.accountUid, replica.sessionId);
      return {
        accountUid: replica.accountUid,
        accountLabel: resolveAccountLabel(replica.accountUid, accountLabels),
        sessionId: replica.sessionId,
        title: displayText(session?.title) ?? t("sessions.replica.titleFallback"),
        updatedAt: typeof session?.updatedAt === "number" ? session.updatedAt : null,
        hasHistory: session?.hasHistory === true,
      };
    });
    return {
      key: group.key,
      partial: true,
      rows,
      previewToken: displayText(group.previewToken),
      baseline:
        group.baseline && typeof group.baseline.lineCount === "number"
          ? { createdAt: group.baseline.createdAt, lineCount: group.baseline.lineCount }
          : null,
      ...contentOf(group.content),
      titles: buildTitleMap(group.titles),
    };
  });
}

/**
 * 把后端给的 `titles` 数组转成 `sessionId → 标题`，并过滤脏值。
 *
 * 与 `rows[].title` 不同：这里**不做兜底**——取不到就不放进表，
 * 界面据此判断「该副本的标题未知」，而不是拿兜底文案去比较（那会造成假差异）。
 */
function buildTitleMap(
  titles: { uid: string; cid: string; title: string }[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of titles ?? []) {
    const text = displayText(item.title);
    if (text) map.set(item.cid, text);
  }
  return map;
}

export function buildSyncItems(
  group: SessionGroupView,
  title?: string,
): SyncSessionReplicaItem[] {
  if (group.status !== "behind") return [];
  if (group.rows.length < 2 || group.deltas.size === 0) return [];

  const previewToken = group.previewToken;
  if (!previewToken) return [];

  const deltaOf = (row: SessionReplicaRow) => group.deltas.get(row.sessionId) ?? 0;
  const maxDelta = Math.max(...group.rows.map(deltaOf));
  if (maxDelta <= 0) return [];

  const source = group.rows.find((row) => deltaOf(row) === maxDelta);
  if (!source) return [];

  return group.rows
    .filter((row) => row.sessionId !== source.sessionId && deltaOf(row) < maxDelta)
    .map((row) => ({
      sourceCid: source.sessionId,
      targetCid: row.sessionId,
      groupKey: group.key,
      previewToken,
      ...(title ? { title } : {}),
    }));
}

/**
 * 组内标题的**分组视图**：同名副本归到一起，并带上「这个名字来自哪些账号」。
 *
 * 只用 `group.titles`（后端直读库、跨账号可读）；取不到标题的副本不参与。
 * 返回长度 < 2 ⇒ 没有可选的（调用方据此**不弹框**，直接同步）。
 */
export function titleChoices(
  group: SessionGroupView,
): { title: string; owners: string[] }[] {
  const byTitle = new Map<string, string[]>();
  for (const row of group.rows) {
    const title = group.titles.get(row.sessionId);
    if (!title) continue;
    const owners = byTitle.get(title) ?? [];
    if (!owners.includes(row.accountLabel)) owners.push(row.accountLabel);
    byTitle.set(title, owners);
  }
  return Array.from(byTitle, ([title, owners]) => ({ title, owners }));
}

/**
 * 只有标题不一致、**内容已经一致**的组：生成「仅改名」任务。
 *
 * ## 为什么要单独一个函数
 *
 * [`buildSyncItems`] 只在 `behind` 时给任务（它的语义是「追加内容」）。于是
 * 「内容 latest + 标题不同」的组在旧逻辑里**没有任何出口** —— 卡片上明晃晃标着
 * 「标题不同」，点开却连同步按钮都没有。
 *
 * 这条路只写标题：后端 `sync_session_replica_for` 会因为「已一致」返回
 * `appendedLines: 0`，随后才执行 `apply_session_title` ⇒ **正文一个字节都不动**。
 * 内容一致，所以「拿哪一份当内容源」无所谓 —— 但**改名对象不能无所谓**：
 * 后端只给 `targetCid` 写标题，被排除在 target 之外的那份永远改不到名字。
 */
export function buildTitleOnlyItems(
  group: SessionGroupView,
  title: string,
): SyncSessionReplicaItem[] {
  const previewToken = group.previewToken;
  const want = (title ?? "").trim();
  if (!previewToken || !want) return [];
  if (group.rows.length < 2) return [];

  // 只给「当前名字与目标名不同」的副本发任务 —— **包含 `rows[0]`**。
  //
  // 旧实现把 `rows[0]` 钉死当内容源、永不作为 target，于是选中「第一份之外的那个
  // 名字」时整批写成一次空操作：被改的那份本来就叫这个名字，该改的那份一个字没动
  // （现场 2026-11-02：选客观存在的「脚本测试」，结果只刷新了客观存在那行的时间戳）。
  return group.rows
    .filter((row) => (group.titles.get(row.sessionId) ?? "").trim() !== want)
    .flatMap((row) => {
      // 内容源换一份（彼此内容一致），否则 source === target 会被后端拒。
      const other = group.rows.find((candidate) => candidate.sessionId !== row.sessionId);
      if (!other) return [];
      return [
        {
          sourceCid: other.sessionId,
          targetCid: row.sessionId,
          groupKey: group.key,
          previewToken,
          title: want,
        },
      ];
    });
}

export function buildUnifyItems(
  group: SessionGroupView,
  keepSessionId: string,
): UnifySessionReplicaItem[] {
  if (group.status !== "diverge") return [];
  if (!group.rows.some((row) => row.sessionId === keepSessionId)) return [];

  const previewToken = group.previewToken;
  if (!previewToken) return [];

  return group.rows
    .filter((row) => row.sessionId !== keepSessionId)
    .map((row) => ({
      sourceCid: keepSessionId,
      targetCid: row.sessionId,
      groupKey: group.key,
      previewToken,
    }));
}

export function failedGroupKeys(
  results: ReadonlyArray<{ ok: boolean; groupKey?: string | null }>,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (result.ok) continue;
    const key = displayText(result.groupKey);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * 某个副本被覆盖时**会丢掉的条数**（= 它相对共同旧版的新增条数，即它的 `delta`）。
 *
 * 推导：该副本的内容 = 共同旧版 + 它自己的新增；覆盖成选定那一份之后，
 * 它自己的那部分就没了 ⇒ **丢的就是它的 `delta`**。
 *
 * 缺指纹 / 该副本不在 `deltas` 里 ⇒ 返回 `null` —— **不臆造**（UI 如实显示「未知」，
 * 而不是显示一个编出来的 0）。
 */
export function lostLinesFor(group: SessionGroupView, sessionId: string): number | null {
  if (group.commonPrefix === null) return null;
  const delta = group.deltas.get(sessionId);
  return delta === undefined ? null : delta;
}
