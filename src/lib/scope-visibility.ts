
import { create } from "zustand";

import { SCOPES, type Scope } from "@/lib/scope";

const STORAGE_KEY = "buddy-switch:v1:visible-scopes";

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** 把任意集合收敛成「按 `SCOPES` 顺序去重后的合法子集」。 */
function normalizeScopes(value: unknown): Scope[] {
  const raw = Array.isArray(value) ? value : [];
  const valid = raw.filter(
    (s): s is Scope => typeof s === "string" && (SCOPES as readonly string[]).includes(s),
  );
  return SCOPES.filter((s) => valid.includes(s));
}

function readVisibleScopes(storage: Pick<Storage, "getItem"> | undefined): Scope[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [...SCOPES];
    const scopes = normalizeScopes(JSON.parse(raw));
    // 至少保留 1 个：解析结果为空 ⇒ 视为坏数据，回落全量
    return scopes.length >= 1 ? scopes : [...SCOPES];
  } catch {
    return [...SCOPES];
  }
}

interface ScopeVisibilityState {
  visibleScopes: readonly Scope[];
  setVisibleScopes: (next: readonly Scope[]) => void;
}

export const useVisibleScopes = create<ScopeVisibilityState>((set, get) => ({
  visibleScopes: readVisibleScopes(safeStorage()),
  setVisibleScopes: (next) => {
    const scopes = normalizeScopes(next);
    // 至少保留 1 个：全被取消时保留当前值（调用方 UI 另有「最后一个不可关」的禁用）
    const result = scopes.length >= 1 ? scopes : get().visibleScopes;
    try {
      safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(result));
    } catch {
      /* 存储不可用（隐私模式）⇒ 记不住，不影响本次会话 */
    }
    set({ visibleScopes: result });
  },
}));

/* 跨 tab 同步：本 store 的写入已即时通知本 tab 的所有订阅者，
   `storage` 事件补上「另一个 tab 改了可见性」这一条路。 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      useVisibleScopes.setState({ visibleScopes: readVisibleScopes(window.localStorage) });
    }
  });
}
