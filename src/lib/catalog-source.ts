
import { displayText } from "@/lib/display-text";
import type { Translate } from "@/lib/i18n";
import type { CatalogSource, CatalogSnapshot } from "@/lib/types";
import type { TranslationKey } from "@/locales/zh";

/** 三级来源（与后端 `catalog::CatalogSource` 逐字对齐：live / cached / builtin）。 */
export type CatalogSourceKind = CatalogSource;

export interface CatalogSourceView {
  /**
   * 来源种类（驱动徽标语义色）。
   *
   * ⚠️ 除 WB 的三级（live / cached / builtin）外，还有 **`unavailable`**（Qoder 侧：
   * 向上游拉清单失败且**没有任何缓存**，即「真的拿不到」——它没有「内置兜底清单」，
   * 硬塞进 `builtin` 会撒谎）。共用壳只按 `badgeLabel` / `badgeVariant` / `reason`
   * 渲染，**不消费 `kind` 本身**，因此多一个取值不影响 WB / Trae 两处。
   */
  kind: CatalogSourceKind | "unavailable";
  /** 徽标文案（**已 i18n**；调用方用 `t()` 渲染）。 */
  badgeLabel: string;
  /** 徽标语义色（`success` = 实时；`secondary` = 已保存；`warning` = 内置）。 */
  badgeVariant: "success" | "secondary" | "warning";
  /** 上次识别成功时间（ms）；从未成功（builtin）为 `null`。 */
  identifiedAt: number | null;
  reason: string | null;
  identifiedCount: number;
}

/** 来源 → 徽标语义色（三级固定映射，不给调用方留「伪装」余地）。 */
const VARIANT: Record<CatalogSourceKind, CatalogSourceView["badgeVariant"]> = {
  live: "success",
  cached: "secondary",
  builtin: "warning",
};

/** 来源 → 徽标文案键（**只存键不存文案**：语言切换时整张表才会跟着变）。 */
const BADGE_KEY: Record<CatalogSourceKind, TranslationKey> = {
  live: "wbStats.gateway.sourceLive",
  cached: "wbStats.gateway.sourceCached",
  builtin: "wbStats.gateway.sourceBuiltin",
};

/** 非实时来源的**兜底原因**键（后端 `note` 缺失时使用）。 */
const REASON_KEY: Record<Exclude<CatalogSourceKind, "live">, TranslationKey> = {
  cached: "wbStats.gateway.reasonCached",
  builtin: "wbStats.gateway.reasonBuiltin",
};

/**
 * 归一来源快照。`snapshot === null`（尚未加载）按「内置 + 尚未识别」处理。
 *
 * ⚠️ 原因来源优先级：① 后端 `note`（经 `displayText` 归一）；② 缺失时 i18n 兜底。
 *    **例外**：「从未识别成功」的内置快照**无条件**带上兜底措辞（后端可能给了
 *    `DEGRADE_NOTE`，但那条不含「尚未成功识别过」，不满足契约）。
 */
export function describeCatalogSource(
  snapshot: CatalogSnapshot | null,
  t: Translate,
): CatalogSourceView {
  const kind = snapshot?.source ?? "builtin";
  const identifiedAt = snapshot?.fetched_at ?? null;
  const backendReason = displayText(snapshot?.note);
  const neverIdentified = kind === "builtin" && identifiedAt === null;

  const reason = kind === "live"
    ? null
    : neverIdentified
      ? backendReason
        ? `${t("wbStats.gateway.reasonBuiltin")} · ${backendReason}`
        : t("wbStats.gateway.reasonBuiltin")
      : backendReason ?? t(REASON_KEY[kind]);

  return {
    kind,
    badgeLabel: t(BADGE_KEY[kind]),
    badgeVariant: VARIANT[kind],
    identifiedAt,
    reason,
    identifiedCount: snapshot?.models.length ?? 0,
  };
}

export function formatRelativeTime(
  ts: number | null,
  t: Translate,
  now: number = Date.now(),
): string | null {
  if (ts === null || !Number.isFinite(ts)) return null;
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return t("shared.gateway.sourceBar.justNow");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("shared.gateway.sourceBar.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("shared.gateway.sourceBar.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t("shared.gateway.sourceBar.yesterday");
  return t("shared.gateway.sourceBar.daysAgo", { n: days });
}

export function formatAbsoluteTime(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
