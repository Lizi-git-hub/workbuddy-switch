
import { Ban, Check, Monitor } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT, type Translate } from "@/lib/i18n";
import { platformDescriptor } from "@/lib/platforms/registry";
import { regionLabel } from "@/lib/region";
import { scopeParts, type Scope } from "@/lib/scope";
import { cn } from "@/lib/utils";

/** 一个候选来源作用域。 */
export interface SourceOption {
  scope: Scope;
  /** 该作用域**当前登录账号**的展示名；未知时 `null`（回落「当前登录账号」）。 */
  accountName: string | null;
  supportsSessionCopy: boolean;
}

export interface SourceAccountPickerProps {
  options: SourceOption[];
  /** 当前选中的来源作用域。 */
  selectedScope: Scope;
  /** 「从其他作用域选择…」开关是否打开。 */
  crossScope: boolean;
  /** 目标程序位展示名（本向导只切 WorkBuddy 桌面 ⇒ 单值只读）。 */
  programLabel: string;
  onPick: (scope: Scope) => void;
  onToggleCross: () => void;
}

/** 作用域展示名：`产品 · 区域`，如「WorkBuddy · 国内版」。 */
export function scopeLabel(scope: Scope, t: Translate): string {
  const { product, region } = scopeParts(scope);
  /* 产品名走注册表（唯一来源），**不**在本地再写一份 `product === "workbuddy" ? … : …`。 */
  const productLabel = t(platformDescriptor(product).labelKey);
  return `${productLabel} · ${regionLabel(region)}`;
}

export function SourceAccountPicker({
  options,
  selectedScope,
  crossScope,
  programLabel,
  onPick,
  onToggleCross,
}: SourceAccountPickerProps) {
  const t = useT();

  return (
    <div className="space-y-4">
      {/* 目标程序位：本向导只切换 WorkBuddy 桌面客户端 ⇒ **单值**。
          刻意渲染成只读行（不是选择器）—— 单选项的「切换器」是假控件（§3.15.1）。 */}
      <section className="space-y-2">
        <h4 className="text-sm font-medium">{t("wbAccounts.wizard.programLabel")}</h4>
        <div className="flex items-center gap-2 rounded-md border px-3 py-2.5">
          <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm">{programLabel}</span>
        </div>
      </section>

      {/* 来源账号（含跨作用域入口）。 */}
      <section className="space-y-2">
        <h4 className="text-sm font-medium">{t("wbAccounts.wizard.sourceTitle")}</h4>
        <p className="text-xs text-muted-foreground">{t("wbAccounts.wizard.sourceDesc")}</p>

        <div className="space-y-1.5">
          {options.map((option) => {
            const label = scopeLabel(option.scope, t);
            const accountName = option.accountName ?? t("wbAccounts.wizard.sourceCurrent");

            /* 跨产品（Trae）来源：**不可点** + 说明原因（不是「去设置里找开关」——那里没有）。 */
            if (!option.supportsSessionCopy) {
              return (
                <div
                  key={option.scope}
                  aria-disabled="true"
                  className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2.5 opacity-70"
                >
                  <Ban className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{label}</div>
                    <div className="text-xs text-muted-foreground">
                      {t("wbAccounts.wizard.sourceUnsupported")}
                    </div>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {t("wbAccounts.wizard.sourceUnsupportedBadge")}
                  </Badge>
                </div>
              );
            }

            const selected = option.scope === selectedScope;
            return (
              <button
                key={option.scope}
                type="button"
                data-act={`wiz-src|${option.scope}`}
                aria-pressed={selected}
                onClick={() => onPick(option.scope)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors",
                  selected ? "border-primary bg-accent/50" : "hover:bg-accent/40",
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
                  )}
                  aria-hidden="true"
                >
                  {selected ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{accountName}</span>
                </span>
                {selected ? (
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {t("wbAccounts.wizard.sourceBadge")}
                  </Badge>
                ) : null}
              </button>
            );
          })}
        </div>

        <Button type="button" variant="ghost" size="sm" data-act="wiz-cross" onClick={onToggleCross}>
          {crossScope ? t("wbAccounts.wizard.crossHide") : t("wbAccounts.wizard.crossShow")}
        </Button>
      </section>
    </div>
  );
}
