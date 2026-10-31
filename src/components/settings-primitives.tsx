import type { ReactElement, ReactNode } from "react";

import { DemoAction } from "@/components/demo-action";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface SettingsGroupProps {
  id: string;
  title: string;
  children: ReactNode;
  variant?: "card" | "plain";
}

/**
 * **抽屉形态**的分区（原型 `.dsec`，`demo.css:490-491`）：`flex-col` + `gap:9px`，标题 `h4` = 11.5px/550/muted。
 *
 * 与 `SettingsGroup` 的区别是**没有卡片外壳**：抽屉里不摆卡 —— 原型点顶栏齿轮
 * （`buddy-switch-prototype.html:4455-4461`）打开的就是「一个 `.dsec` + 若干 `.srow`」，
 * 行直接贴在抽屉底色上。
 *
 * ⚠️ 行必须是本容器的**直接子级**，`gap:9px` 才是行距（原型如此）。中间夹一层
 * `display:block` 的包装（如 `CardContent`）会让行距塌成 0、只剩分隔线。
 */
export function SettingsPlainSection({ id, title, children }: SettingsGroupProps) {
  return (
    <section className="flex min-w-0 flex-col gap-[9px]" aria-labelledby={id}>
      <h4 id={id} className="text-[11.5px] font-[550] leading-4 text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  );
}

/** 设置分组：卡片内一条 `.card-head` 标题 + 内容（原型 `viewSettings` 的 `<section class="card">`）。 */
export function SettingsGroup({ id, title, children, variant = "card" }: SettingsGroupProps) {
  if (variant === "plain") {
    return (
      <SettingsPlainSection id={id} title={title}>
        {children}
      </SettingsPlainSection>
    );
  }
  return (
    <section className="min-w-0" aria-labelledby={id}>
      <Card className="min-w-0 gap-0 overflow-hidden rounded-xl py-0 shadow-none">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-[13px]">
          <h2 id={id} className="text-[13.5px] font-semibold leading-5">
            {title}
          </h2>
        </div>
        {children}
      </Card>
    </section>
  );
}

/** 设置行：左右两栏的通用容器（无标签结构时用）。 */
export function SettingsRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-3.5 border-b border-border px-4 py-[13px] last:border-b-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface SettingsFieldRowProps {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  /**
   * 该行的控件是「有副作用的操作」（需要演示模式遮罩）时置 true。
   *
   * 用参数而不是让调用方自己包 `<DemoAction>`：遮罩必须与行的右栏宽度绑定
   * （`w-full sm:w-auto`），调用方自己包极容易漏掉宽度而让按钮在窄屏溢出。
   */
  operational?: boolean;
  stacked?: boolean;
}

/** 设置字段行：左标签（可带说明）+ 右控件。 */
export function SettingsFieldRow({
  label,
  description,
  htmlFor,
  children,
  className,
  operational = false,
  stacked = false,
}: SettingsFieldRowProps) {
  return (
    <SettingsRow
      className={cn(
        "flex-col items-stretch gap-2",
        !stacked && "sm:flex-row sm:items-center",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-[12.5px] font-[550] leading-4">
            {label}
          </Label>
        ) : (
          <div className="text-[12.5px] font-[550] leading-4">{label}</div>
        )}
        {description && (
          <p className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground">{description}</p>
        )}
      </div>
      <div className={cn("flex min-w-0 shrink-0 justify-end", stacked ? "w-full" : "w-full sm:w-auto")}>
        {operational ? (
          <DemoAction className={stacked ? "w-full" : "w-full sm:w-auto"}>{children as ReactElement}</DemoAction>
        ) : (
          children
        )}
      </div>
    </SettingsRow>
  );
}
