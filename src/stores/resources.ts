import { create } from "zustand";

/** 单个键的快照条目。 */
export interface ResourceEntry<T = unknown> {
  /** 最后一次**成功**取到的值；从未成功过则为 `undefined`。 */
  value: T | undefined;
  /** 最后一次失败的**原始**错误。刻意不在这里格式化：格式化要用 `api.asError`，
   *  那会把 Tauri 依赖拖进本模块，而本模块要能脱离浏览器环境独立验证（见 `load`）。 */
  error: unknown;
  /** 是否有请求在飞。 */
  pending: boolean;
  /** 最后一次成功写入的时刻（ms）。 */
  at: number;
}

const EMPTY: ResourceEntry = { value: undefined, error: null, pending: false, at: 0 };

/** 同键在飞请求：重挂载（含 StrictMode 双调用）与快速来回切都复用它，不再发第二轮。 */
const inFlight = new Map<string, Promise<void>>();

/**
 * 同键请求序号。
 *
 * 过期判据用**序号**而不是「在飞表里的身份」：`force` 刷新会覆盖在飞表，
 * 若按身份比较，那个更早发出、更晚返回的旧请求会把新请求刚写好的值又改回去
 * （症状是「点完签到，界面上又变回签到前的积分」）。
 */
const seqOf = new Map<string, number>();

/**
 * 条目上限。
 *
 * 有些键是**跟着筛选条件走的**（如运行日志的 `kind × date × keyword`），
 * 键的集合随用户操作增长。没有上限的缓存就是内存泄漏 —— 而且症状很隐蔽
 * （长时间用下来才慢慢变大）。超限时按「最后一次成功写入的时刻」淘汰最旧的，
 * **正在请求中的条目不淘汰**（它的结果马上要写回来，淘汰了等于白跑一趟）。
 */
const MAX_ENTRIES = 32;

/** 淘汰最旧的若干条，直到条目数回到上限内。 */
function pruneOldest(entries: Record<string, ResourceEntry>): Record<string, ResourceEntry> {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ENTRIES) return entries;

  const evictable = keys
    .filter((key) => !entries[key].pending)
    .sort((a, b) => entries[a].at - entries[b].at);
  const next = { ...entries };
  for (const key of evictable) {
    if (Object.keys(next).length <= MAX_ENTRIES) break;
    delete next[key];
    inFlight.delete(key);
    seqOf.delete(key);
  }
  return next;
}

export interface ResourceLoadOptions {
  /** 不复用同键在飞请求，强制发一次新请求。**变更操作之后必须用它**。 */
  force?: boolean;
  freshMs?: number;
}

interface ResourceState {
  entries: Record<string, ResourceEntry>;
  load: (key: string, loader: () => Promise<unknown>, opts?: ResourceLoadOptions) => Promise<void>;
  /**
   * 就地改写快照值（乐观更新）。刻意不动 `at`：它表达的是「上次校验时刻」。
   *
   * `updater` 返回 `undefined` 表示「当前没有可改的值，不改动」——
   * 直接写回 `undefined` 会**清掉**已有快照（界面瞬间变空态），比不改更坏。
   *
   * 入参用 `unknown` 而非泛型：泛型方法放进 `create<…>()` 的对象字面量里，
   * 实现侧的 `T` 会被实例化成 `unknown` 而无法自洽。类型安全由
   * `useCachedResource` 的 `patch` 包装层提供（那里 `T` 是确定的）。
   */
  patch: (key: string, updater: (current: unknown) => unknown) => void;
}

export const useResourceStore = create<ResourceState>((set, get) => ({
  entries: {},

  async load(key, loader, opts) {
    const force = opts?.force === true;
    const freshMs = opts?.freshMs ?? 0;

    if (!force) {
      const entry = get().entries[key];
      if (entry?.value !== undefined && freshMs > 0 && Date.now() - entry.at < freshMs) return;
      const existing = inFlight.get(key);
      if (existing) return existing;
    }

    const mySeq = (seqOf.get(key) ?? 0) + 1;
    seqOf.set(key, mySeq);
    const isStale = () => seqOf.get(key) !== mySeq;

    set((s) => ({
      entries: { ...s.entries, [key]: { ...(s.entries[key] ?? EMPTY), pending: true } },
    }));

    const run = (async () => {
      try {
        const value = await loader();
        if (isStale()) return;
        set((s) => ({
          entries: pruneOldest({
            ...s.entries,
            [key]: { value, error: null, pending: false, at: Date.now() },
          }),
        }));
      } catch (error) {
        if (isStale()) return;
        set((s) => ({
          entries: {
            ...s.entries,
            [key]: { ...(s.entries[key] ?? EMPTY), error, pending: false },
          },
        }));
      } finally {
        // 只有「自己仍是最新那次请求」时才清在飞标记，否则会把新请求的标记一起清掉。
        if (seqOf.get(key) === mySeq) inFlight.delete(key);
      }
    })();

    inFlight.set(key, run);
    return run;
  },

  patch(key, updater) {
    set((s) => {
      const current = s.entries[key] ?? EMPTY;
      const next = updater(current.value);
      if (next === undefined) return s;
      return { entries: { ...s.entries, [key]: { ...current, value: next } } };
    });
  },
}));
