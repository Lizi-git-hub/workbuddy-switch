import type { ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { shouldOpenAccountDetail } from "@/lib/account-open-guard";
import { cn } from "@/lib/utils";

export interface AccountColumn<T> {
  key: string;
  /** 已 i18n。 */
  header: string;
  align?: "left" | "right";
  /** 列宽（CSS 值，可选）。 */
  width?: string;
  render: (row: T) => ReactNode;
}

export interface AccountTableProps<T> {
  columns: AccountColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** 勾选态（键控，与批量条 / 工具栏全选共用）。 */
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (row: T) => void;
  /** 表头全选。 */
  onToggleAll: (checked: boolean) => void;
  allSelected: boolean;
  someSelected: boolean;
  /** 点行打开详情。 */
  onOpen: (row: T) => void;
  /** 行是否「当前登录」（高亮）。 */
  isCurrent?: (row: T) => boolean;
  /** 无障碍标签（全选 / 选择某行 / 打开某行详情）。 */
  selectAllLabel: string;
  selectRowLabel: (row: T) => string;
  openRowLabel: (row: T) => string;
  /**
   * 行尾「更多」按钮（已归一节点）。
   *
   * ⚠️ 由调用方注入**与卡片同一个菜单组件**（`account-more-menu.tsx`）——
   * 表格与卡片列的是同一批账号、同一批动作，两处各写一遍必然漂移。
   * 不传 ⇒ 不渲染该列（网关等无账号动作的表格不受影响）。
   */
  renderActions?: (row: T) => ReactNode;
}

export function AccountTable<T>({
  columns,
  rows,
  rowKey,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  allSelected,
  someSelected,
  onOpen,
  isCurrent,
  selectAllLabel,
  selectRowLabel,
  openRowLabel,
  renderActions,
}: AccountTableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-[12px] border border-border bg-card">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th scope="col" className="sticky top-0 z-[1] w-10 whitespace-nowrap bg-card-2 px-3 py-2.5 text-left text-[11.5px] font-medium">
              <Checkbox
                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                onCheckedChange={(checked) => onToggleAll(checked === true)}
                aria-label={selectAllLabel}
              />
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cn("sticky top-0 z-[1] bg-card-2 px-3 py-2.5 text-[11.5px] font-medium", column.align === "right" ? "text-right" : "text-left")}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const selected = selectedIds.has(key);
            return (
              <tr
                key={key}
                tabIndex={0}
                aria-label={openRowLabel(row)}
                onClick={(event) => {
                  if (!shouldOpenAccountDetail(event, "[data-row-actions]")) return;
                  onOpen(row);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onOpen(row);
                }}
                className={cn(
                  "cursor-pointer border-b border-border/60 last:border-0 hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none",
                  isCurrent?.(row) && "bg-primary/[0.07]",
                )}
              >
                {/* 可点区 1：勾选框（阻止冒泡，避免顺带打开详情）。 */}
                <td className="px-3 py-2.5 align-middle text-[11px]" onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={selected}
                    onCheckedChange={() => onToggleSelect(row)}
                    aria-label={selectRowLabel(row)}
                  />
                </td>
                {/* 可点区 2：行本身（在上面的 <tr onClick>）。程序位列由列定义渲染成只读徽标。 */}
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn("px-3 py-2.5 align-middle text-[11px]", column.align === "right" ? "text-right" : "text-left")}
                  >
                    {column.render(row)}
                  </td>
                ))}
                {/* 行尾动作：标记 `data-row-actions`，由上面的行 onClick 识别（见那里的注释）。 */}
                {renderActions ? (
                  <td data-row-actions className="w-10 px-2 py-1.5 text-right align-middle">
                    {renderActions(row)}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
