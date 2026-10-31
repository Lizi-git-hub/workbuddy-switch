
import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

/** 根容器。`shouldFilter={false}` 时由调用方自行过滤（面板要复用 `account-search`）。 */
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** 搜索输入框（带左侧放大镜）。 */
function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      /* 对齐原型 `.palette-input`（`buddy-switch-prototype.html:476`）：内边距 14/16、gap 10、底边。 */
      className="flex items-center gap-2.5 border-b border-border px-4 py-3.5"
      data-slot="command-input-wrapper"
    >
      <Search className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          /* 原型 `.palette-input input`（`:478`）：字号 14（= `text-sm`）。 */
          "flex h-6 w-full bg-transparent p-0 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/** 可滚动的结果列表。 */
function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      /* 原型 `.palette-list`（`:480`）：内边距 6px。 */
      className={cn("max-h-[360px] overflow-x-hidden overflow-y-auto p-1.5", className)}
      {...props}
    />
  );
}

/** 分组（标题由 cmdk 的 `heading` 渲染）。 */
function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground",
        /* 分组标题对齐原型 `.palette-grp`（`:481`）：内边距 8/10/4、字号 10.5px、字重 500。 */
        "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** 可选项。选中态用 `data-[selected=true]`（cmdk 管理）。 */
function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      /* 对齐原型 `.palette-item`（`:482-484`）：内边距 9/10、圆角 **10px**（不是比例尺的 12px）、gap 10。 */
      className={cn(
        "relative flex cursor-default select-none items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-sm outline-none",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Command, CommandInput, CommandList, CommandGroup, CommandItem };
