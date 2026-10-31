
import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  /** 图标组件（lucide 图标即可）。 */
  icon: ComponentType<{ className?: string }>;
  /** 一句话说明「这里本该有什么」。 */
  title: string;
  /** 补充原因或后果（可选，但**有原因时一定要写**）。 */
  description?: string;
  /** **出口**：下一步做什么（按钮 / 链接）。 */
  action?: ReactNode;
  className?: string;
}

/**
 * ## 几何逐值对齐原型 `.empty`（`demo.css:357-364`）
 *
 * - 容器 `padding:56px 20px`（此前 `px-6 py-10` = 24/40px）；
 * - **图标底块 44px / 圆角 14px / `--muted` 底**（此前是 32px **裸图标**，没有底块）——
 *   这是最显眼的一处：原型所有空态都有一个「圆角方块托着图标」；
 * - 底块内图标 20px；标题 14px/600；说明 12.5px。
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-5 py-14 text-center text-muted-foreground",
        className,
      )}
    >
      <div
        className="mb-3.5 grid size-11 shrink-0 place-items-center rounded-[14px] bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        <Icon className="size-5" />
      </div>
      <p className="mb-1.5 text-sm font-semibold text-foreground">{title}</p>
      {description ? (
        <p className="mb-4 max-w-sm text-[12.5px] leading-relaxed">{description}</p>
      ) : null}
      {action ? <div className="mt-0.5">{action}</div> : null}
    </div>
  );
}
