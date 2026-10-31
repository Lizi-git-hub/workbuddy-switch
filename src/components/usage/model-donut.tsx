/**
 * 趋势 / 模型 · **模型占比环形**（recharts `PieChart` + `innerRadius`）。
 *
 * ## 契约
 *
 * **扇区数 = 模型数** —— 每个 `ModelSlice` 产出一个扇区（`lib/usage-charts.ts` 保证
 * 只保留 value > 0 的模型；调用方直接传入，本组件不裁剪、不合并「其他」）。
 *
 * ## 无障碍
 *
 * 每段 `<title>`（recharts 的 `Pie` 会把 `name` 放进 `<title>`），并配图例。
 */

import { Cell, Pie, PieChart } from "recharts";

import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { useT } from "@/lib/i18n";
import type { ModelSlice } from "@/lib/usage-charts";

import { compactShare, compactTokens } from "./format";
import { seriesColor } from "./palette";

/** 单个模型的窗口内四档明细（由调用方从 `dailyByModel` 过滤求和）。 */
export interface ModelDonutDetail {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  hitRate: number | null;
}

export function ModelDonut({
  slices,
  size = 170,
  details,
}: {
  slices: ModelSlice[];
  size?: number;
  /** 模型名 → 四档明细；缺省时图例只显示 token 数。 */
  details?: Record<string, ModelDonutDetail>;
}) {
  const t = useT();
  if (slices.length === 0) return null;

  const data = slices.map((slice, index) => ({
    name: slice.name,
    value: slice.value,
    fill: seriesColor(index),
  }));
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const config: ChartConfig = {};
  data.forEach((item) => {
    config[item.name] = { label: item.name, color: item.fill };
  });

  const outerRadius = Math.round(size / 2 - 6);
  const innerRadius = Math.round(outerRadius * 0.66);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-4">
      <div className="relative shrink-0">
        <ChartContainer config={config} className="shrink-0" style={{ width: size, height: size }}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={innerRadius}
              outerRadius={outerRadius}
              stroke="var(--background)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((item) => (
                <Cell key={item.name} fill={item.fill} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-sm font-semibold tabular-nums">{compactTokens(total)}</span>
          <span className="text-[10px] text-muted-foreground">{t("wbStats.usage.trend.totalSegment")}</span>
        </div>
      </div>
      <div className="min-w-[220px] flex-1 space-y-2">
        {data.map((item) => {
          const detail = details?.[item.name];
          const hit =
            detail && detail.hitRate !== null
              ? `${(detail.hitRate * 100).toFixed(1)}%`
              : "—";
          return (
            <div key={item.name} className="min-w-0">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span
                  className="size-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: item.fill }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate" title={item.name}>
                  {item.name}
                </span>
                {/* 图例带该模型的具体 token 数 —— 模型页签合并后，排行数字归到这里。 */}
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {compactTokens(item.value)}
                </span>
              </div>
              {/* 四档明细 + 命中率：模型页签删掉后，这些只有这里看得到。 */}
              {detail ? (
                <div
                  className="ml-[18px] mt-0.5 text-[10.5px] leading-4 tabular-nums text-muted-foreground"
                >
                  输入 {compactShare(detail.input)} · 缓存读 {compactShare(detail.cacheRead)} · 缓存写{" "}
                  {compactShare(detail.cacheWrite)} · 输出 {compactShare(detail.output)} · 命中 {hit}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
