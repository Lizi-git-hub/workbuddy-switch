import { matchesAccountQuery } from "@/lib/account-search";

/** 排序键。默认 `priority`（= 现状写死的「自动积分优先级」）。 */
export type AccountSortKey = "priority" | "name" | "expiry" | "recent";

export type AccountGroupKey = "none" | "program" | "status" | "group";

/** 视图形态。 */
export type AccountViewMode = "card" | "table";

/** 一个分组桶。`key === null` 表示不分组（单桶）或「无桶名」桶。 */
export interface AccountBucket<T> {
  key: string | null;
  items: T[];
}

export type AccountComparator<T> = (a: T, b: T) => number;

export interface AccountListConfig<T> {
  searchText: (row: T) => string;
  /** 排序比较器。**只需覆盖 `availableSorts`**；缺的键 `sortAccounts` 保持原序。 */
  comparators: Partial<Record<AccountSortKey, AccountComparator<T>>>;
  /** 排序后置顶（如 WB「当前账号置顶」）；缺省不动。 */
  pinFirst?: (sorted: T[]) => T[];
  /** 分组取桶键；返回 `null` ⇒ 该行落入「无桶名」桶（不渲染分组标题）。 */
  bucketKey: (row: T, group: AccountGroupKey) => string | null;
  availableSorts: AccountSortKey[];
  availableGroups: AccountGroupKey[];
}

/** 过滤（就地，不改后端）。空查询恒返回原数组。 */
export function filterAccounts<T>(rows: T[], config: AccountListConfig<T>, query: string): T[] {
  if (!query.trim()) return rows;
  return rows.filter((row) => matchesAccountQuery(config.searchText(row), query));
}

export function sortAccounts<T>(rows: T[], key: AccountSortKey, config: AccountListConfig<T>): T[] {
  const compare = config.comparators[key];
  const base = compare
    ? rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => {
          const diff = compare(left.row, right.row);
          return diff !== 0 ? diff : left.index - right.index;
        })
        .map(({ row }) => row)
    : [...rows];
  return config.pinFirst ? config.pinFirst(base) : base;
}

/**
 * 分桶。`none` 返回单桶（`key = null`）。
 *
 * 桶内保持入参顺序（调用方通常先 `sortAccounts` 再 `groupAccounts`）；
 * 桶之间的顺序按**首次出现**排列（Map 的插入序），因此「先出现的状态排前面」。
 */
export function groupAccounts<T>(
  rows: T[],
  group: AccountGroupKey,
  config: AccountListConfig<T>,
): AccountBucket<T>[] {
  if (group === "none") return [{ key: null, items: rows }];

  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const bucketKey = config.bucketKey(row, group) ?? "";
    let items = map.get(bucketKey);
    if (!items) {
      items = [];
      map.set(bucketKey, items);
      order.push(bucketKey);
    }
    items.push(row);
  }
  return order.map((bucketKey) => ({
    key: bucketKey === "" ? null : bucketKey,
    items: map.get(bucketKey) ?? [],
  }));
}

/**
 * 是否有任何筛选生效（用于「真没有数据」vs「被筛没了」的判据）。
 *
 * ⚠️ 分桶（`group`）本身**不移除**任何行，因此「被筛没」的充分判据仍是
 * `query` 非空；本函数把 `group` 一并计入，是因为「清除筛选」出口要**同时**复位两者。
 */
export function hasActiveFilter(state: { query: string; group: AccountGroupKey }): boolean {
  return state.query.trim().length > 0 || state.group !== "none";
}
