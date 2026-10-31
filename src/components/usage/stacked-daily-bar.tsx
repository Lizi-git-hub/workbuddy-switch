
import { useMemo, type ReactElement } from "react";
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { useT } from "@/lib/i18n";
import { GATEWAY_SEGMENT, TOTAL_SEGMENT, type DailyModelColumn } from "@/lib/usage-charts";
import { LEDGER_CLIENT_SEGMENT, LEDGER_GATEWAY_SEGMENT } from "@/lib/usage-ledger";
import { LEDGER_CLIENT_COLOR, LEDGER_GATEWAY_COLOR } from "./ledger-parts";

import { compactTokens } from "./format";
import { seriesColor } from "./palette";

const MIN_VISIBLE_BAR_PX = 2;

/**
 * 低于此高度的分段**不描边**（px）。
 *
 * 描边是 2px 宽、颜色等于背景色，画在填充之上 ⇒ 高度 ≤ 2px 的柱子会被完全涂掉。
 * 取 6 是为了给「上下各 1px 描边」留出至少 4px 的可见填充。
 */
const BAR_STROKE_MIN_PX = 6;

/**
 * 柱间缝隙的一半（px）—— recharts 在带的两侧各扣一份，实际缝 = 2 × 本值。
 * 详见文件头「柱间距」一节：原型 `.cbar` 的 `gap: 2px`，此处取 2 ⇒ 相邻柱之间 4px。
 */
const BAR_CATEGORY_GAP_PX = 2;

/** recharts 传给 `Bar.shape` 的入参（只列用到的字段）。 */
interface BarShapeProps {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  radius?: number | [number, number, number, number];
  fill?: string;
  /** 类别下标（= 日列下标），由 recharts 在 `renderRectanglesStatically` 注入。 */
  index?: number;
}

/**
 * 渲染一个堆叠分段：**零值不画**，非零且为「本列最高段」时保底 {@link MIN_VISIBLE_BAR_PX}。
 *
 * `topKeyByColumn` 由本组件按 `rows` 算出（每列最后一个值 > 0 的系列键）。
 */
function visibleBar(
  props: BarShapeProps,
  seriesKey: string,
  topKeyByColumn: (string | null)[],
): ReactElement | null {
  const height = Number(props.height ?? 0);
  // 真·零值：不画。这里必须返回 null —— 给 0 值一个保底高度就是编造柱子。
  if (!(height > 0)) return null;

  const columnIndex = Number(props.index ?? -1);
  const lifted =
    topKeyByColumn[columnIndex] === seriesKey ? Math.max(height, MIN_VISIBLE_BAR_PX) : height;
  const outlined = lifted >= BAR_STROKE_MIN_PX;

  return (
    <Rectangle
      x={Number(props.x ?? 0)}
      // 向上补齐：底边仍贴住堆叠基座，不改变分段在栈里的相对位置。
      y={Number(props.y ?? 0) + height - lifted}
      width={Number(props.width ?? 0)}
      height={lifted}
      radius={props.radius}
      fill={props.fill}
      stroke={outlined ? "var(--background)" : "none"}
      strokeWidth={outlined ? 2 : 0}
    />
  );
}

/**
 * 把 {@link visibleBar} 适配成 recharts `Bar.shape` 需要的签名。
 *
 * recharts 的类型是 `(props: unknown) => JSX.Element`，**不接受 `null`**；但 React 运行时
 * 支持返回 `null`，而「零值分段不画节点」正是本组件要的语义 ⇒ 在边界处做一次显式收窄，
 * 而不是为了迁就类型去渲染一堆空 `<g>`（30 天 × 7 模型 = 210 个）。
 */
function barShape(seriesKey: string, topKeyByColumn: (string | null)[]) {
  return ((props: unknown) =>
    visibleBar(props as BarShapeProps, seriesKey, topKeyByColumn)) as (props: unknown) => ReactElement;
}

export function StackedDailyBar({
  columns,
  palette,
  valueFormat,
}: {
  columns: DailyModelColumn[];
  /**
   * 指定每个分段名的颜色（**按出现顺序**）。
   *
   * ## 为什么需要
   *
   * 默认配色是「按出现顺序取 `--s1..s8`」—— 那对「按模型堆叠」没问题（模型之间没有
   * 语义先后）。但「按账本堆叠」时**颜色本身是语义**：客户端必须青绿、网关必须靛蓝，
   * 否则用户会把两本账读成「两个模型」，而这两个色相正是页面上唯一的账本标识。
   */
  palette?: string[];
  /**
   * 数值格式化（默认按 **token** 的 `1.2M` / `340K`）。
   *
   * 积分视图复用本组件画「每日积分消耗」，但积分是小数（`1.28`），
   * 用 token 的 `K/M` 会把它显示成 `1.3K` —— 单位错了，图就撒了谎。
   */
  valueFormat?: (value: number) => string;
}) {
  const t = useT();

  const { rows, series, config, topKeyByColumn } = useMemo(() => {
    const names: string[] = [];
    for (const column of columns) {
      for (const segment of column.segments) {
        if (!names.includes(segment.name)) names.push(segment.name);
      }
    }
    const series = names.map((name, index) => ({
      key: `m${index}`,
      name,
      color:
        name === LEDGER_CLIENT_SEGMENT
          ? LEDGER_CLIENT_COLOR
          : name === LEDGER_GATEWAY_SEGMENT
            ? LEDGER_GATEWAY_COLOR
            : (palette?.[index] ?? seriesColor(index)),
    }));
    const keyByName = new Map(series.map((item) => [item.name, item.key]));

    const rows = columns.map((column) => {
      const row: Record<string, number | string> = { label: column.label };
      for (const item of series) row[item.key] = 0;
      for (const segment of column.segments) {
        const key = keyByName.get(segment.name);
        if (key) row[key] = Number(row[key]) + segment.value;
      }
      return row;
    });

    // 每列「最上面那一段」的系列键 —— 只有它需要保底高度（见 MIN_VISIBLE_BAR_PX）。
    const topKeyByColumn = rows.map((row) => {
      let top: string | null = null;
      for (const item of series) {
        if (Number(row[item.key]) > 0) top = item.key;
      }
      return top;
    });

    const config: ChartConfig = {};
    for (const item of series) {
      config[item.key] = {
        // 两个哨兵名由渲染层翻译：`__total__`（无模型明细时的合计段）与
        // `__gateway__`（网关逐日图的单段）——其余名字是模型 id，原样进 legend。
        label:
          item.name === TOTAL_SEGMENT
            ? t("wbStats.usage.trend.totalSegment")
            : item.name === GATEWAY_SEGMENT
              ? t("wbStats.usage.trend.gatewaySegment")
              : item.name === LEDGER_CLIENT_SEGMENT
                ? t("wbStats.usage.ledger.client")
                : item.name === LEDGER_GATEWAY_SEGMENT
                  ? t("wbStats.usage.ledger.gateway")
                  : item.name,
        color: item.color,
      };
    }
    return { rows, series, config, topKeyByColumn };
  }, [columns, t, palette]);

  if (columns.length === 0 || series.length === 0) return null;

  return (
    <div className="min-w-0 space-y-3.5">
      <ChartContainer config={config} className="h-[210px] w-full">
        <BarChart
          data={rows}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          barCategoryGap={BAR_CATEGORY_GAP_PX}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(value) => (valueFormat ?? compactTokens)(Number(value))} />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", opacity: 0.4 }}
            content={<ChartTooltipContent indicator="dot" />}
          />
          {series.map((item, index) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              stackId="tokens"
              fill={`var(--color-${item.key})`}
              // 不设 maxBarSize：它会把柱压窄并在带内居中，空隙全部留白（见文件头「柱间距」）。
              radius={index === series.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
              // 描边与否由 visibleBar 逐段决定（矮柱描边会被自己涂掉），故不在此处设 stroke。
              shape={barShape(item.key, topKeyByColumn)}
            />
          ))}
        </BarChart>
      </ChartContainer>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {series.map((item) => (
          <span
            key={item.key}
            className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground"
          >
            <span
              className="size-[9px] shrink-0 rounded-[3px]"
              style={{ backgroundColor: item.color }}
              aria-hidden="true"
            />
            {config[item.key]?.label ?? item.name}
          </span>
        ))}
      </div>
    </div>
  );
}
