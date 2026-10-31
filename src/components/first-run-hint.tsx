
import { useMemo, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { dismissFirstRunHint, shouldShowFirstRunHint } from "@/lib/first-run";
import { useT } from "@/lib/i18n";
import { planScopeShortcuts } from "@/lib/scope-shortcuts";
import { useShortcutsEnabled } from "@/lib/shortcut-preference";
import { useVisibleScopes } from "@/lib/scope-visibility";

/** 取可用的 `localStorage`（不可用返回 `undefined`）。 */
function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function FirstRunHint() {
  const t = useT();
  const [shortcutsEnabled] = useShortcutsEnabled();
  const visibleScopes = useVisibleScopes((s) => s.visibleScopes);
  const [dismissed, setDismissed] = useState(() => !shouldShowFirstRunHint(safeStorage()));

  const plan = useMemo(
    () => planScopeShortcuts({ scopes: visibleScopes, enabled: shortcutsEnabled }),
    [visibleScopes, shortcutsEnabled],
  );

  if (dismissed) return null;

  // ⌘1..N 只在**绑定存在**时列出（降级 ⇒ 不写进引导，避免假承诺）。
  const scopeHint = plan.bindings.size > 0 ? `⌘1–⌘${plan.bindings.size}` : null;

  function dismiss() {
    dismissFirstRunHint(safeStorage());
    setDismissed(true);
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-[760px] items-start gap-3 rounded-[12px] border border-border bg-popover px-3.5 py-2.5 text-xs shadow-overlay">
        <span className="shrink-0 font-medium text-primary">{t("firstRun.title")}</span>
      <ul className="min-w-0 flex-1 space-y-0.5 text-muted-foreground">
        <li>{t("firstRun.openPalette", { shortcut: "⌘K" })}</li>
        {scopeHint ? <li>{t("firstRun.scopeShortcut", { shortcut: scopeHint })}</li> : null}
        <li>{t("firstRun.listSearch")}</li>
      </ul>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={dismiss}
      >
        <X className="size-3.5" aria-hidden="true" />
        {t("firstRun.dismiss")}
      </Button>
      </div>
    </div>
  );
}
