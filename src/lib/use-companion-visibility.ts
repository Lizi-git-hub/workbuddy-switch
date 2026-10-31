
import { useCallback, useEffect, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import * as api from "@/lib/api";

const COMPANION_VISIBILITY_KEY = "buddy-switch.companion-visible";

/**
 * 可见性事件名（与 `src-tauri/src/companion.rs` 的 `VISIBILITY_EVENT` 逐字一致）。
 *
 * 托盘菜单项 / 窗口内关闭按钮改可见性时都会 emit 它，主窗口据此同步侧栏图标的状态。
 */
const COMPANION_VISIBILITY_EVENT = "companion-visibility";

function readCompanionVisibilityPreference(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(COMPANION_VISIBILITY_KEY);
    // 未设置 ⇒ 默认显示；只有显式写入过 `"false"` 才判为隐藏。
    return raw === null ? true : raw === "true";
  } catch {
    // 隐私模式 / 存储被禁用：退回默认（**不抛** —— 偏好是锦上添花，不该让侧栏崩）。
    return true;
  }
}

/** 持久化可见性偏好（写失败静默 —— 本次会话内仍按内存状态工作）。 */
function writeCompanionVisibilityPreference(visible: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMPANION_VISIBILITY_KEY, visible ? "true" : "false");
  } catch {
    /* 存储不可用：忽略 */
  }
}

export function useCompanionVisibility(): [boolean, (next: boolean) => void] {
  const [visible, setVisibleState] = useState<boolean>(readCompanionVisibilityPreference);
  // 用 ref 追踪最近一次已知可见性：事件回调与 setter 都读它，避免闭包里的过期值。
  const visibleRef = useRef<boolean>(visible);
  visibleRef.current = visible;

  useEffect(() => {
    // webui / 移动端没有悬浮窗：不碰 Tauri 窗口 API（`listen` / 命令都可能抛）。
    if (!api.isDesktop()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void api.companionSetVisible(readCompanionVisibilityPreference()).catch(() => {
      /* 后端未就绪（冷启动 / 演示模式）不致命：窗口显示与否由下次交互决定 */
    });

    // ② 与另两面同步：托盘 / 窗口内关闭按钮改可见性时，把**真实状态**同步进来并写回偏好。
    void listen<boolean>(COMPANION_VISIBILITY_EVENT, (event) => {
      if (disposed) return;
      visibleRef.current = event.payload;
      setVisibleState(event.payload);
      writeCompanionVisibilityPreference(event.payload);
    })
      .then((fn) => {
        // 订阅在卸载后才返回 ⇒ 立刻退订，避免泄漏（侧栏会随产品切换反复挂载）。
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* 非 Tauri 环境 / 无权限：侧栏图标仍可用，只是不再被动同步 */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const setVisible = useCallback((next: boolean) => {
    const previous = visibleRef.current;
    // 乐观更新 + 持久化：即使命令在途，图标也立即反映用户意图。
    visibleRef.current = next;
    setVisibleState(next);
    writeCompanionVisibilityPreference(next);

    void api.companionSetVisible(next).catch(() => {
      visibleRef.current = previous;
      setVisibleState(previous);
      writeCompanionVisibilityPreference(previous);
    });
  }, []);

  return [visible, setVisible];
}
