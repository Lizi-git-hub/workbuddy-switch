/**
 * 日历热力图 —— **固定最近一年**，52 周式网格（GitHub 贡献图布局）。
 *
 * ## 为什么砍掉筛选、固定一年
 *
 * 试过三版：跟随页面参数条（30 天只有 5 列）、可切 30 天 / 本月 / 一年
 * （「自适应列宽」让 30 天档的格子膨胀成 200px 的大方块）。问题的根子是
 * **列数和容器宽度不成比例**：列少格子就大，怎么调都不像贡献图。
 *
 * 而插件原图好看的原因恰恰是**固定一年**：53 列摊在容器上，列宽天然落在
 * 13 ~ 16px，格子小而密，颜色密度才是主角。所以这版砍掉全部筛选，
 * 只画最近一年 —— 这是它唯一正确的形态。
 *
 * 色阶沿用插件的分位数规则（活跃日的 25 / 50 / 90 分位，5 档蓝）。
 */

import { useMemo } from "react";

import type { TokenStatsGroup } from "@/lib/types";
import { compactShare } from "./format";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地日期键 `YYYY-MM-DD`。 */
function dateKeyOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 本地星期索引（0 = 周一）。 */
function mondayIndex(dateKey: string): number {
  const time = new Date(`${dateKey}T00:00:00`).getTime();
  if (!Number.isFinite(time)) return 0;
  return (new Date(time).getDay() + 6) % 7;
}

/** 5 档底色：`index.css` 里三套主题各定义一份 `--heat-0..4` ——
 *  早先用 `bg-muted/70` + `bg-primary/18`，深色 / 纯黑下空格与低档几乎不可见。 */
const HEAT_COLOR = [
  "var(--heat-0)",
  "var(--heat-1)",
  "var(--heat-2)",
  "var(--heat-3)",
  "var(--heat-4)",
] as const;

const WEEKDAY_LABELS = ["一", "三", "五", "日"];

export function CalendarHeatmap({ daily }: { daily: TokenStatsGroup[] }) {
  const weeks = useMemo(() => {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end.getTime() - 364 * DAY_MS);
    const keys: string[] = [];
    for (let time = start.getTime(); time <= end.getTime(); time += DAY_MS) {
      keys.push(dateKeyOf(new Date(time)));
    }
    const tokensByDay = new Map(daily.map((day) => [day.key, day.total]));
    const values = keys.map((key) => ({ key, tokens: tokensByDay.get(key) ?? 0 }));

    // 按周显式分列：第一列前面补齐首日的星期偏移，尾部补齐整列。
    const lead = mondayIndex(values[0]?.key ?? keys[0]);
    const cells: ({ key: string; tokens: number } | null)[] = [
      ...Array.from({ length: lead }, () => null),
      ...values,
    ];
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks: ({ key: string; tokens: number } | null)[][] = [];
    for (let index = 0; index < cells.length; index += 7) {
      weeks.push(cells.slice(index, index + 7));
    }
    return weeks;
  }, [daily]);

  /** 分位数阈值：只统计活跃日（>0），空日不参与 —— 否则阈值被 0 拉爆。 */
  const levels = useMemo(() => {
    const active = daily
      .filter((day) => day.total > 0)
      .map((day) => day.total)
      .sort((a, b) => a - b);
    const at = (ratio: number): number =>
      active.length === 0
        ? 0
        : active[Math.min(active.length - 1, Math.floor(active.length * ratio))] ?? 0;
    return { t1: at(0.25), t2: at(0.5), t3: at(0.9) };
  }, [daily]);

  const shadeOf = (tokens: number): number => {
    if (tokens <= 0) return 0;
    if (tokens <= levels.t1) return 1;
    if (tokens <= levels.t2) return 2;
    if (tokens <= levels.t3) return 3;
    return 4;
  };

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
        <span>一年前</span>
        {HEAT_COLOR.map((color, level) => (
          <span key={level} className="h-[10px] w-[10px] rounded-[2px]" style={{ background: color }} />
        ))}
        <span>今天</span>
      </div>

      {/* 自适应：列宽 = 容器宽 / 53 列（minmax(0,1fr)），格子 aspect-square。
          固定一年列数够多，列宽自然落在 13~16px —— 贡献图的标准密度。 */}
      <div className="flex w-full gap-1.5">
        <div className="flex shrink-0 flex-col gap-[3px] text-[10px] leading-none text-muted-foreground">
          {WEEKDAY_LABELS.map((label) => (
            <span key={label} className="flex h-[13px] items-center">
              {label}
            </span>
          ))}
        </div>
        <div
          className="grid min-w-0 flex-1 gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}
        >
          {weeks.map((week, colIndex) => (
            <div key={colIndex} className="flex min-w-0 flex-col gap-[3px]">
              {week.map((cell, rowIndex) =>
                cell === null ? (
                  <span key={`pad-${colIndex}-${rowIndex}`} className="aspect-square w-full bg-transparent" />
                ) : (
                  <span
                    key={cell.key}
                    title={`${cell.key} · ${cell.tokens > 0 ? compactShare(cell.tokens) : "无用量"}`}
                    className="aspect-square w-full rounded-[2px]"
                    style={{ background: HEAT_COLOR[shadeOf(cell.tokens)] }}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
