
import { useCallback, useState, type FocusEvent } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CompanionItem, CompanionState } from "@/lib/companion";
import { displayText } from "@/lib/display-text";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/zh";

/**
 * 未悬停 / 未聚焦时渲染的占位符 —— 完整标题**根本不进 DOM**（P9 ✅ #3）。
 *
 * 固定长度的圆点：既不随标题长度变化（不泄露长度），也一眼看出「这里被遮住了」。
 */
export const COMPANION_TITLE_PLACEHOLDER = "••••••••";

export const COMPANION_STATE_DOT_CLASS: Record<CompanionState, string> = {
  running: "bg-primary animate-pulse motion-reduce:animate-none",
  waiting: "bg-warning",
  done: "bg-success",
  failed: "bg-destructive",
};

/** 四态 → 状态文案键（与后端 `CompanionState` 的 lowercase 序列化一一对应）。 */
const STATE_LABEL_KEY: Record<CompanionState, TranslationKey> = {
  running: "shared.companion.state.running",
  waiting: "shared.companion.state.waiting",
  done: "shared.companion.state.done",
  failed: "shared.companion.state.failed",
};

const SOURCE_LABEL_KEY: Record<string, TranslationKey> = {
  "workbuddy-cn": "shared.companion.source.workbuddyCn",
  "workbuddy-global": "shared.companion.source.workbuddyGlobal",
  claude: "shared.companion.source.claude",
  codebuddy: "shared.companion.source.codebuddy",
  codex: "shared.companion.source.codex",
  "trae-cn": "shared.companion.source.traeCn",
  "trae-global": "shared.companion.source.traeGlobal",
  "qoder-cn": "shared.companion.source.qoderCn",
  "qoder-global": "shared.companion.source.qoderGlobal",
  // 本工具自己的操作（`agent_watch::SOURCE_THIS_TOOL`）—— 不是客户端 hook 来源。
  "buddy-switch": "shared.companion.source.thisTool",
};

/** `CompanionRow` 的入参。 */
export interface CompanionRowProps {
  /** 只读行数据（来自 `companion_status` 快照）。 */
  item: CompanionItem;
  /** 点击行 → 聚焦来源客户端（P9 ✅ #1）。**不切账号、不改数据**。 */
  onJump: (id: string) => void;
}

export function CompanionRow({ item, onJump }: CompanionRowProps) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);

  const sourceLabelKey = SOURCE_LABEL_KEY[item.source];
  const source = sourceLabelKey ? t(sourceLabelKey) : (displayText(item.source) ?? "");
  const hint = displayText(item.hint) ?? "";
  // fail-closed：脏数据里出现四态之外的值时，按 `failed` 呈现（不静默、不崩）。
  const dotClass = COMPANION_STATE_DOT_CLASS[item.state] ?? COMPANION_STATE_DOT_CLASS.failed;
  const stateLabel = t(STATE_LABEL_KEY[item.state] ?? STATE_LABEL_KEY.failed);

  const title = revealed
    ? displayText(item.title) || t("shared.companion.untitled")
    : COMPANION_TITLE_PLACEHOLDER;
  const ariaLabel = t("shared.companion.row.aria", { source, state: stateLabel, hint });

  // `:focus-visible` 判定：**键盘**聚焦才展开，程序化 / 鼠标聚焦不展开
  //（否则窗口一打开就自动聚焦首行，会把标题直接泄露出去 —— 与 ✅ #3 冲突）。
  const handleFocus = useCallback((event: FocusEvent<HTMLButtonElement>) => {
    if (event.currentTarget.matches(":focus-visible")) setRevealed(true);
  }, []);

  return (
    // 受控 Tooltip：`open` 完全由本组件的 `revealed` 驱动（**不接 Radix 的 focus-open**），
    // 这样「程序化聚焦不展开」这条隐私纪律不会被 Radix 的默认行为破坏。
    <Tooltip open={revealed}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onJump(item.id)}
          onMouseEnter={() => setRevealed(true)}
          onMouseLeave={() => setRevealed(false)}
          onFocus={handleFocus}
          onBlur={() => setRevealed(false)}
          aria-label={ariaLabel}
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", dotClass)} />
          <span className="shrink-0 truncate text-xs text-muted-foreground">{source}</span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              revealed ? "text-foreground" : "tracking-[0.2em] text-muted-foreground/70",
            )}
          >
            {title}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{hint}</span>
        </button>
      </TooltipTrigger>
      {/* 信息卡（P9 §1.6）：完整标题 + 来源 + 时间。内容随 `revealed` 求值，
          故**关闭动画期间也不会残留明文**（`title` 已回落为占位符）。 */}
      <TooltipContent side="top" align="start" className="max-w-[16rem] space-y-0.5">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-muted-foreground">
          {t("shared.companion.info.source")} · {source}
        </div>
        <div className="text-muted-foreground">
          {t("shared.companion.info.time")} · {hint}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
