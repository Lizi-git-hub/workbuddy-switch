
import { cn } from "@/lib/utils";

export interface SegOption<T extends string | number> {
  value: T;
  label: string;
}

export interface SegProps<T extends string | number> {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegOption<T>[];
  /** 无障碍分组名（读屏会先念它，再念每一档）。 */
  ariaLabel: string;
  disabled?: boolean;
  /**
   * 某一档**不是「直接取值」而是「打开浮层」**时，给它补上 `aria-haspopup` / `aria-expanded`。
   *
   * 目前只有一档需要（用量页的「自定义时间」——它开一个日期弹层）。
   * ⚠️ 刻意**不做成 ReactNode 插槽**：插槽会让调用点自己写按钮类名，
   * 而那正是本原语要消灭的漂移（同一个 `.seg` 里两枚按钮长得不一样）。
   * 少了这两个属性，读屏用户听到的只是一枚普通按钮 —— 不知道它会开浮层、也不知道开没开。
   */
  popup?: { value: T; expanded: boolean };
  /**
   * 色调。缺省 = 原型 `.seg`（选中 `bg-card` + `foreground`）。
   *
   * `book` 专给用量页的「账本」那枚（原型 `.seg.book`，`demo.css:1362`）：
   * 选中态是 `primary 18%` 底 + `primary` 文字 —— 「换了一本账」比「换了一档」重得多，
   * 必须在控件本身上看得出来（深色下 `card` 与 `muted` 同值，默认色调只剩字重差异）。
   */
  tone?: "default" | "book";
  className?: string;
}

export function Seg<T extends string | number>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  popup,
  tone = "default",
  className,
}: SegProps<T>) {
  return (
    <div
      className={cn(
        "inline-flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5",
        disabled && "opacity-60",
        className,
      )}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const isPopup = popup !== undefined && option.value === popup.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            className={cn(
              "h-[26px] cursor-pointer rounded-sm px-[11px] text-xs transition-colors",
              /* 原型 `.seg button.on` 的三个共有项：550 字重 + `card` 底 + `shadow-sm`；
                 `.seg.book button.on` 只改**底色与文字色**，前两项仍保留（CSS 层叠如此）。 */
              value === option.value
                ? cn(
                    "font-[550] shadow-sm",
                    tone === "book"
                      ? "bg-primary/18 text-primary"
                      : "bg-card text-foreground",
                  )
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed",
            )}
            onClick={() => onChange(option.value)}
            disabled={disabled}
            aria-haspopup={isPopup ? "dialog" : undefined}
            aria-expanded={isPopup ? popup.expanded : undefined}
            aria-pressed={value === option.value}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
