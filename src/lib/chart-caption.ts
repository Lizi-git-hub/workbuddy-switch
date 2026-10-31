
import type { TranslationKey } from "@/locales/zh";

/** 与 `lib/i18n.ts` 的 `Translate` 同形；此处本地声明以保持零运行时导入。 */
export type CaptionTranslate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});

/** 紧凑数字（12.3K / 1.2M），单位字母大写。 */
function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return compact.format(value).replace(/([kmb])$/i, (unit) => unit.toUpperCase());
}

/** 累计消耗曲线图注：`区间累计 {total}（单日峰值 {peak}）`。 */
export function cumulativeCaption(t: CaptionTranslate, total: number, peak: number): string {
  return t("wbStats.usage.caption.cumulative", {
    total: compactNumber(total),
    peak: compactNumber(peak),
  });
}

/**
 * 积分余额曲线图注。
 *
 * `baseline > 0` ⇒ 写明「非 0」；若基线确实落在 0（曲线触零），
 * 则**不写「非 0」**（写就是撒谎），改用不含该措辞的变体。
 */
export function balanceCaption(
  t: CaptionTranslate,
  first: number,
  last: number,
  baseline: number,
): string {
  if (baseline > 0) {
    return t("wbStats.usage.caption.balance", {
      first: compactNumber(first),
      last: compactNumber(last),
      baseline: compactNumber(baseline),
    });
  }
  return t("wbStats.usage.caption.balanceZero", {
    first: compactNumber(first),
    last: compactNumber(last),
  });
}

/** 会话散点横轴语义：**记录数**，不是消息数。 */
export function scatterAxisCaption(t: CaptionTranslate): string {
  return t("wbStats.usage.caption.scatterAxis");
}

export function singleSideCaption(t: CaptionTranslate): string {
  return t("wbStats.usage.caption.singleSide");
}

/**
 * 网关逐日图图注：**恒披露覆盖率**。
 *
 * 为什么恒披露：网关历史只覆盖「App 运行过」的日子（后台周期记录在跑才有条目）——
 * 未记录日**不是 0**。只说「悬停看明细」而不说覆盖了多少天，读者会把缺口读成「那天没用量」。
 * 有几天标了「可能被裁」时再追加下界说明（那些天的总量只是**下界**）。
 */
export function gatewayTrendCaption(
  t: CaptionTranslate,
  recorded: number,
  total: number,
  truncatedDays: number,
): string {
  const base = t("wbStats.usage.caption.gateway", { recorded, total });
  return truncatedDays > 0
    ? `${base} · ${t("wbStats.usage.caption.gatewayLower", { n: truncatedDays })}`
    : base;
}

/**
 * 概览 · 近 14 天逐日 Token 柱状图的图注：`合计 + 单日峰值`。
 *
 * 与累计曲线同口径（写**峰值**而不是「峰值 = 末值」这类废话）：概览的柱子是**逐日**的，
 * 读者最想知道的就是「这半个月一共多少、最忙的一天多少」。
 */
/**
 * Qoder 用量 · 逐日 **credits** 柱状图的图注：`合计 + 单日峰值`。
 *
 * 与 `tokenTrendCaption` **同口径、不同单位** —— Qoder 按 credits 计费，token 计数恒 0
 * （见 `pages/QoderUsagePage.tsx` 文件头）。单位不能含糊：同一句文案里换个单位就是谎报。
 */
export function creditTrendCaption(t: CaptionTranslate, total: number, peak: number): string {
  return t("qoder.page.usage.caption", {
    total: compactNumber(total),
    peak: compactNumber(peak),
  });
}

export function tokenTrendCaption(t: CaptionTranslate, total: number, peak: number): string {
  return t("wbOverview.trend.caption", {
    total: compactNumber(total),
    peak: compactNumber(peak),
  });
}
