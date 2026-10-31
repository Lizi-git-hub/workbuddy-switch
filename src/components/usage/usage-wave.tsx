/**
 * 「波浪图」—— 移植自 `dsh-local-usage-rebuild` 的 `WaveChart` + `wave.ts`，
 * 取其**手绘 SVG** 的核心：中点平滑曲线 + 渐变面积 + 垂线刻度，不再依赖
 * recharts 的默认网格与图例。
 *
 * 与插件的两处不同：
 * 1. 插件画的是「花费」，这里画 **token 用量**（费用换算在指标条已有大数）；
 * 2. 插件的折叠粒度随范围切换（年 → 月、周 → 日），这里跟随参数条窗口，
 *    窗口 ≤ 31 天直接按天，更长按周折叠 —— 刻度最多 7 个，规则同插件。
 *
 * 平滑算法（`swellPath`）逐行来自插件：控制点取相邻两点的水平中点，
 * 让曲线「离开与到达都是平的」，几个采样点也能读成一道涌。
 */

import { useMemo } from "react";

import type { TokenStatsGroup } from "@/lib/types";
import { compactShare } from "./format";

/** 画布坐标（固定，缩放交给 viewBox）。 */
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 220;
/** 波峰上方留白（占高度的比例）。 */
const CREST = 0.88;
/** 轴上最多标几个点（插件的规则：固定步长，不做除法取整）。 */
const MAX_TICKS = 7;

interface WavePoint {
  label: string;
  value: number;
}

/** 相邻点的短标签是否属于同一桶（用于按周折叠时合并）。 */
function fold(daily: TokenStatsGroup[], zh: boolean): WavePoint[] {
  if (daily.length === 0) return [];
  // 桶距：> 31 天按 7 天一桶，否则按天。桶标签取桶内第一天。
  const bucketSize = daily.length > 31 ? 7 : 1;
  if (bucketSize === 1) {
    return daily.map((day) => {
      const [, month, date] = day.key.split("-");
      return { label: zh ? `${Number(month)}/${Number(date)}` : day.key.slice(5), value: day.total };
    });
  }
  const points: WavePoint[] = [];
  for (let index = 0; index < daily.length; index += bucketSize) {
    const bucket = daily.slice(index, index + bucketSize);
    const first = bucket[0];
    if (!first) continue;
    const [, month, date] = first.key.split("-");
    points.push({
      label: zh ? `${Number(month)}/${Number(date)}` : first.key.slice(5),
      value: bucket.reduce((sum, day) => sum + day.total, 0),
    });
  }
  return points;
}

/** 把值序列铺到画布坐标（x 归一，y 归一到峰值）。 */
function plot(points: readonly WavePoint[]): { x: number; y: number }[] {
  const max = points.reduce((best, point) => Math.max(best, point.value), 0);
  if (points.length === 0 || max <= 0) return [];
  const span = Math.max(points.length - 1, 1);
  return points.map((point, index) => ({
    x: index / span,
    y: point.value / max,
  }));
}

/** 中点平滑：控制点取水平中点，曲线离开与到达都是平的。 */
function swellPath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  const first = points[0];
  if (!first) return "";
  let path = `M ${(first.x * VIEW_WIDTH).toFixed(2)} ${((1 - first.y * CREST) * VIEW_HEIGHT).toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (!previous || !point) continue;
    const px = previous.x * VIEW_WIDTH;
    const py = (1 - previous.y * CREST) * VIEW_HEIGHT;
    const x = point.x * VIEW_WIDTH;
    const y = (1 - point.y * CREST) * VIEW_HEIGHT;
    const mid = (px + x) / 2;
    path += ` C ${mid.toFixed(2)} ${py.toFixed(2)}, ${mid.toFixed(2)} ${y.toFixed(2)}, ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return path;
}

export function UsageWave({ daily }: { daily: TokenStatsGroup[] }) {
  const zh = true;
  const points = useMemo(() => fold(daily, zh), [daily, zh]);
  const plotPoints = useMemo(() => plot(points), [points]);
  const line = swellPath(plotPoints);
  const area = line === "" ? "" : `${line} L ${VIEW_WIDTH} ${VIEW_HEIGHT} L 0 ${VIEW_HEIGHT} Z`;

  const peak = points.reduce((best, point) => Math.max(best, point.value), 0);
  const total = points.reduce((sum, point) => sum + point.value, 0);

  /** 固定步长取刻点（插件的规则：偶数分割会产生疏密交替的轴）。 */
  const ticks = useMemo(() => {
    if (points.length === 0) return [];
    const stride =
      [1, 2, 3, 4, 6, 12].find((step) => Math.ceil(points.length / step) <= MAX_TICKS) ??
      Math.ceil(points.length / MAX_TICKS);
    const chosen: { index: number; x: number; label: string; value: number }[] = [];
    for (let index = 0; index < points.length; index += stride) {
      const point = points[index];
      if (!point) continue;
      chosen.push({
        index,
        x: plotPoints[index]?.x ?? 0,
        label: point.label,
        value: point.value,
      });
    }
    return chosen;
  }, [points, plotPoints]);

  if (points.length === 0 || total <= 0) return null;

  return (
    <figure aria-label="用量波浪图" className="min-w-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">用量波浪</span>
        <span className="tabular-nums text-muted-foreground">
          峰值 <b className="font-medium text-foreground">{compactShare(peak)}</b>
        </span>
        <span className="tabular-nums font-medium text-foreground">{compactShare(total)}</span>
      </figcaption>

      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="用量波浪图"
        className="h-[180px] w-full"
      >
        <defs>
          <linearGradient id="usage-wave-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick.index}>
            <line
              x1={tick.x * VIEW_WIDTH}
              x2={tick.x * VIEW_WIDTH}
              y1={(1 - (plotPoints[tick.index]?.y ?? 0) * CREST) * VIEW_HEIGHT}
              y2={VIEW_HEIGHT}
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={tick.x * VIEW_WIDTH}
              cy={(1 - (plotPoints[tick.index]?.y ?? 0) * CREST) * VIEW_HEIGHT}
              r={2.6}
              fill="var(--primary)"
            />
          </g>
        ))}
        <path d={area} fill="url(#usage-wave-fill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* 轴标签：定位在与画点相同的宽度比例上，标签正对它命名的采样。 */}
      <div className="relative h-4">
        {ticks.map((tick) => (
          <span
            key={tick.index}
            className="absolute -translate-x-1/2 text-[10px] tabular-nums text-muted-foreground"
            style={{ insetInlineStart: `${(tick.x * 100).toFixed(3)}%` }}
            title={compactShare(tick.value)}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </figure>
  );
}
