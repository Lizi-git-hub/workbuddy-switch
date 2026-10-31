
import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { useT } from "@/lib/i18n";
import type { CreditDailyBar } from "@/lib/usage-charts";

import { formatCredits, signedCredits } from "./format";

const CONFIG = {
  up: { label: "in", color: "var(--data-series-emerald)" },
  down: { label: "out", color: "var(--data-series-amber)" },
} satisfies ChartConfig;

/** 柱间缝隙的一半（px）：recharts 在带两侧各扣一份 ⇒ 实际缝 4px。与每日堆叠柱同值。 */
const BAR_CATEGORY_GAP_PX = 2;

interface DivergingRow {
  label: string;
  /** 柱高（正数），对应 `dataKey="up"`。 */
  up: number;
  /** 柱高（**负数**，由零线向下），对应 `dataKey="down"`。 */
  down: number;
}

/** tooltip：双向时列出两侧，单向时只列消耗侧。数值一律**取自已绘制的行**。 */
function DivergingTooltip({
  active,
  payload,
  showInflow,
}: {
  active?: boolean;
  payload?: Array<{ payload?: DivergingRow }>;
  showInflow: boolean;
}) {
  const t = useT();
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  /* 消耗侧取绝对值：行里是负数（画在零线下方），展示口径是「消耗 N」而非「-N」。 */
  const outAmt = Math.abs(Number(row.down));
  return (
    <div className="grid gap-1 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
      <div className="font-medium">{row.label}</div>
      {showInflow ? (
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t("wbStats.usage.credits.in")}</span>
          <span className="font-mono tabular-nums text-success">
            {signedCredits(Number(row.up), "+")}
          </span>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">{t("wbStats.usage.credits.out")}</span>
        <span className="font-mono tabular-nums text-warning">{signedCredits(outAmt, "-")}</span>
      </div>
    </div>
  );
}

export function CreditDivergingBar({ bars }: { bars: CreditDailyBar[] }) {
  if (bars.length === 0) return null;

  const showInflow = bars.some((bar) => bar.inAmt > 0);
  const data: DivergingRow[] = bars.map((bar) => ({
    label: bar.label,
    up: bar.inAmt,
    down: -bar.outAmt,
  }));

  return (
    <ChartContainer config={CONFIG} className="h-[180px] w-full">
      <BarChart
        data={data}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        barCategoryGap={BAR_CATEGORY_GAP_PX}
      >
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(value) => formatCredits(Math.abs(Number(value)))}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.4 }}
          content={<DivergingTooltip showInflow={showInflow} />}
        />
        <ReferenceLine y={0} stroke="var(--border)" />
        {showInflow ? (
          <Bar
            dataKey="up"
            stackId="flow"
            fill="var(--color-up)"
            stroke="var(--background)"
            strokeWidth={1}
            isAnimationActive={false}
          />
        ) : null}
        <Bar
          dataKey="down"
          stackId="flow"
          fill="var(--color-down)"
          stroke="var(--background)"
          strokeWidth={1}
          radius={showInflow ? 0 : [0, 0, 4, 4]}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  );
}
