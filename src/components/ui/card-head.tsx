
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface CardHeadProps {
  /** 已 i18n 的标题。 */
  title: string;
  /** 说明 / 图注（原型 `.sub`）。 */
  caption?: string;
  /** 右侧动作区（图表导出、图-表切换、计数徽标…）。 */
  actions?: ReactNode;
  className?: string;
}

export function CardHead({ title, caption, actions, className }: CardHeadProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-start justify-between gap-2 border-b border-border/60 px-4 py-[13px]",
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="text-[13.5px] font-semibold leading-5">{title}</h3>
        {caption ? (
          <p className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground">{caption}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
