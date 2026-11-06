
import { Coins, MessagesSquare, Users } from "lucide-react";

import { StatTiles, type StatTile } from "@/components/usage/stat-tiles";
import { compactTokens, exactTokens, formatCredits } from "@/components/usage/format";
import { useT } from "@/lib/i18n";
import type { OverviewMetrics } from "@/lib/overview-metrics";

interface Props {
  metrics: OverviewMetrics;
  /** 当前作用域的账号数（来自账号 store —— 与「待处理」同一份数据）。 */
  accountCount: number;
  /** 需要处理的账号数（重新登录 + 即将过期）。 */
  attentionCount: number;
  /** 账号库首次加载中（此时账号数还不能当结论显示）。 */
  accountsLoading: boolean;
}

export function OverviewStats({ metrics, accountCount, attentionCount, accountsLoading }: Props) {
  const t = useT();
  /* 网关功能已移除（页面 / 设置 / 采集全删）⇒ 总览不再留一张永远「—」的网关卡。 */
  const { token, credits } = metrics;

  /* 对比昨日：`(今日 - 昨日) / 昨日`；昨日为 0 时**不编百分比**。 */
  let delta: { value: string; tone: StatTile["tone"] } | null = null;
  if (token) {
    if (token.yesterday <= 0) {
      delta = { value: t("wbOverview.today.noBaseline"), tone: "default" };
    } else {
      const pct = ((token.today - token.yesterday) / token.yesterday) * 100;
      if (Math.abs(pct) < 0.05) {
        delta = { value: t("wbOverview.today.flat"), tone: "default" };
      } else if (pct > 0) {
        delta = { value: t("wbOverview.today.up", { pct: pct.toFixed(1) }), tone: "up" };
      } else {
        delta = { value: t("wbOverview.today.down", { pct: Math.abs(pct).toFixed(1) }), tone: "down" };
      }
    }
  }

  const tiles: StatTile[] = [
    {
      icon: Users,
      label: t("wbOverview.stat.accounts"),
      value: accountsLoading ? "—" : exactTokens(accountCount),
      hint:
        attentionCount > 0
          ? t("wbOverview.stat.accountsAttention", { n: attentionCount })
          : t("wbOverview.stat.accountsOk"),
      tone: attentionCount > 0 ? "warn" : "default",
    },
    {
      icon: MessagesSquare,
      label: t("wbOverview.stat.tokens"),
      value: token ? compactTokens(token.today) : "—",
      hint: delta?.value,
      title: t("wbOverview.stat.tokensHintClientOnly"),
      tone: delta?.tone ?? "default",
    },
    {
      icon: Coins,
      label: t("wbOverview.stat.credits"),
      value: credits ? formatCredits(credits.today) : "—",
      hint: credits
        ? t("wbOverview.stat.creditsRemaining", { n: formatCredits(credits.remaining) })
        : t("wbOverview.stat.unavailable"),
    },
  ];

  /* `separated`：概览按原型 `.grid.g4` 摆成**一排独立卡**（每块一张 `.stat`）。 */
  return <StatTiles tiles={tiles} ariaLabel={t("wbOverview.stat.aria")} separated />;
}