
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useT } from "@/lib/i18n";
import type { ExpiryBucket } from "@/lib/usage-charts";

import { formatCredits } from "./format";

/** 柱间缝隙的一半（px）：recharts 在带两侧各扣一份 ⇒ 实际缝 4px。 */
const BAR_CATEGORY_GAP_PX = 2;

const MAX_FULL_LABELS = 12;

export function CreditExpiryBars({ buckets }: { buckets: ExpiryBucket[] }) {
  const t = useT();
  // 只留真的有到期的日子：空日占着槽位会把稀疏数据画成一排孤点（见文件头「为什么改」）。
  const data = buckets
    .filter((bucket) => bucket.value > 0)
    .map((bucket) => ({ label: `D+${bucket.day}`, value: bucket.value }));
  if (data.length === 0) return null;

  return (
    <ChartContainer
      config={{ value: { label: t("wbStats.usage.credits.expiryTitle"), color: "var(--data-series-amber)" } }}
      className="h-[170px] w-full"
    >
      <BarChart
        data={data}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        barCategoryGap={BAR_CATEGORY_GAP_PX}
      >
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={data.length <= MAX_FULL_LABELS ? 0 : "preserveStartEnd"}
        />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(value) => formatCredits(Number(value))} />
        <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.4 }} content={<ChartTooltipContent indicator="dot" />} />
        <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}
