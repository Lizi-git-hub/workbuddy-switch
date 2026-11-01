
import type { CreditExpiry } from "@/lib/types";
import type { QoderProgramStatus, QoderWebCreditPacks } from "@/lib/api";
import type { TraeProgram } from "@/components/trae-account-card";
import type {
  DetailPack,
  DetailProgramBadge,
  DetailRow,
  DetailSection,
  DetailStat,
} from "@/components/account-detail-drawer";
import { formatAbsoluteTime } from "@/lib/catalog-source";
import { displayText } from "@/lib/display-text";
import { formatCredits } from "@/components/usage/format";
import type { Translate } from "@/lib/i18n";
import { aggregateNeedsAttention, type AggregateAccount } from "@/lib/aggregate-accounts";

/** 抽屉装配需要的外部事实（页面已经有的，不为了打开抽屉再发一轮请求）。 */
export interface AggregateDetailContext {
  t: Translate;
  /** WorkBuddy 的积分快照（store `creditMap` 的对应 region）。 */
  credit?: CreditExpiry;
  /** Trae / Qoder 的积分（卡片上那个「剩余 / 总额」）。 */
  credits?: { remaining: number | null; total: number | null } | null;
  /** 今日 Token（**真实新增**：非缓存输入 + 输出；缺席 = 未知，**不当 0**）。 */
  todayTokens?: number | null;
  /** 今日输入里命中缓存、已被 {@link todayTokens} 剔除的部分（仅作说明）。 */
  todayTokensCache?: number | null;
  /** 今日是否已签到（`null` / 缺席 = 未知）。 */
  todayCheckedIn?: boolean | null;
  /**
   * WorkBuddy **主程序位**当前登着的是不是这个账号。
   *
   * ⚠️ 只有主位能判：另外四个程序位（CLI / IDE / VS Code / JetBrains）的当前账号
   * 来自各自的 `*_status` 命令（按区域各一条），聚合页没拉 ⇒ 那一栏不画徽标，
   * 而不是画一排「未绑定」。
   */
  currentProgram?: boolean;
  /**
   * Trae 的程序位（`traeProgramsOf(signals, item)` 的结果，**跨区域已消歧**）。
   *
   * 页面已经从信号层算好了 —— 这里只做形状转换，不再发请求。
   */
  traePrograms?: TraeProgram[];
  /** Qoder 的程序位（信号层 `qoderPrograms`，按区域一份）。 */
  qoderPrograms?: QoderProgramStatus[];
  qoderPacks?: QoderWebCreditPacks | null;
}

const dash = "—";

export function aggregateDetailPrograms(
  account: AggregateAccount,
  ctx: AggregateDetailContext,
): DetailProgramBadge[] {
  const { t } = ctx;

  /* Trae：`TraeProgram` 与 `DetailProgramBadge` 字段几乎一一对应
     （`installed` / `hasDataDir` / `current` 都是后端给的事实）。
     `key` 必须带区域 —— 两个区域可能各有一个同名程序位。 */
  if (account.platform === "trae") {
    return (ctx.traePrograms ?? []).map((program) => ({
      key: `${program.region}:${program.program}`,
      label: program.label,
      current: program.current,
      installed: program.installed,
      hasDataDir: program.hasDataDir,
    }));
  }

  /* Qoder：后端只给四态字符串 + `currentUid`，映射到徽标的两个布尔。
     `ready` / `empty` 都说明**装了且目录在**（差别是登录态），`unreadable` 是目录在但读不了，
     其余按未装处理 —— 与卡片上那枚胶囊的 `ready = state === "ready" && !running` 不冲突：
     那是「此刻能不能切」，这里是「装了没有」。 */
  if (account.platform === "qoder") {
    const uid = displayText(account.data.uid) ?? "";
    return (ctx.qoderPrograms ?? []).map((program) => ({
      key: program.id,
      label: program.label,
      current: program.currentUid !== null && program.currentUid === uid,
      installed: program.state !== "missing",
      hasDataDir: program.state === "ready" || program.state === "empty",
    }));
  }

  /* ⚠️ 只给**主位**（WorkBuddy 客户端本身）：另外四个程序位（CLI / IDE / VS Code /
     JetBrains）的当前账号来自各自的 `*_status` 命令，聚合页没拉 ——
     画一排「未绑定」是撒谎（那是「没数据」伪装成「没装」）。
     ⚠️ 主位**不在** `WORKBUDDY_PROGRAMS` 表里（那张表是「可切换的外部程序位」，
     主位是「把账号写进客户端自己的认证文件」，语义不同）。 */
  return [
    {
      key: "workbuddy",
      label: t("product.workbuddy"),
      current: Boolean(ctx.currentProgram),
      installed: true,
      hasDataDir: true,
    },
  ];
}

/** 顶部指标块。**只给有真值的项**（缺数据不渲染那一格）。 */
export function aggregateDetailStats(
  account: AggregateAccount,
  ctx: AggregateDetailContext,
): DetailStat[] {
  const { t } = ctx;
  const stats: DetailStat[] = [];

  if (account.platform === "workbuddy") {
    const credit = ctx.credit;
    if (credit?.ok && typeof credit.totalRemaining === "number") {
      const total =
        credit.resources && credit.resources.length > 0
          ? credit.resources.reduce((sum, item) => sum + (Number.isFinite(item.total) ? item.total : 0), 0)
          : null;
      stats.push({
        key: "credits",
        label: t("wbAccounts.card.metric.credits"),
        valueText: formatCredits(credit.totalRemaining),
        subText: total === null ? undefined : `/ ${formatCredits(total)}`,
      });
    }
  } else if (ctx.credits && ctx.credits.remaining != null) {
    stats.push({
      key: "credits",
      label: t("wbAccounts.card.metric.credits"),
      valueText: formatCredits(ctx.credits.remaining),
      subText: ctx.credits.total == null ? undefined : `/ ${formatCredits(ctx.credits.total)}`,
    });
  }

  if (ctx.todayTokens != null) {
    stats.push({
      key: "todayTokens",
      label: t("wbAccounts.card.metric.todayTokens"),
      valueText: compactTokens(ctx.todayTokens),
      subText:
        ctx.todayTokensCache != null && ctx.todayTokensCache > 0
          ? t("wbAccounts.card.metric.todayTokensCache", {
              value: compactTokens(ctx.todayTokensCache),
            })
          : undefined,
    });
  }

  if (ctx.todayCheckedIn != null) {
    stats.push({
      key: "checkin",
      label: t("aggregate.detail.checkin"),
      valueText: ctx.todayCheckedIn ? t("aggregate.detail.checkedIn") : t("aggregate.detail.notCheckedIn"),
      tone: ctx.todayCheckedIn ? undefined : "warn",
    });
  }

  const lastUsed = lastUsedText(account);
  if (lastUsed) {
    stats.push({ key: "lastUsed", label: t("aggregate.detail.lastUsed"), valueText: lastUsed });
  }

  return stats;
}

function compactTokens(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

/** ISO 字符串 → `YYYY-MM-DD HH:mm`（解析失败时原样截断，不编一个假时间）。 */
function isoText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isFinite(ts)) return formatAbsoluteTime(ts);
  return iso.slice(0, 16).replace("T", " ");
}

function lastUsedText(account: AggregateAccount): string | null {
  if (account.platform === "workbuddy") {
    const ts = account.data.lastUsedAt;
    return typeof ts === "number" && ts > 0 ? formatAbsoluteTime(ts) : null;
  }
  /* Trae / Qoder 只有 `updatedAt`（ISO 字符串）—— 那是「这条记录最后被写」而不是
     「最后被使用」。文案用「最后使用」会撒谎，所以只在确实有值时才显示，
     并在 `aggregate.detail.lastUsed` 的词条里保持中性（见 locale 注释）。 */
  return isoText(account.data.updatedAt);
}

/** 信息区块：身份 + 凭据。 */
export function aggregateDetailSections(
  account: AggregateAccount,
  ctx: AggregateDetailContext,
): DetailSection[] {
  const { t } = ctx;
  const identity: DetailRow[] = [];
  const credential: DetailRow[] = [];

  if (account.platform === "workbuddy") {
    const a = account.data;
    if (a.email) identity.push({ label: t("aggregate.detail.email"), value: a.email });
    identity.push({ label: "UID", value: a.uid || a.id, mono: true });
    if (a.remark) identity.push({ label: t("aggregate.detail.remark"), value: a.remark });
    if (a.groupName) identity.push({ label: t("aggregate.detail.group"), value: a.groupName });

    credential.push({
      label: t("aggregate.detail.status"),
      value: aggregateNeedsAttention(account)
        ? t("aggregate.detail.credentialRelogin")
        : t("aggregate.detail.credentialOk"),
    });
    if (typeof a.expiresAt === "number" && a.expiresAt > 0) {
      credential.push({ label: t("aggregate.detail.expiresAt"), value: formatAbsoluteTime(a.expiresAt), mono: true });
    }
    if (typeof a.refreshExpiresAt === "number" && a.refreshExpiresAt > 0) {
      credential.push({
        label: t("aggregate.detail.refreshExpiresAt"),
        value: formatAbsoluteTime(a.refreshExpiresAt),
        mono: true,
      });
    }
  } else if (account.platform === "trae") {
    const a = account.data;
    identity.push({ label: "UID", value: a.userId, mono: true });
    if (a.remark) identity.push({ label: t("aggregate.detail.remark"), value: a.remark });
    if (a.deviceIdMasked) identity.push({ label: t("aggregate.detail.device"), value: a.deviceIdMasked, mono: true });

    credential.push({
      label: t("aggregate.detail.jwt"),
      value:
        a.jwtStatus === "ok"
          ? t("aggregate.detail.credentialOk")
          : a.jwtStatus === "warn"
            ? t("aggregate.detail.credentialExpiring")
            : a.jwtStatus === "expired"
              ? t("aggregate.detail.credentialExpired")
              : t("aggregate.detail.unknown"),
    });
    if (typeof a.jwtExpTimestamp === "number" && a.jwtExpTimestamp > 0) {
      credential.push({ label: t("aggregate.detail.expiresAt"), value: formatAbsoluteTime(a.jwtExpTimestamp), mono: true });
    }
    /* ⚠️ `cooldownUntil` 是 **epoch 毫秒**（与 `jwtExpTimestamp` 同口径），
       不是 ISO 字符串 —— 与 `updatedAt` 的形态不同，别混用 `isoText`。 */
    if (typeof a.cooldownUntil === "number" && a.cooldownUntil > 0) {
      credential.push({ label: t("aggregate.detail.cooldown"), value: formatAbsoluteTime(a.cooldownUntil), mono: true });
    }
  } else {
    const a = account.data;
    identity.push({ label: "UID", value: a.uid, mono: true });
    if (a.domain) identity.push({ label: t("aggregate.detail.domain"), value: a.domain });
    if (a.remark) identity.push({ label: t("aggregate.detail.remark"), value: a.remark });
    if (a.group) identity.push({ label: t("aggregate.detail.group"), value: a.group });

    credential.push({
      label: t("aggregate.detail.status"),
      value: a.hasCredential
        ? t("aggregate.detail.credentialOk")
        : t("aggregate.detail.credentialMissing"),
    });
    if (a.credentialSummary) {
      credential.push({ label: t("aggregate.detail.credentialSummary"), value: a.credentialSummary });
    }
    if (typeof a.expiresAt === "number" && a.expiresAt > 0) {
      credential.push({ label: t("aggregate.detail.expiresAt"), value: formatAbsoluteTime(a.expiresAt), mono: true });
    }
  }

  const sections: DetailSection[] = [];
  if (identity.length) {
    sections.push({ key: "identity", title: t("aggregate.detail.sectionIdentity"), rows: identity });
  }
  if (credential.length) {
    sections.push({ key: "credential", title: t("aggregate.detail.sectionCredential"), rows: credential });
  }
  return sections;
}

export function aggregateDetailPacks(
  account: AggregateAccount,
  ctx: AggregateDetailContext,
): DetailPack[] {
  const { t } = ctx;

  const toPack = (input: {
    key: string;
    name: string;
    total: number;
    remaining: number;
    used: number;
    expireAt: number | null;
    expired: boolean;
    expiringSoon: boolean;
  }): DetailPack => ({
    key: input.key,
    name: input.name,
    remainingText: formatCredits(input.remaining),
    totalText: formatCredits(input.total),
    usedText: formatCredits(input.used),
    expiryText: input.expireAt ? formatAbsoluteTime(input.expireAt) : dash,
    expired: input.expired,
    expiringSoon: input.expiringSoon,
    ratio: input.total > 0 ? Math.max(0, Math.min(1, input.remaining / input.total)) : 0,
  });

  if (account.platform === "workbuddy") {
    const resources = ctx.credit?.ok ? (ctx.credit.resources ?? []) : [];
    return resources
      .filter((item) => item.total > 0 || item.remaining > 0)
      .map((item, index) =>
        toPack({
          key: `${item.packageCode ?? "pack"}-${index}`,
          name: displayText(item.packageName) || displayText(item.packageCode) || t("aggregate.detail.packFallbackName"),
          total: item.total,
          remaining: item.remaining,
          used: item.used,
          expireAt: item.expireAt,
          expired: item.expired,
          expiringSoon: item.expiringSoon,
        }),
      );
  }

  if (account.platform === "trae") {
    return (account.data.creditPackages ?? []).map((item, index) =>
      toPack({
        key: `${item.packageCode ?? "pack"}-${index}`,
        name: displayText(item.packageName) || t("aggregate.detail.packFallbackName"),
        total: item.total,
        remaining: item.remaining,
        used: item.used,
        expireAt: item.expireAt,
        expired: item.expired,
        expiringSoon: item.expiringSoon,
      }),
    );
  }

  if (account.platform === "qoder") {
    const packs = ctx.qoderPacks;
    if (!packs?.available) return [];
    return packs.packs
      /* 零额度条目（真机上 `plan_quota` 那条 `limit_value = 0`）不进列表：
         它的「0 / 0」会被读成「用完了」，而它本来就不计量。 */
      .filter((pack) => pack.limit > 0 || pack.remaining > 0)
      .map((pack, index) => {
        const expired = pack.expiresAtMs !== undefined ? pack.expiresAtMs <= Date.now() : false;
        const expiringSoon =
          !expired &&
          pack.expiresAtMs !== undefined &&
          pack.expiresAtMs - Date.now() <= 14 * 24 * 3600 * 1000;
        return toPack({
          key: pack.id ?? `qoder-pack-${index}`,
          name: qoderPackSourceName(t, pack.source),
          total: pack.limit,
          remaining: pack.remaining,
          used: pack.used,
          expireAt: pack.expiresAtMs ?? null,
          expired,
          expiringSoon,
        });
      });
  }

  return [];
}

/** 上游 `source` → 聚合页文案（**不复用** Qoder 页的词条：文案域不同，混用会串）。 */
function qoderPackSourceName(t: Translate, source: string | undefined): string {
  switch (source) {
    case "PLAN":
      return t("aggregate.detail.qoderPackPlan");
    case "RESOURCE_PACKAGE_SOURCE_BONUS":
      return t("aggregate.detail.qoderPackBonus");
    case "RESOURCE_PACKAGE_SOURCE_DEDICATED":
    case "DEDICATED":
      return t("aggregate.detail.qoderPackDedicated");
    default:
      return t("aggregate.detail.packFallbackName");
  }
}
