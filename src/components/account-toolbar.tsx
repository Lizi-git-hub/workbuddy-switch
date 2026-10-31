import type { Ref } from "react";
import { LayoutGrid, Plus, Search, Table2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DemoAction } from "@/components/demo-action";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AccountViewMode } from "@/lib/account-list-view";
import { useT } from "@/lib/i18n";

export interface ToolbarOption<V extends string = string> {
  value: V;
  /** 已 i18n。 */
  label: string;
}

export interface AccountToolbarProps {
  /** 搜索（受控）。 */
  query: string;
  onQueryChange: (next: string) => void;
  /** 搜索框 ref（`/` 快捷键聚焦；由页面持有并聚焦）。 */
  searchInputRef?: Ref<HTMLInputElement>;

  /** 排序（受控；值集由 `sortOptions` 定义）。 */
  sort: string;
  sortOptions: ToolbarOption[];
  onSortChange: (next: string) => void;

  /** 分组（受控；**分桶**，与「分组筛选」不同）。 */
  group: string;
  groupOptions: ToolbarOption[];
  onGroupChange: (next: string) => void;

  /** 视图（受控）。 */
  view: AccountViewMode;
  onViewChange: (next: AccountViewMode) => void;
  /** 表格视图是否可用（< 900px 强制卡片 ⇒ false ⇒ 禁用表格按钮并给原因）。 */
  tableViewEnabled?: boolean;

  /** 全选控制（列表支持勾选时传入）。 */
  selection?: {
    allSelected: boolean;
    someSelected: boolean;
    onToggleAll: () => void;
    /** 已 i18n：「全选」/「取消全选」。 */
    label: string;
  };

  /**
   * 工具栏右侧的**主操作**（如「+ 添加账号」，原型 `viewAccounts` :2428）。
   *
   * 由页面注入**同一个**既有入口（两平台都接「添加账号」抽屉），壳内不含任何平台 / 业务逻辑。
   * 不传 = 不渲染该按钮。
   */
  addAction?: { label: string; onClick: () => void } | null;

  onOpenRecycleBin?: () => void;
}

export function AccountToolbar({
  query,
  onQueryChange,
  searchInputRef,
  sort,
  sortOptions,
  onSortChange,
  group,
  groupOptions,
  onGroupChange,
  view,
  onViewChange,
  tableViewEnabled = true,
  selection,
  addAction,
  onOpenRecycleBin,
}: AccountToolbarProps) {
  const t = useT();

  return (
    <TooltipProvider delayDuration={400}>
      <div className="mb-3.5 flex flex-wrap items-center gap-2 rounded-[12px] border border-border bg-card px-3 py-2.5">
        {/* ★ 搜索框常驻：**不**放进任何条件分支（IME 约束，见文件头）。
            结构与原型 `label.field.search`（`demo.css:280-292`）一致：
            图标与输入**同处一个 32px 高的字段**里（`gap:6px` + `padding:0 10px`），
            不是「把图标绝对定位、再给输入框留 `pl-8`」——后者左内边距是 32px，
            比原型的 10+14+6=30px 多 2px，且图标与文字不在同一条基线上。 */}
        <label className="flex h-8 min-w-[180px] flex-1 items-center gap-1.5 rounded-[9px] border border-border bg-card-2 px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("shared.toolbar.searchPlaceholder")}
            aria-label={t("shared.toolbar.searchAria")}
            autoComplete="off"
            spellCheck={false}
            className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-[12.5px] text-foreground shadow-none focus-visible:ring-0"
          />
        </label>

        {/* 排序（分桶的前置：先排后分，桶内顺序才稳定）。
            原型 `label.field` 里**先写「排序」再跟下拉**（不是只有一枚下拉）。 */}
        <div className="flex h-8 items-center gap-1.5 rounded-[9px] border border-border bg-card-2 px-2.5 text-[12.5px] text-muted-foreground">
          <span className="shrink-0">{t("shared.toolbar.sort")}</span>
          <Select value={sort} onValueChange={onSortChange}>
            <SelectTrigger
              size="sm"
              className="h-auto w-auto min-w-[83px] gap-0 border-0 bg-transparent px-0 py-0 text-[12.5px] shadow-none focus-visible:ring-0"
              aria-label={t("shared.toolbar.sortAria")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 分组（**分桶**：none / program / status / group）。 */}
        <div className="flex h-8 items-center gap-1.5 rounded-[9px] border border-border bg-card-2 px-2.5 text-[12.5px] text-muted-foreground">
          <span className="shrink-0">{t("shared.toolbar.group")}</span>
          <Select value={group} onValueChange={onGroupChange}>
            <SelectTrigger
              size="sm"
              className="h-auto w-auto min-w-[83px] gap-0 border-0 bg-transparent px-0 py-0 text-[12.5px] shadow-none focus-visible:ring-0"
              aria-label={t("shared.toolbar.groupAria")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groupOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 视图切换：**纯图标**。原型 `.seg button` 里只有 `ICON.grid` / `ICON.list`，
            没有文字（`buddy-switch-prototype.html:2421-2424`）—— 文字改由
            `title` / `aria-label` 承担，按钮因此从 62px 收到 38px。
            窄窗下表格按钮**禁用并说明原因**（不是隐藏）。 */}
        <div
          role="group"
          aria-label={t("shared.toolbar.viewAria")}
          className="inline-flex items-center gap-0.5 rounded-[10px] bg-muted p-0.5"
        >
          <Button
            type="button"
            variant={view === "card" ? "secondary" : "ghost"}
            size="sm"
            className="h-[26px] rounded-[8px] has-[>svg]:px-[11px] data-[on=true]:bg-card data-[on=true]:font-[550] data-[on=true]:shadow-sm"
            aria-pressed={view === "card"}
            aria-label={t("shared.toolbar.viewCard")}
            title={t("shared.toolbar.viewCard")}
            data-on={view === "card"}
            onClick={() => onViewChange("card")}
          >
            <LayoutGrid className="size-4" />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  variant={view === "table" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-[26px] rounded-[8px] has-[>svg]:px-[11px] data-[on=true]:bg-card data-[on=true]:font-[550] data-[on=true]:shadow-sm"
                  aria-pressed={view === "table"}
                  aria-label={t("shared.toolbar.viewTable")}
                  title={t("shared.toolbar.viewTable")}
                  data-on={view === "table"}
                  disabled={!tableViewEnabled}
                  onClick={() => onViewChange("table")}
                >
                  <Table2 className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            {!tableViewEnabled && (
              <TooltipContent side="top">{t("shared.toolbar.viewTableDisabled")}</TooltipContent>
            )}
          </Tooltip>
        </div>

        {/* ★ 回收站—— 用户要求「回收站放出来」⇒ 常驻工具栏（P5 §2.7.1）。
            按**当前作用域**过滤（只列本作用域被软删除的账号）；入口放账号页而非设置页，
            避免与 P7「备份与恢复」的整库级语义混淆。 */}
        {onOpenRecycleBin ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <DemoAction>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-[34px] rounded-lg"
                    onClick={onOpenRecycleBin}
                    aria-label={t("recycleBin.title")}
                  >
                    <Trash2 />
                  </Button>
                </DemoAction>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{t("recycleBin.title")}</TooltipContent>
          </Tooltip>
        ) : null}

        {/* ★ `grow` 把右侧分组推到行尾（原型 `<div class="grow">` `:2425`）。
            ⚠️ 有了它，主操作**不再**需要 `ml-auto` —— 两个都写会让自由空间被分两半。 */}
        <div className="grow" />

        {/* 全选：原型是**一枚 ghost 文字按钮**（`btn ghost sm`，`:2426`），
            不是「勾选框 + 文字」。勾选框仍保留在表格表头（`.check.mixed`）。 */}
        {selection ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="border border-transparent"
            aria-pressed={selection.allSelected}
            onClick={() => selection.onToggleAll()}
          >
            {selection.label}
          </Button>
        ) : null}

        {/* ★ 主操作（原型 `viewAccounts` :2428：工具栏行最右侧的 `.btn.primary`）。
            与「添加与迁移账号」横幅的入口**同一动作**，不重复一套流程。
            尺寸用 `size="default"`（高 34 / 圆角 10 / 字号 12.5 = 原型 `.btn`），
            内边距补回 `13px`：`Button` 基础样式对「带图标」会收到 11px，而原型 `.btn`
            没有 `has(svg)` 规则、恒为 13px。 */}
        {addAction ? (
          <DemoAction>
            <Button
              type="button"
              className="has-[>svg]:px-[13px]"
              onClick={addAction.onClick}
            >
              <Plus className="size-4" />
              {addAction.label}
            </Button>
          </DemoAction>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
