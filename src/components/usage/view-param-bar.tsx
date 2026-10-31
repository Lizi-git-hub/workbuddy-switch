
import { useState } from "react";

import { RegionBar } from "@/components/region-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Seg } from "@/components/ui/seg";
import { useT } from "@/lib/i18n";
import { LEDGER_VALUES, type UsageLedger } from "@/lib/usage-ledger";
import {
  shortDateLabel,
  usageCustomRangeLabel,
  usageWindowBounds,
  usageWindowEarliestKey,
  usageWindowFromMode,
  usageWindowKey,
  usageWindowMode,
  USAGE_WINDOW_MODES,
  todayKey,
  type UsageWindow,
  type UsageWindowMode,
} from "@/lib/usage-window";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/zh";

/** 档位 → 词条。**写死成表**（不用模板串拼键名）：拼出来的键 `tsc` 查不出，
 *  改词条名时会静默回落中文。 */
const MODE_LABEL: Record<UsageWindowMode, TranslationKey> = {
  today: "wbStats.usage.range.today",
  week: "wbStats.usage.range.week",
  lastWeek: "wbStats.usage.range.lastWeek",
  month: "wbStats.usage.range.month",
  lastMonth: "wbStats.usage.range.lastMonth",
  half: "wbStats.usage.range.half",
  year: "wbStats.usage.range.year",
  custom: "wbStats.usage.param.custom",
};

/** 账本三态 → 词条（写死成表：拼出来的键 `tsc` 查不出）。 */
const LEDGER_LABEL: Record<UsageLedger, TranslationKey> = {
  all: "wbStats.usage.ledger.all",
  client: "wbStats.usage.ledger.client",
  gateway: "wbStats.usage.ledger.gateway",
};

export interface ViewParamBarProps {
  /**
   * ⚠️ 刻意**不叫 `window`**：那会在组件作用域里屏蔽全局 `window`
   * （`localStorage` / 事件 / 未来任何一处 `window.*` 都会静默指向这个对象，
   * 且 `tsc` 不会报错）。四个视图页的 props 同名同形。
   */
  viewWindow: UsageWindow;
  onViewWindowChange: (next: UsageWindow) => void;
  /** 合并态（仅本作用域 / 合并全部作用域）—— 两平台同一枚控件。 */
  combineAll: boolean;
  onCombineAllChange: (next: boolean) => void;
  canMergeScopes?: boolean;
  ledger?: UsageLedger;
  onLedgerChange?: (next: UsageLedger) => void;
  canSwitchLedger?: boolean;
  /**
   * 哪些账本档**在本平台可得**（缺省三档全给）。
   *
   * Trae 传 `["gateway"]`：它没有可解析的客户端用量落盘（IDE 私有加密存储），
   * 「客户端」那一本账在**数据层就不存在**。于是：
   * - 不给「客户端」档 —— 选了它只能显示 0，那是把「没测到」说成「没用」；
   * - 也不给「全部」档 —— 全部 = 客户端 ∪ 网关 = 网关，与「网关」逐值相同，
   *   两档并存就是一枚点了没反应的死控件。
   * 理由文案由视图页在覆盖条/说明条里写（见 `TraeTokenStatsPage` 的账本说明）。
   */
  ledgerValues?: readonly UsageLedger[];
  className?: string;
}

/**
 * 四个视图页共用的**受控视图参数** —— 由 `UsagePage` 统一持有并传下去。
 *
 * ⚠️ 这是「用量」页的**视图参数契约**：谁要读窗口 / 合并态就从 props 拿，
 * **不许**在视图页里再 `useState` 一份（那就又变成四条参数条）。
 * `onViewWindowChange` 是留给视图内部的**出口**（例：趋势视图「被视图参数筛没」时
 * 给一枚「看近 30 天」按钮）—— 它改的仍是**页面级**那一个 `viewWindow`。
 */
export interface UsageViewProps {
  viewWindow: UsageWindow;
  combineAll: boolean;
  onViewWindowChange: (next: UsageWindow) => void;
}

/**
 * 窗口的展示文案：固定档走词条，自定义走区间（`9/20 – 9/25`）。
 *
 * 放在**参数条文件**里而不是各页各写一份：两个视图页都要显示同一个窗口名，
 * 各写一份必然在「自定义怎么显示」上分叉（一个显示区间、一个显示「自定义」）。
 */
export function useUsageWindowLabel(): (target: UsageWindow) => string {
  const t = useT();
  return (target: UsageWindow) => {
    /* 先按 `kind` 收窄，再取词条 —— 不能靠「`custom` 一定返回 null」来倒推，
       `tsc` 不会因此把 `window` 收窄成自定义那一支。 */
    if (target.kind === "custom") return usageCustomRangeLabel(target);
    const key = usageWindowKey(target);
    return key ? t(key) : "";
  };
}

export function ViewParamBar({
  viewWindow,
  onViewWindowChange,
  combineAll,
  onCombineAllChange,
  canMergeScopes = true,
  ledger = "all",
  onLedgerChange,
  canSwitchLedger = false,
  ledgerValues = LEDGER_VALUES,
  className,
}: ViewParamBarProps) {
  const t = useT();
  const mode = usageWindowMode(viewWindow);

  /**
   * 自定义弹层。
   *
   * `draft` 是**草稿**：输入框只改它，**只有「应用」才回写** `viewWindow`。
   * 边滚日期边改图会让用户分不清「我在选」还是「已生效」；
   * 取消 / Esc / 点外部一律丢弃草稿（Radix 关浮层时同步 `open=false`）。
   */
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ from: string; to: string }>(() =>
    usageWindowBounds(viewWindow),
  );

  const earliest = usageWindowEarliestKey();
  const latest = todayKey();
  const bounds = usageWindowBounds(viewWindow);

  /** 打开弹层：草稿从**当前窗口**起步（用户从「我看到的那段」开始调，而不是从空白开始）。 */
  const openCustom = () => {
    setDraft(usageWindowBounds(viewWindow));
    setOpen(true);
  };

  const handleMode = (next: UsageWindowMode) => {
    /* ⚠️ `custom` 不是「一按就生效」的档位（它要选日期）⇒ 拦在这里开弹层，
       不改 `viewWindow`。这也是 `usageWindowFromMode` 的 `custom` 分支不会被走到的原因。 */
    if (next === "custom") {
      openCustom();
      return;
    }
    setOpen(false);
    onViewWindowChange(usageWindowFromMode(next, viewWindow));
  };

  const applyCustom = () => {
    if (!draft.from || !draft.to) return;
    onViewWindowChange({ kind: "custom", from: draft.from, to: draft.to });
    setOpen(false);
  };

  /** 起止任一侧为空 ⇒ 主操作禁用（与 S4a 抽屉「无选中不给出口」同一取舍）。 */
  const customIncomplete = !draft.from || !draft.to;

  return (
    <div
      className={cn(
        "mb-3.5 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-[10px]",
        className,
      )}
    >
      <span className="text-[11px] text-muted-foreground">{t("wbStats.usage.param.title")}</span>
      {/* 弹层锚在**整条 `.seg`** 上（对齐它的左缘），不是锚在「自定义时间」那一枚 ——
          后者会让弹层随档位横移，同一个控件每次出现在不同位置。 */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor className="shrink-0">
          <Seg
            value={mode}
            onChange={handleMode}
            ariaLabel={t("wbStats.usage.param.aria")}
            options={USAGE_WINDOW_MODES.map((value) => ({ value, label: t(MODE_LABEL[value]) }))}
            popup={{ value: "custom", expanded: open }}
          />
        </PopoverAnchor>
        <PopoverContent align="start" className="w-[320px] p-3">
          <p className="mb-2 text-[10.5px] font-medium text-muted-foreground">
            {t("wbStats.usage.param.custom.title")}
          </p>
          <div className="flex items-center gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
              {t("wbStats.usage.param.custom.from")}
              <Input
                type="date"
                className="bg-card-2"
                value={draft.from}
                min={earliest}
                max={latest}
                onChange={(event) => setDraft((prev) => ({ ...prev, from: event.target.value }))}
              />
            </label>
            <span className="pt-[18px] text-muted-foreground">–</span>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
              {t("wbStats.usage.param.custom.to")}
              <Input
                type="date"
                className="bg-card-2"
                value={draft.to}
                min={earliest}
                max={latest}
                onChange={(event) => setDraft((prev) => ({ ...prev, to: event.target.value }))}
              />
            </label>
          </div>
          <p className="mt-2 text-[10.5px] text-muted-foreground">
            {customIncomplete
              ? t("wbStats.usage.param.custom.incomplete")
              : t("wbStats.usage.param.custom.hint", {
                  from: shortDateLabel(earliest),
                  to: shortDateLabel(latest),
                })}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("wbStats.usage.param.custom.cancel")}
            </Button>
            <Button size="sm" onClick={applyCustom} disabled={customIncomplete}>
              {t("wbStats.usage.param.custom.apply")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {/* 当前窗口的**可见回执**：档位按钮只说「哪一档」，这里说「具体哪几天」——
          自定义尤其需要，否则用户看不出生效的是哪一段。 */}
      {mode === "custom" && (
        <span className="text-[11px] text-muted-foreground">
          {usageCustomRangeLabel({ kind: "custom", from: bounds.from, to: bounds.to })}
        </span>
      )}
      {canSwitchLedger && onLedgerChange ? (
        <>
          {/* 原型 `.vsep`（`demo.css:1363`：`width:1px; height:20px; background:var(--border)`）：
              「时间范围」与「账本」中间那道竖线。两组控件语义不同 —— 前者选**看多长时间**，
              后者选**看哪本账**；不隔开时它们在同一个胶囊条里连成一片，读起来像一个六档控件。 */}
          <span className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
          <span className="text-[11px] text-muted-foreground">{t("wbStats.usage.ledger")}</span>
          {/* `tone="book"` = 原型 `.seg.book`：选中态青绿 18% 底 + `primary` 文字。
              账本切换改变整页数字的数据源，比「换一档时间范围」重 —— 必须一眼看得出。 */}
          <Seg
            tone="book"
            value={ledger}
            onChange={onLedgerChange}
            ariaLabel={t("wbStats.usage.ledger.aria")}
            options={ledgerValues.map((value) => ({ value, label: t(LEDGER_LABEL[value]) }))}
          />
        </>
      ) : null}
      <div className="grow" />
      {/* ⚠️ `canMergeScopes === false` 时**不渲染**：Qoder 只有一个区域的数据源，
          渲染那枚控件等于给用户一个点了没反应的开关。 */}
      {canMergeScopes ? <RegionBar value={combineAll} onChange={onCombineAllChange} /> : null}
    </div>
  );
}
