import { Ban, Check, CircleCheck, Coins, Loader2, PlaneTakeoff, QrCode } from "lucide-react";

import { Badge } from "@/components/ui/badge";
// P0 · 程序位表（含「计划新增 / 尚未支持」态）—— 展示侧镜像，与后端 `programs.rs` 逐字对齐。
import { PLANNED_PROGRAMS } from "@/lib/platforms/registry";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DemoAction } from "@/components/demo-action";
import { AccountMoreMenu, AccountMoreMenuDemo } from "@/components/account-more-menu";
import type { AccountRefreshKind } from "@/lib/account-refresh";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { shouldOpenAccountDetail } from "@/lib/account-open-guard";
import { ENCRYPTED_CREDENTIAL_REASON } from "@/lib/api";
import { compactTokens, exactTokens } from "@/components/usage/format";
import { demoModeEnabled } from "@/lib/demo-mode";
import { displayText } from "@/lib/display-text";
import {
  EXPIRY_TIP_MAX_HEIGHT,
  daysUntil,
  nearestExpiringBatch,
  summarizeExpiring,
  upcomingExpiries,
} from "@/lib/credit-expiry";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/catalog-source";
import { useT, type Translate } from "@/lib/i18n";
import type { AccountMeta, AccountTokenTodayEntry, CreditExpiry, TravelStatus } from "@/lib/types";

const OFF_PROGRAM_CLASS =
  "border-dashed opacity-50 hover:border-warning hover:text-warning hover:opacity-80";
const PLANNED_PROGRAM_CLASS = "cursor-not-allowed border-dashed opacity-50";

const AVATAR_TONES = [
  "[background:oklch(0.5_0.13_163)]",
  "[background:oklch(0.48_0.14_265)]",
  "[background:oklch(0.5_0.13_300)]",
  "[background:oklch(0.5_0.14_60)]",
  "[background:oklch(0.48_0.13_20)]",
  "[background:oklch(0.5_0.12_220)]",
] as const;

/**
 * 头像字色：统一近白（原型 `oklch(0.99 0 0)`，`demo.css:311`）。
 *
 * ⚠️ **导出**：Trae 账号卡的头像必须与 WorkBuddy 用同一套（字号 / 圆角 / 字色 / 首字取法），
 * 否则两个产品分区的卡片会各长一版头像 —— 而原型只有 `.avatar` 一种。
 */
export const AVATAR_TEXT_CLASS = "text-[oklch(0.99_0_0)]";

/**
 * 按账号名稳定地取一个头像底色。
 *
 * 与 `trae-account-card.tsx` 共用：两个产品分区的账号卡片必须是同一套视觉，
 * 各自维护一份色板迟早会漂移，因此这里导出而不是复制。
 */
export function avatarTone(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

/**
 * 头像首字 —— 对齐原型 `initials()`（`buddy-switch-prototype.html:1929`）：
 * **去掉非字母数字/汉字的字符后取前 2 位**并转大写。
 *
 * ⚠️ 与 `avatarTone` 同源导出：Trae 侧账号卡也用同一套（否则两个产品线的头像会分叉）。
 * 「spare-global」→ `SP`、`jacky」→ `JA`、`花` → `花`（中文保留 1 字，够辨识）。
 */
export function accountInitials(name: string): string {
  const cleaned = (name || "?").replace(/[^a-zA-Z0-9一-龥]/g, "");
  return (cleaned || "?").slice(0, 2).toUpperCase();
}

export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

/**
 * 「今日 Token」的**诚实**展示串（卡片与表格**同一份**实现，避免两处口径漂移）。
 *
 * 四条边界（见 `AccountTokenTodayResponse`）：
 * - `entry` 缺失 = 该账号今日**无记录 / 未知** ⇒ **「—」**（**绝不**当 0）；
 * - 出现在 `entry` 里的 `0` 是**真实 0**（`compactTokens(0)` = `"0"`）；
 * - `truncated`（网关日志的**今日**部分可能被裁）⇒ 网关部分是**下界** ⇒ 整串渲染成 **`≥N`**；
 * - 客户端 / 网关**两侧都非零** ⇒ 合计可能重复计数（两条独立记录），说明由明细
 *   （{@link todayTokensBreakdown}）带上 —— headline 只负责数字，不负责解释。
 */
export function formatTodayTokens(
  entry: AccountTokenTodayEntry | null | undefined,
  truncated: boolean,
  t: Translate,
): string {
  if (!entry) return "—";
  const total = entry.clientIn + entry.clientOut + entry.gatewayIn + entry.gatewayOut;
  const value = compactTokens(total);
  return truncated ? t("wbAccounts.card.metric.atLeast", { value }) : value;
}

export function todayTokensBreakdown(
  entry: AccountTokenTodayEntry | null | undefined,
  truncated: boolean,
  t: Translate,
): string {
  if (!entry) return "";
  const parts = [
    t("wbAccounts.card.metric.todayTokensClient", {
      input: exactTokens(entry.clientIn),
      output: exactTokens(entry.clientOut),
    }),
    t("wbAccounts.card.metric.todayTokensGateway", {
      input: exactTokens(entry.gatewayIn),
      output: exactTokens(entry.gatewayOut),
    }),
  ];
  // 只有一侧为 0 时，合计就是另一侧、没有歧义 ⇒ 不必加噪音。
  const clientTotal = entry.clientIn + entry.clientOut;
  const gatewayTotal = entry.gatewayIn + entry.gatewayOut;
  if (clientTotal > 0 && gatewayTotal > 0) {
    parts.push(t("wbAccounts.card.metric.todayTokensOverlap"));
  }
  if (truncated) parts.push(t("wbAccounts.card.metric.todayTokensTruncated"));
  return parts.join(t("shared.punct.comma"));
}

export function formatCreditExpiry(ts: number | null, t: Translate): string {
  if (!ts) return t("wbAccounts.card.forever");
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return t("wbAccounts.card.forever");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function accountSubtitle(account: AccountMeta): string {
  const email = displayText(account.email);
  if (!email) return "";
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local.slice(0, 1)}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

export function accountIdentity(account: AccountMeta): string {
  const email = displayText(account.email);
  if (email) {
    const [local, domain] = email.split("@");
    if (!domain) return email;
    return `${local.slice(0, 1)}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
  }
  const uid = displayText(account.uid);
  if (uid) return `UID · ${uid}`;
  return `ID · ${displayText(account.id) ?? "—"}`;
}

export function accountDisplayName(account: AccountMeta): string {
  return displayText(account.nickname) || accountIdentity(account);
}

export function identityDisplayName(
  person: { uid?: string | null; nickname?: string | null; email?: string | null } | null | undefined,
): string {
  if (!person) return "";
  return displayText(person.nickname) || accountIdentity(person as AccountMeta);
}

const chipClass = "border-0 px-[7px] font-medium";

function travelIconChip({
  text,
  tooltip,
  variant,
}: {
  /** 徽章上的短文字。 */
  text: string;
  /** tooltip 里的细节（地点 · 奖励 · 剩余时间）。 */
  tooltip: string;
  variant: "secondary" | "success";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className={chipClass} aria-label={tooltip}>
          <PlaneTakeoff /> {text}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function formatTravelRemaining(arriveAt: number | null | undefined, t: Translate): string | null {
  if (!arriveAt || arriveAt <= 0) return null;
  const arriveMs = arriveAt > 1e12 ? arriveAt : arriveAt * 1000;
  const remainingMs = arriveMs - Date.now();
  if (remainingMs <= 0) return t("wbAccounts.card.arrivingSoon");
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return t("wbAccounts.card.remainingHM", { hours, minutes });
  if (hours > 0) return t("wbAccounts.card.remainingH", { hours });
  return t("wbAccounts.card.remainingM", { minutes });
}

function travelTooltip(status: TravelStatus, t: Translate): string {
  const place = status.locationName?.trim();
  const credit = status.rewardCredit;
  const points = credit != null ? `+${credit}` : null;
  const remaining = formatTravelRemaining(status.arriveAt, t);
  if (status.label === "traveling") {
    const parts = [place, points ? t("wbAccounts.card.travelEst", { points }) : t("wbAccounts.card.traveling"), remaining].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : t("wbAccounts.card.traveling");
  }
  if (status.label === "finished") {
    if (place && points) return `${place} · ${points}`;
    if (place) return `${place} · ${t("wbAccounts.card.finished")}`;
    if (points) return `${t("wbAccounts.card.finished")} · ${points}`;
    return t("wbAccounts.card.finished");
  }
  if (status.label === "no-buddy") return t("wbAccounts.card.noBuddy");
  return t("wbAccounts.card.notTraveled");
}

/** 按旅行状态渲染标签：无 Buddy / 未旅行 / 旅行中 / 已结束。 */
function travelChip(status: TravelStatus | undefined) {
  const t = useT();
  if (!status) return null;
  switch (status.label) {
    case "no-buddy":
      return <Badge variant="secondary" className={cn(chipClass, "text-muted-foreground")}>{t("wbAccounts.card.noBuddy")}</Badge>;
    case "traveling":
      return travelIconChip({ text: t("wbAccounts.card.traveling"), tooltip: travelTooltip(status, t), variant: "secondary" });
    case "finished":
      return travelIconChip({ text: t("wbAccounts.card.finished"), tooltip: travelTooltip(status, t), variant: "success" });
    case "untraveled":
    default:
      return null;
  }
}

/** 未检测到的程序位引导目标（对应设置页里的子项）。 */
export type GuideTarget = "ide" | "cli";

interface Props {
  account: AccountMeta;
  onDelete: (a: AccountMeta) => void;
  onCheckin?: (a: AccountMeta) => void;
  onRefresh?: (a: AccountMeta) => void;
  /**
   * 单项刷新（积分 / 今日 Token / 签到状态 / 凭据状态）。
   *
   * 不传 ⇒ 菜单退回旧的单条「刷新 Token」项（向后兼容：页面还没接上时行为不变）。
   * 传了 ⇒ 渲染「刷新」分组，四项各自独立（理由见 `lib/account-refresh.ts` 文件头）。
   */
  onRefreshPart?: (a: AccountMeta, kind: AccountRefreshKind) => void;
  /** 本账号正在进行中的刷新项；用于把对应菜单项标成「刷新中…」。 */
  refreshingKinds?: readonly AccountRefreshKind[];
  /** 刚刚刷新成功（自行淡出）的项，菜单里显示「已更新」。 */
  doneKinds?: readonly AccountRefreshKind[];
  /** 「导出账号」（原型同位项）。页面侧弹导出对话框。 */
  onExport?: (a: AccountMeta) => void;
  /** 本平台真的能刷的项（缺省四项）；见 `RefreshMenuGroup` 的注释。 */
  refreshKinds?: readonly AccountRefreshKind[];
  onSwitch?: (a: AccountMeta) => void;
  todayCheckedIn?: boolean;
  /** 今日旅行状态（undefined=查询中/未知，不渲染标签） */
  travelStatus?: TravelStatus;
  credit?: CreditExpiry;
  creditLoading?: boolean;
  creditPriority?: boolean;
  workbuddyActive?: boolean;
  codebuddyCliConfigured?: boolean;
  codebuddyCliGatewayMode?: boolean;
  codebuddyCliActive?: boolean;
  /** 任一 CodeBuddy CLI 账号切换正在进行，用于阻止并发切换。 */
  codebuddyCliBusy?: boolean;
  onSwitchCodebuddyCli?: (a: AccountMeta) => void;
  /** 当前卡片是否为正在切换的目标账号。 */
  codebuddyCliLoading?: boolean;
  /** CodeBuddy CN IDE 是否已安装（可切换）。 */
  codebuddyCnIdeAvailable?: boolean;
  codebuddyCnIdeActive?: boolean;
  codebuddyCnIdeBusy?: boolean;
  codebuddyCnIdeLoading?: boolean;
  onSwitchCodebuddyCnIde?: (a: AccountMeta) => void;
  /**
   * 编辑器内 CodeBuddy 插件两个程序位（VS Code / JetBrains）。
   *
   * ⚠️ 与 `planned` 的措辞**必须分开**：`planned` = 本应用**尚未支持**（去装客户端也没用）；
   * 这里是**本机没装**（去装就有用）—— 两者混用会把用户引向错误动作。
   * `available` 由各自的后端状态命令给出（`installed` / `pluginInstalled`）。
   */
  vscodePluginAvailable?: boolean;
  vscodePluginActive?: boolean;
  vscodePluginBusy?: boolean;
  vscodePluginLoading?: boolean;
  onSwitchVscodePlugin?: (a: AccountMeta) => void;
  jetbrainsPluginAvailable?: boolean;
  jetbrainsPluginActive?: boolean;
  jetbrainsPluginBusy?: boolean;
  jetbrainsPluginLoading?: boolean;
  onSwitchJetbrainsPlugin?: (a: AccountMeta) => void;
  /**
   * 未检测到编辑器扩展时的出口（与「引导去设置」不同：这是**本机没装编辑器扩展**，
   * 设置页里没有对应子项 ⇒ 由调用方给一条说明性提示，指针指向「先装扩展」）。
   */
  onGuidePlugin?: (programId: string) => void;
  /**
   * 打开「OAuth 扫码添加」。
   *
   * 只在 `credit.reason === ENCRYPTED_CREDENTIAL_REASON` 时用到：这类账号的凭据
   * 我方解不开，光把错误摆出来用户不知道下一步做什么。卡片自己开不了弹窗
   *（弹窗由页面持有），所以走回调。
   */
  onAddPlaintextAccount?: () => void;
  onGuideToSetting?: (target: GuideTarget) => void;
  /** 是否被勾选（批量操作）。 */
  selected?: boolean;
  /** 切换勾选。 */
  onToggleSelect?: (a: AccountMeta) => void;
  /** 打开详情抽屉（抽屉状态由页面持有）。 */
  onOpenDetail?: (a: AccountMeta) => void;
  /** 「更多 → 编辑备注」：打开抽屉并进入编辑态。 */
  /** 「更多 → 设置分组」：打开抽屉并进入分组编辑态（与备注同一交互）。 */
  /**
   * 该账号「今日 Token」明细（`get_account_token_today`）。
   *
   * ⚠️ **缺席 = 今日无记录 / 未知** ⇒ 渲染「—」（**绝不当 0**）。
   */
  todayTokens?: AccountTokenTodayEntry | null;
  /** 网关日志已到保留上限 ⇒ 网关部分是下界 ⇒ 「今日 Token」渲染 `≥N`。 */
  todayTokensTruncated?: boolean;
  featuresDisabled?: boolean;
}

function ProductCurrentState({
  product,
  short,
}: {
  product: "workbuddy" | "codebuddy" | "codebuddy-cn";
  /** 短名（原型 `pg.short`：`WB` / `IDE` / `CLI`）—— 显示在 ✓ 之后。 */
  short: string;
}) {
  const t = useT();
  const title =
    product === "workbuddy"
      ? t("wbAccounts.card.currentWorkbuddy")
      : product === "codebuddy-cn"
        ? t("wbAccounts.card.currentIde")
        : t("wbAccounts.card.currentCli");
  return (
    <span
      role="status"
      aria-label={title}
      title={title}
      className={cn(
        /* 不用硬编码的 `inset 0 1px 0 rgba(255,255,255,.8)`：深色下那是一条刺眼的白线
           （原型 `.prog.on` 只有底色 + 描边，无内阴影）。 */
        "inline-flex items-center justify-center border border-primary/40 bg-primary/18 text-primary font-semibold",
        /* ⚠️ 与程序位**同一 footprint**（原型 `.prog` 26px / 圆角 8px / `gap:4px`）。
           内容 = `✓ + 短名`（原型 `.prog.on` 逐字一致，**没有产品图标**）。 */
        "h-[26px] gap-1 rounded-[8px] px-2 text-[11px]",
      )}
    >
      <Check className="size-3" strokeWidth={2.25} />
      <span>{short}</span>
    </span>
  );
}

export function AccountCard({ account, onDelete, onCheckin, onRefresh, onRefreshPart, refreshingKinds, doneKinds, refreshKinds, onExport, onSwitch, todayCheckedIn, travelStatus, credit, creditLoading, creditPriority, workbuddyActive, codebuddyCliConfigured, codebuddyCliGatewayMode, codebuddyCliActive, codebuddyCliBusy, onSwitchCodebuddyCli, codebuddyCliLoading, codebuddyCnIdeAvailable, codebuddyCnIdeActive, codebuddyCnIdeBusy, codebuddyCnIdeLoading, onSwitchCodebuddyCnIde, vscodePluginAvailable, vscodePluginActive, vscodePluginBusy, vscodePluginLoading, onSwitchVscodePlugin, jetbrainsPluginAvailable, jetbrainsPluginActive, jetbrainsPluginBusy, jetbrainsPluginLoading, onSwitchJetbrainsPlugin, onGuidePlugin, onAddPlaintextAccount, onGuideToSetting, selected = false, onToggleSelect, onOpenDetail, todayTokens, todayTokensTruncated = false, featuresDisabled = true }: Props) {
  const t = useT();
  const name = displayText(account.nickname) || displayText(account.uid) || t("wbAccounts.card.unnamed");
  const expired = typeof account.expiresAt === "number" && account.expiresAt < Date.now();
  /* 卡片表面：脱敏邮箱（无邮箱 ⇒ 「未绑定邮箱」），不落 UID。 */
  const identity = accountSubtitle(account) || "未绑定邮箱";
  const avatarClass = avatarTone(name);

const programSlots = [
  { key: "workbuddy", active: workbuddyActive, available: true },
  { key: "codebuddy-cli", active: codebuddyCliActive, available: codebuddyCliConfigured },
  { key: "codebuddy-cn-ide", active: codebuddyCnIdeActive, available: codebuddyCnIdeAvailable },
  { key: "vscode-plugin", active: vscodePluginActive, available: vscodePluginAvailable },
  { key: "jetbrains-plugin", active: jetbrainsPluginActive, available: jetbrainsPluginAvailable },
] as const;

const activeProductCount = programSlots.filter((slot) => slot.active).length;

/**
 * 「当前登录」= 账号绑定到**任一**程序位（原型 `accountCard` :2493-2495：多对多，不是只看第一个）。
 *
 * ⚠️ 与左侧竖条口径一致：竖条 + 徽章是同一信号的**两重表达**，二者必须在同一条件下出现，
 * 否则会出现「有徽章却无竖条」的矛盾态。判定直接读 `programSlots` ⇒ 与上面的
 * `activeProductCount` **同源**，不可能再分叉。
 */
const isCurrentAccount = programSlots.some((slot) => slot.active);

  const metricResources = credit?.ok ? credit.resources ?? [] : [];
  /** 当前（剩余）积分 —— 与原型 `a.credits` 同义。 */
  const metricCreditCurrent =
    credit?.ok && typeof credit.totalRemaining === "number" ? credit.totalRemaining : null;
  /** 「最后使用」：仅当有真实的 `lastUsedAt`（epoch 毫秒）才渲染该项；否则整项省略。 */
  const lastUsedAt = typeof account.lastUsedAt === "number" && account.lastUsedAt > 0 ? account.lastUsedAt : null;

  const lastUsedRelative = formatRelativeTime(lastUsedAt, t);
  /* 视觉重心：当前积分一个大数字 + 「N 个积分包」。
     早先积分混在 11.5px 的小字指标行里（「积分 4,372.41/4,441」），
     卡片一眼看过去全是状态标签，找不到主数字。 */
  const creditHeadline =
    metricCreditCurrent !== null ? (
      <div className="flex min-w-0 items-baseline gap-2 pt-0.5">
        <span className="text-[22px] font-semibold leading-none tabular-nums tracking-tight">
          {formatCredits(metricCreditCurrent)}
        </span>
        {metricResources.length > 0 ? (
          <span className="truncate text-[11px] text-muted-foreground">
            {t("wbAccounts.card.packageCount", { n: metricResources.length })}
          </span>
        ) : null}
      </div>
    ) : null;

  const metricsRow = (
    <div className="flex min-w-0 gap-[14px] text-[11.5px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        {t("wbAccounts.card.metric.todayTokens")}{" "}
        {todayTokens ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <b className="cursor-default font-semibold tabular-nums text-foreground">
                {formatTodayTokens(todayTokens, todayTokensTruncated, t)}
              </b>
            </TooltipTrigger>
            <TooltipContent side="top">
              {todayTokensBreakdown(todayTokens, todayTokensTruncated, t)}
            </TooltipContent>
          </Tooltip>
        ) : (
          <b className="font-semibold tabular-nums text-foreground">—</b>
        )}
      </span>
      {lastUsedRelative !== null && (
        <span title={t("wbAccounts.card.metric.lastUsedTip", { time: formatAbsoluteTime(lastUsedAt) })}>
          {lastUsedRelative}
        </span>
      )}
    </div>
  );

  const currentLoginBadge = isCurrentAccount ? (
    <Badge variant="info" className={cn(chipClass, "shrink-0")}>
      {t("wbAccounts.card.currentLogin")}
    </Badge>
  ) : null;

  const expiryTipBody = (batches: readonly { expireAt: number; amount: number }[]) => (
    <>
      <div className="sticky -top-2 -mx-3 -mt-2 bg-popover px-3 pb-1 pt-2 font-medium">
        {t("wbAccounts.card.expiringTipTitle", { n: batches.length })}
      </div>
      {batches.map((batch) => (
        <div key={batch.expireAt} className="whitespace-nowrap tabular-nums">
          {t("wbAccounts.card.expiringTipLine", {
            time: formatAbsoluteTime(batch.expireAt),
            amount: formatCredits(batch.amount),
          })}
        </div>
      ))}
    </>
  );

  const expiring = credit?.ok ? summarizeExpiring(metricResources) : null;
  const expiringChip = expiring ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="warning"
          className={chipClass}
          aria-label={t("wbAccounts.card.expiringChip", {
            amount: formatCredits(expiring.total),
            days: expiring.days,
          })}
        >
          {t("wbAccounts.card.expiringChip", { amount: formatCredits(expiring.total), days: expiring.days })}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" style={{ maxHeight: EXPIRY_TIP_MAX_HEIGHT }}>
        {expiryTipBody(expiring.batches)}
      </TooltipContent>
    </Tooltip>
  ) : null;

  const nearestBatch = credit?.ok ? nearestExpiringBatch(metricResources) : null;
  /**
   * 未来全部批次 —— **算一次**。
   *
   * 此前 title 与明细各调一次 `upcomingExpiries`：同一份数据被过滤+合并+排序两遍，
   * 而且两次调用之间若跨过某个到期时刻，标题里的「共 N 笔」会和下面列出来的行数不一致。
   */
  const upcoming = nearestBatch ? upcomingExpiries(metricResources) : [];
  const nearestChip = nearestBatch && !expiring ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="secondary"
          className={chipClass}
          aria-label={t("wbAccounts.card.nearestExpiringChip", {
            amount: formatCredits(nearestBatch.amount),
            days: daysUntil(nearestBatch.expireAt),
          })}
        >
          {t("wbAccounts.card.nearestExpiringChip", {
            amount: formatCredits(nearestBatch.amount),
            days: daysUntil(nearestBatch.expireAt),
          })}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" style={{ maxHeight: EXPIRY_TIP_MAX_HEIGHT }}>
        {expiryTipBody(upcoming)}
      </TooltipContent>
    </Tooltip>
  ) : null;

  /**
   * 状态标签 —— 与原型 `accountStatus()`（`buddy-switch-prototype.html:2390-2395`）**同一口径**：
   *
   * ```
   * 凭据已过期(bad) → 需重新登录(bad) → 今日未签到(warn) → null（渲染「已签到」ok）
   * ```
   *
   * ⚠️ 原型是**互斥的一枚**。此前本仓把「已签到」与「需重新登录」当两枚并列渲染
   * ⇒ 同一张卡会同时挂着「已签到」和「需重新登录」两个互相矛盾的标签。
   */
  const statusChip = expired ? (
    <Badge variant="destructive" className={chipClass}>{t("wbAccounts.card.tokenExpired")}</Badge>
  ) : account.needsRelogin ? (
    <Badge variant="destructive" className={chipClass}>{t("wbAccounts.card.needRelogin")}</Badge>
  ) : todayCheckedIn === false ? (
    <Badge variant="warning" className={chipClass}>{t("wbAccounts.card.notCheckedIn")}</Badge>
  ) : todayCheckedIn === true ? (
    <Badge variant="success" className={chipClass}><CircleCheck /> {t("wbAccounts.card.checkedIn")}</Badge>
  ) : null;

  const statusChips = (
    <>
      {/* 顺序照原型 `.acct-chips`（`buddy-switch-prototype.html:2505-2508`）：
          `使用中 N 个工具` → `状态` → `X 积分 N 天后过期` → `优先`。 */}
      {activeProductCount >= 2 && (
        <Badge variant="info" className={chipClass}>
          <CircleCheck /> {t("wbAccounts.card.toolsInUse", { n: activeProductCount })}
        </Badge>
      )}
      {statusChip}
      {travelChip(travelStatus)}
      {expiringChip}
      {nearestChip}
      {creditPriority && (
        <Badge variant="info" className={chipClass} title={t("wbAccounts.card.priorityTip")}>
          {t("wbAccounts.card.priority")}
        </Badge>
      )}
    </>
  );

  /* 程序位行（**单一定义**，页脚程序位行 —— 见文件头）。
     ⚠️ 尺寸与形状对齐原型 `.prog`（`buddy-switch-prototype.html:345-357`）：
     高 26px、内边距 0 8px、**圆角 8px（不是胶囊）**、字号 11px、图标 12px。
     ⚠️ 圆角必须写**字面 8px**：本主题里 `rounded-lg` = `--radius` = 12px、`rounded-xl` = 16px，
     都不是原型的 8px —— 26px 的方块配 12px 圆角会「近似圆形」，与截图明显不同。 */
  const btnSize = "sm" as const;
  const btnClass =
    "h-[26px] gap-1 rounded-[8px] border-border bg-transparent px-2 text-[11px] !font-normal text-muted-foreground";

  /**
   * 程序位按钮的**内容** —— 严格照原型 `.prog`（`buddy-switch-prototype.html:2530`）：
   * `${on ? ICON.check : ""}${pg.short}` —— **短名是纯文字，没有产品图标**。
   */
  const progLabel = (text: string) => <span>{text}</span>;

const workbuddyControl = workbuddyActive ? (
    <ProductCurrentState product="workbuddy" short="WB" />
  ) : demoModeEnabled ? (
    <DemoAction>
      <Button variant="outline" size={btnSize} className={btnClass} aria-label={t("wbAccounts.card.setCurrentWorkbuddy")}>
        {progLabel("WB")}
      </Button>
    </DemoAction>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size={btnSize} className={btnClass} disabled={featuresDisabled || !onSwitch} onClick={() => onSwitch?.(account)} aria-label={t("wbAccounts.card.setCurrentWorkbuddy")}>
          {progLabel("WB")}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t("wbAccounts.card.setCurrentWorkbuddyRestart")}</TooltipContent>
    </Tooltip>
  );

  // CodeBuddy IDE：未检测到 → **引导设置**（不摆一枚点不动的灰按钮）。
  const ideControl = codebuddyCnIdeActive ? (
    <ProductCurrentState product="codebuddy-cn" short="IDE" />
  ) : codebuddyCnIdeAvailable ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size={btnSize} className={btnClass} disabled={featuresDisabled || !onSwitchCodebuddyCnIde || codebuddyCnIdeBusy} onClick={() => onSwitchCodebuddyCnIde?.(account)} aria-label={codebuddyCnIdeLoading ? t("wbAccounts.card.switchingIde") : t("wbAccounts.card.switchIde")} aria-busy={codebuddyCnIdeLoading}>
          {codebuddyCnIdeLoading ? <Loader2 className="size-4 animate-spin" /> : null}
          {progLabel(codebuddyCnIdeLoading ? t("wbAccounts.card.switching") : "IDE")}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t("wbAccounts.card.switchIdeRestart")}</TooltipContent>
    </Tooltip>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size={btnSize} className={cn(btnClass, OFF_PROGRAM_CLASS)} disabled={featuresDisabled || !onGuideToSetting} onClick={() => onGuideToSetting?.("ide")} aria-label={t("wbAccounts.card.guideIdeSetting")}>
          {progLabel("IDE")}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t("wbAccounts.card.guideIdeSetting")}</TooltipContent>
    </Tooltip>
  );

  const cliControl = codebuddyCliGatewayMode ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", btnClass)}>
          <Button
            variant="outline"
            size={btnSize}
            className="opacity-50"
            disabled
            aria-label={t("wbAccounts.card.cliGatewayMode")}
          >
            {progLabel("CLI")}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{t("wbAccounts.card.cliGatewayMode")}</TooltipContent>
    </Tooltip>
  ) : codebuddyCliActive ? (
    <ProductCurrentState product="codebuddy" short="CLI" />
  ) : codebuddyCliConfigured ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size={btnSize} className={btnClass} disabled={featuresDisabled || !onSwitchCodebuddyCli || codebuddyCliBusy} onClick={() => onSwitchCodebuddyCli?.(account)} aria-label={codebuddyCliLoading ? t("wbAccounts.card.switchingCli") : t("wbAccounts.card.setCurrentCli")} aria-busy={codebuddyCliLoading}>
          {codebuddyCliLoading ? <Loader2 className="size-4 animate-spin" /> : null}
          {progLabel(codebuddyCliLoading ? t("wbAccounts.card.switching") : "CLI")}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t("wbAccounts.card.setCurrentCli")}</TooltipContent>
    </Tooltip>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size={btnSize} className={cn(btnClass, OFF_PROGRAM_CLASS)} disabled={featuresDisabled || !onGuideToSetting} onClick={() => onGuideToSetting?.("cli")} aria-label={t("wbAccounts.card.guideCliSetting")}>
          {progLabel("CLI")}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t("wbAccounts.card.guideCliSetting")}</TooltipContent>
    </Tooltip>
  );

  function pluginControl(opts: {
    /** 程序位 id（供 `onGuidePlugin` 与门禁锚点使用）。 */
    id: string;
    /** 短标签（与 IDE / CLI 的写法一致）。 */
    short: string;
    /** 程序位显示名（词条）—— 与注册表 `labelKey` 同一份文案。 */
    label: string;
    available?: boolean;
    active?: boolean;
    busy?: boolean;
    loading?: boolean;
    onSwitch?: (a: AccountMeta) => void;
  }) {
    const { id, short, label, available, active, busy, loading, onSwitch } = opts;
    if (active) {
      return (
        <span
          role="status"
          aria-label={t("wbAccounts.card.currentPlugin", { client: label })}
          title={t("wbAccounts.card.currentPlugin", { client: label })}
          className={cn(
            /* 与 `ProductCurrentState` 同一口径（同底色/描边，去掉了硬编码内阴影）。 */
            "inline-flex items-center justify-center border border-primary/40 bg-primary/18 text-primary font-semibold",
            /* 与 `ProductCurrentState` 同一口径：26px / 圆角 8px。 */
            "h-[26px] gap-1 rounded-[8px] px-2 text-[11px]",
          )}
        >
          <Check className="size-3" strokeWidth={2.25} />
          <span>{short}</span>
        </span>
      );
    }
    if (available) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size={btnSize}
              className={btnClass}
              disabled={featuresDisabled || !onSwitch || busy}
              onClick={() => onSwitch?.(account)}
              aria-label={loading ? t("wbAccounts.card.switching") : label}
              aria-busy={loading}
              data-program-switch={id}
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {progLabel(loading ? t("wbAccounts.card.switching") : short)}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size={btnSize}
            className={cn(btnClass, OFF_PROGRAM_CLASS)}
            disabled={featuresDisabled || !onGuidePlugin}
            onClick={() => onGuidePlugin?.(id)}
            aria-label={t("wbAccounts.card.guidePlugin", { client: label })}
            data-program-missing={id}
          >
            {progLabel(short)}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("wbAccounts.card.guidePlugin", { client: label })}</TooltipContent>
      </Tooltip>
    );
  }

  const vscodePluginControl = pluginControl({
    id: "vscode_codebuddy_plugin",
    short: "VSC",
    label: t("wbAccounts.program.vscodeCodebuddyPlugin"),
    available: vscodePluginAvailable,
    active: vscodePluginActive,
    busy: vscodePluginBusy,
    loading: vscodePluginLoading,
    onSwitch: onSwitchVscodePlugin,
  });

  const jetbrainsPluginControl = pluginControl({
    id: "jetbrains_codebuddy_plugin",
    short: "JB",
    label: t("wbAccounts.program.jetbrainsCodebuddyPlugin"),
    available: jetbrainsPluginAvailable,
    active: jetbrainsPluginActive,
    busy: jetbrainsPluginBusy,
    loading: jetbrainsPluginLoading,
    onSwitch: onSwitchJetbrainsPlugin,
  });

  const plannedControls = PLANNED_PROGRAMS.map((p) => (
    <Tooltip key={p.id}>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size={btnSize}
          className={cn(btnClass, PLANNED_PROGRAM_CLASS)}
          disabled
          data-program-planned={p.id}
          aria-label={`${t(p.labelKey)}（${t("wbAccounts.program.plannedHint")}）`}
        >
          <Ban className="size-4" />
          {progLabel(t(p.labelKey))}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t("wbAccounts.program.plannedHint")}</TooltipContent>
    </Tooltip>
  ));

  const programRow = (
    <div className="flex w-full flex-wrap items-center gap-1">
      {workbuddyControl}
      {ideControl}
      {cliControl}
      {/* 编辑器内 CodeBuddy 插件（VS Code / JetBrains）：与 IDE 同构的三个档位。 */}
      {vscodePluginControl}
      {jetbrainsPluginControl}
      {plannedControls}
    </div>
  );

  const checkbox = (
    <Checkbox
      checked={selected}
      onCheckedChange={() => onToggleSelect?.(account)}
      disabled={!onToggleSelect}
      aria-label={t("wbAccounts.card.selectAria", { name })}
      className="size-[17px]"
    />
  );

  const menu = demoModeEnabled ? (
    <AccountMoreMenuDemo />
  ) : (
    <AccountMoreMenu
      accountName={name}
      onRefreshPart={onRefreshPart ? (kind) => onRefreshPart(account, kind) : undefined}
      refreshingKinds={refreshingKinds}
      doneKinds={doneKinds}
      refreshKinds={refreshKinds}
      onRefresh={onRefresh ? () => onRefresh(account) : undefined}
      todayCheckedIn={todayCheckedIn}
      expired={expired}
      needsRelogin={account.needsRelogin}
      onCheckin={onCheckin ? () => onCheckin(account) : undefined}
      onExport={onExport ? () => onExport(account) : undefined}
      onDelete={() => onDelete(account)}
      featuresDisabled={featuresDisabled}
    />
  );

  return (
    <TooltipProvider>
      <article
        tabIndex={0}
        role="article"
        onClick={(e) => {
          if (!onOpenDetail) return;
          if (!shouldOpenAccountDetail(e)) return;
          onOpenDetail(account);
        }}
        onKeyDown={(e) => {
          if (!onOpenDetail || e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenDetail(account);
          }
        }}
        className={cn(
          "relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-lg border border-border bg-card px-3.5 py-[13px] shadow-card transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          selected && "border-ring bg-primary/[0.07]",
        )}
      >
      {/* ★ 原型 `.acct.is-current::before`（`buddy-switch-prototype.html:321-324`）：
          「当前账号」用**左侧 3px 竖条**表达 —— 与头部的「当前登录」徽章一起构成两重信号。
          ⚠️ 竖条只在**左侧两条圆角**上贴合卡片（`rounded-l-lg`），否则四角会露出直角方块。
          ⚠️ 条件必须与徽章**同为** `isCurrentAccount`（绑定任一程序位）：两者是同一信号的两重表达，
          否则会出现「有徽章却无竖条」/「有竖条却无徽章」的矛盾态。 */}
      {isCurrentAccount ? (
        <span
          aria-hidden="true"
          data-current-bar="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-l-lg bg-primary"
        />
      ) : null}
      {/* ★ 原型 `.acct-top`（`buddy-switch-prototype.html:326`）：
         `display:flex; align-items:center; gap:10px` —— **就是一行**，且**没有底色**。
         ⚠️ 2026-10-10：删掉了原先那条头部底色带（`bg-primary/5` / `bg-muted/30`）与幽灵水印。
         原型 `.acct-top` 是**透明的**，整张卡一个底色；那条底色带把它变成了一条「页眉」，
         还让卡片看起来被切成了两半。 */}
      <header className="flex items-center gap-2.5">
        {/* ⚠️ `...` 菜单**不在这里** —— 原型把它放在 `.acct-actions` 里（程序位行右侧），
            见本文件末尾的页脚 `{menu}`。 */}
        {/* ★ 原型 `.acct-top` 的**四件套，顺序与嵌套完全一致**（`buddy-switch-prototype.html:2499-2503`）：
           `[勾选] [头像32] [.acct-id：昵称 + 身份] [当前登录徽章]`。
           ⚠️★ 2026-10-10 两处修正：
             ① 徽章**移出 `.acct-id`**、回到 `.acct-top` 的**直接子级** —— 原型的徽章是
                行尾、**垂直居中**的独立件，不是昵称那一行里的小尾巴（截图对比一眼可见）；
             ② 状态标签**移出头部** —— 原型里 `.acct-chips` 是 `.acct-top` 的**兄弟块**
                （卡片是 4 个块），不是塞在头像右侧的第三行。 */}
        <div className="relative z-10 flex w-full min-w-0 items-center gap-2.5">
          {checkbox}
          {/* 原型 `.avatar`（`demo.css:308-311`）：32px / 圆角 10px / `12.5px` / `640` /
              **字色近白**（`oklch(0.99 0 0)`）。
              ⚠️ 首字取**前 2 位**（原型 `initials()`，`buddy-switch-prototype.html:1929`）——
              单字在「jacky / spare-global」这类名字下辨识度明显不足。*/}
          <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-[10px] text-[12.5px] font-[640]", AVATAR_TEXT_CLASS, avatarClass)}>
            {accountInitials(name)}
          </div>
          {/* `.acct-id`：`min-width:0; flex:1`，昵称 13px/600、身份 11px muted（均单行省略）。 */}
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[13px] font-semibold" title={name}>{name}</h3>
            <p className="truncate text-[11px] text-muted-foreground" title={identity}>{identity}</p>
          </div>
          {currentLoginBadge}
        </div>
      </header>

      {/* ★ 原型 `.acct-chips`（`buddy-switch-prototype.html:341`）：`flex-wrap; gap:5px`，
          是 `.acct-top` 的**兄弟块**（不是头部里的一行）。 */}
      <div className="flex min-w-0 flex-wrap items-center gap-[5px]">{statusChips}</div>

      {/* ⚠️ 内边距与块间距都已在**根**上（`px-3.5 py-[13px] gap-2.5`，照原型 `.acct`），
          这里不再自带 padding —— 否则块间距会变成「根 gap + 自己的 mt」两份叠加。 */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* ★ 指标行（原型 `.acct-metrics` :2510）：徽章之下、积分明细之上的一行小字。
            始终渲染 —— 积分未就绪时显示「—」，不闪不藏。 */}
        {creditHeadline}
        {metricsRow}
        {creditLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("wbAccounts.card.loadingCredits")}</div>
        ) : !credit ? (
          <div className="py-3 text-sm text-muted-foreground">{t("wbAccounts.card.waitingCredits")}</div>
        ) : !credit.ok ? (
          credit.reason === ENCRYPTED_CREDENTIAL_REASON ? (
            <div className="min-w-0 py-3 text-sm text-destructive">
              <div className="flex items-start gap-2">
                <Coins className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 flex-1">{credit.error || t("wbAccounts.card.creditFailed")}</span>
              </div>
              {onAddPlaintextAccount && (
                <div className="mt-2.5 pl-6">
                  <Button size="sm" variant="outline" onClick={onAddPlaintextAccount}>
                    <QrCode />
                    {t("wbAccounts.card.addPlaintextAccount")}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2 py-3 text-sm text-destructive" title={credit.error}>
              <Coins className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{credit.error || t("wbAccounts.card.creditFailed")}</span>
            </div>
          )
        ) : null}
      </section>

      {/* ★ 原型 `.acct-actions`（`buddy-switch-prototype.html:343` / `accountCard` :2515-2534）：
         `display:flex; align-items:center; gap:6px; padding-top:10px; border-top:1px solid var(--border)`
         ⇒ 页脚 = **程序位行（`flex:1`）+ 「更多」按钮**（菜单在**这里**，不是头部）。
         ⚠️ 不再自带左右内边距：原型 `.acct` 的 `padding:13px 14px` 已在卡片根上，
         页脚的 `border-top` 因此与内容同宽（原型也如此）。 */}
      <footer className="flex items-center gap-1.5 border-t border-border pt-2.5">
        {programRow}
        {menu}
      </footer>
      </article>
    </TooltipProvider>
  );
}
