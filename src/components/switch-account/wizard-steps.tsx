
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** 向导步骤：1 = 目标与来源，2 = 迁移内容，3 = 确认。 */
export type WizardStep = 1 | 2 | 3;

/** 全部步骤（顺序即展示顺序）。 */
const WIZARD_STEPS: readonly WizardStep[] = [1, 2, 3];

export function WizardSteps({ step }: { step: WizardStep }) {
  const t = useT();
  const labels: Record<WizardStep, string> = {
    1: t("wbAccounts.wizard.stepTarget"),
    2: t("wbAccounts.wizard.stepContent"),
    3: t("wbAccounts.wizard.stepConfirm"),
  };

  return (
    <ol className="flex items-center gap-1.5" aria-label={t("wbAccounts.wizard.stepsAria")}>
      {WIZARD_STEPS.map((n, index) => {
        const done = step >= n;
        return (
          <li key={n} className="flex min-w-0 flex-1 items-center gap-1.5">
            {index > 0 ? <span className="h-px flex-1 bg-border" aria-hidden="true" /> : null}
            <span
              className={cn(
                /* 原型 `.steps .s`（`demo.css:499`）：`11px` / muted（不是 12px） */
                "flex min-w-0 items-center gap-1.5 text-[11px]",
                done ? "text-foreground" : "text-muted-foreground",
              )}
              aria-current={step === n ? "step" : undefined}
            >
              <span
                className={cn(
                  /* 原型 `.steps .s i`（`demo.css:500-503`）：`20×20` 圆点、
                     **未激活也有 `--muted` 底** + `--border` 描边（此前是空心圈，看起来像"没渲染"）。*/
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10.5px] font-semibold",
                  done
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {n}
              </span>
              <span className="truncate">{labels[n]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
