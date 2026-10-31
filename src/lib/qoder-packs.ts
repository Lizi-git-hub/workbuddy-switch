
import type { QoderCreditPack } from "@/lib/api";
import type { Translate } from "@/lib/i18n";

export const EXPIRING_SOON_MS = 14 * 24 * 3600 * 1000;

/**
 * 逐包数据的**前端缓存有效期**：60 秒。
 *
 * 为什么需要 TTL：浮层打开即请求、卡片与抽屉都会触发 ⇒ 没有 TTL 的话，同一个账号
 * 会被点一次打一次上游（逐包接口要带会话 Cookie，打多了容易被判异常）。
 * 60s 是「够新鲜」与「别打扰上游」的折中；显式「刷新」按钮走 `force`，不受它限制。
 */
export const PACKS_TTL_MS = 60_000;

/** 包级状态（**行内差异**，不往卡片上挂徽章 —— 卡片是固定版式）。 */
export type QoderPackState = "expired" | "expiring" | "normal" | "zero";

/**
 * 判一个包的状态。
 *
 * `zero`：`limit <= 0` —— 真机上 `plan_quota` 那一条就是这种（套餐额度单独计量），
 * 它的「剩余 0/0」不是「用完了」，所以不能标红。
 */
export function packState(pack: QoderCreditPack, now: number): QoderPackState {
  if (pack.expiresAtMs !== undefined && pack.expiresAtMs <= now) return "expired";
  if (pack.limit <= 0) return "zero";
  if (
    pack.expiresAtMs !== undefined &&
    pack.expiresAtMs - now <= EXPIRING_SOON_MS
  ) {
    return "expiring";
  }
  return "normal";
}

/** 上游 `source` 取值 → 本地化标签。未知取值兜底成「资源包」，**不显示原始枚举串**。 */
export function packSourceLabel(
  t: Translate,
  source: string | undefined,
): string {
  switch (source) {
    case "PLAN":
      return t("qoder.page.accounts.web.sourcePlan");
    case "RESOURCE_PACKAGE_SOURCE_BONUS":
      return t("qoder.page.accounts.web.sourceBonus");
    case "RESOURCE_PACKAGE_SOURCE_DEDICATED":
    case "DEDICATED":
      return t("qoder.page.accounts.web.sourceDedicated");
    default:
      // 上游可能新增取值：给通用名，别把 `SOME_NEW_ENUM` 直接怼到用户脸上。
      return t("qoder.page.accounts.web.sourceOther");
  }
}
