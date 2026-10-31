import { Check, CircleCheck, CircleSlash, Coins, Ellipsis, Info, KeyRound, Loader2, RefreshCw, Save, StickyNote, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DemoAction } from "@/components/demo-action";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MenuGroupLabel, MenuHead, MenuNote, RefreshMenuGroup } from "@/components/account-menu-parts";
import type { AccountRefreshKind } from "@/lib/account-refresh";
import { shouldOpenAccountDetail } from "@/lib/account-open-guard";
import type { AccountTokenTodayEntry } from "@/lib/types";
import { compactTokens } from "@/components/usage/format";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AVATAR_TEXT_CLASS, accountInitials, avatarTone } from "@/components/account-card";
import { displayText } from "@/lib/display-text";
import { cooldownAgeKey, describeTraeCooldown } from "@/lib/trae-cooldown";
import { EXPIRY_TIP_MAX_HEIGHT, summarizeExpiring } from "@/lib/credit-expiry";
import { formatRelativeTime } from "@/lib/catalog-source";
import { useT, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  TraeAccount,
  TraeCreditPackage,
  TraeJwtStatus,
  TraeProgramId,
  TraeRegionId,
  TraeVariantId,
} from "@/lib/trae-types";

/* 与 WB 卡片同一处理：几何交给 `Badge` 基础样式（已逐值对齐原型 `.badge`），
   这里只抵消它的 1px 透明边框（原型 `.badge` 没有边框）。 */
const chipClass = "border-0 px-[7px] font-medium";

/** 剩余小时数 → 可读文案。 */
export function hoursText(hours: number | null, t: Translate): string {
  if (hours === null || !Number.isFinite(hours)) return t("trae.comp.card.hours.unknown");
  if (hours <= 0) return t("trae.comp.card.hours.expired");
  if (hours < 1) return t("trae.comp.card.hours.minutes", { count: Math.round(hours * 60) });
  if (hours < 48) return t("trae.comp.card.hours.hours", { count: hours.toFixed(1) });
  return t("trae.comp.card.hours.days", { count: Math.floor(hours / 24) });
}

/** Unix 秒 → `MM-DD HH:mm`。 */
export function shortTime(seconds: number | null): string {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** JWT 状态 → Badge 变体与文案。 */
export function jwtBadge(status: TraeJwtStatus, hours: number | null, t: Translate) {
  switch (status) {
    case "ok":
      return {
        variant: "secondary" as const,
        className: "",
        text: t("trae.comp.card.jwt.valid", { hours: hoursText(hours, t) }),
      };
    case "warn":
      return {
        variant: "secondary" as const,
        className: "bg-warning/15 text-warning",
        text: t("trae.comp.card.jwt.warn", { hours: hoursText(hours, t) }),
      };
    case "expired":
      return { variant: "destructive" as const, className: "", text: t("trae.comp.card.jwt.expired") };
    default:
      return { variant: "outline" as const, className: "", text: t("trae.comp.card.jwt.unparsable") };
  }
}

/** 数字 → 千分位字符串（`null` / 非有限值回落 `—`）。导出给账号页装配 `DetailPack` 复用，避免两处格式化漂移。 */
export function formatCredits(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

/**
 * 到期日**只到日**（`MM/DD`）—— 指标行专用。
 *
 * ⚠️ 只返回日期本身：指标行的标签已经写了「到期」，若值再带后缀就成了
 * 「到期 10/03 到期」。原型 `.acct-metrics` 的值也是**纯值**（标签在行内）。
 */
export function formatExpiryDate(seconds: number | null): string | null {
  if (!seconds) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

/**
 * 一个「Trae 程序」维度：该账号可以在哪条 Trae 产品线上启用。
 *
 * ## 与 WorkBuddy 卡片的关系
 *
 * WorkBuddy 的账号卡片头部有一排**工具切换按钮**（WorkBuddy / CodeBuddy IDE /
 * CodeBuddy CLI）——同一个账号可以分别被设为这几个客户端各自的当前账号。
 * Trae 侧的对应物就是本类型：本机装着的每条 Trae 产品线（Trae Work / Trae CN）
 * 都是一枚按钮，账号可以分别在这两条线上启用。
 *
 * 两者是**同一个交互**，不是「Trae 抄 WorkBuddy 的外观」：用户学会
 * 「卡片右上角那排图标 = 把这个账号挂到哪个客户端上」之后，两个分区行为一致。
 */
export interface TraeProgram {
  region: TraeRegionId;
  /** 切换目标（区域限定，后端 `TraeProgramStatus.variant`）—— 真正喂给 `traeSwitchAccount` 的值。 */
  variant: TraeVariantId;
  program: TraeProgramId;
  /** 展示名（`Trae Work` / `Trae CN`），取自后端 `variantLabel`。 */
  label: string;
  /** 本机是否检测到该程序（未检测到时按钮禁用，理由写进 tooltip）。 */
  installed: boolean;
  hasDataDir: boolean;
  /** 该账号是否正是这个程序的当前账号（由该线登录态快照的 `currentAccount` 判定）。 */
  current: boolean;
}

interface Props {
  account: TraeAccount;
  /** 是否为**当前管理的这条产品线**的当前账号（头部高亮 + 幽灵 logo 用它）。 */
  current?: boolean;
  /**
   * 该账号可启用的 Trae 程序（**跨全部区域**，每个 `(region, program)` 一条）。
   *
   * 未传或为空时不渲染任何程序控件——这比渲染一枚「Trae」通用按钮诚实：
   * 后者在两条线并存时根本无法表达「点下去是挂到哪条线上」。
   */
  programs?: TraeProgram[];
  /** 当前正在执行的动作 key（`switch-<uid>@<变体>` / `save-<uid>` / …）。 */
  busy?: string | null;
  /** 任一账号正在切换中，用于阻止并发切换。 */
  switchBusy?: boolean;
  /** 演示模式等场景下禁用所有写操作。 */
  featuresDisabled?: boolean;
  onSwitchTo?: (account: TraeAccount, variant: TraeVariantId, label: string) => void;
  /** 单账号签到。 */
  onCheckin?: (account: TraeAccount) => void;
  onRefreshCredits?: (account: TraeAccount) => void;

  /**
   * 单项刷新（积分 / 今日 Token / 签到状态 / 凭据状态）。
   * 不传 ⇒ 菜单保留原来的单项「刷新积分」（向后兼容）；传了 ⇒ 换成四项分组的「刷新」。
   */
  onRefreshPart?: (account: TraeAccount, kind: AccountRefreshKind) => void;
  /** 本账号正在进行中的刷新项。 */
  refreshingKinds?: readonly AccountRefreshKind[];
  /** 刚刚刷新成功（自行淡出）的项，菜单里显示「已更新」。 */
  doneKinds?: readonly AccountRefreshKind[];
  /**
   * 「今日是否已签到」的**局部覆盖**（页面侧刷新签到状态后立即生效）。
   *
   * ⚠️ 为什么不直接改 `account.checkedToday`：那属于账号列表的数据，刷新一个账号
   * 却重取整页会让「点一下刷新」变成整页闪烁；这里把最新事实单独交给卡片渲染。
   */
  checkedTodayOverride?: boolean;
  todayTokens?: AccountTokenTodayEntry | null;
  /** 网关日志的今日部分可能被裁 ⇒ 渲染成「≥N」（下界）。 */
  todayTokensTruncated?: boolean;
  /** 本平台真的能刷的项（缺省四项）；见 `RefreshMenuGroup` 的注释。 */
  refreshKinds?: readonly AccountRefreshKind[];
  onSaveLogin: (account: TraeAccount) => void;
  onRefreshJwt: (account: TraeAccount) => void;
  onClearCooldown: (account: TraeAccount) => void;
  onDelete: (account: TraeAccount) => void;
  /** 是否被勾选（批量操作）。 */
  selected?: boolean;
  onToggleSelect?: (account: TraeAccount) => void;
  /** 打开详情抽屉（抽屉状态由页面持有）。 */
  onOpenDetail?: (account: TraeAccount) => void;
  /** 「更多 → 编辑备注」：打开抽屉并进入编辑态。 */
  onEditRemark?: (account: TraeAccount) => void;
}

/**
 * Trae 账号卡片。
 *
 * 结构与 WorkBuddy 的 `AccountCard` 一一对应（同样的 header/body/footer 三段、
 * 同样的「当前账号」角标与操作菜单），差异只在数据源：
 * Trae 的额度单位是积分、登录凭据是 JWT、切换动作是重启 Trae 客户端。
 *
 * ## P4 卡片瘦身
 *
 * 详情（备注编辑、账号明细）**已迁入共享抽屉**，页脚的「保存登录态 / 刷新 JWT」
 * 两枚按钮收回「更多」菜单（菜单本就有同名项，其说明挂在菜单项的 `title` 上）。
 * 卡片常规可点区只剩：**勾选框 / 程序位行 / 更多菜单**。
 *
 * ## 「挂到哪个程序上」= WorkBuddy 卡片的那排工具按钮
 *
 * WorkBuddy 卡片右上角是三枚工具按钮（WorkBuddy / CodeBuddy IDE / CodeBuddy CLI），
 * Trae 侧就是 {@link TraeProgram} 每枚按钮对应一条 Trae 产品线。**每条产品线各判各的
 * 「当前账号」**：同一个 Trae 账号完全可以同时是 Trae Work 的当前账号与 Trae CN 的
 * 非当前账号，因此每枚按钮必须独立取状态，不能由卡片的 `current` 一刀切。
 */
export function TraeAccountCard({
  account,
  current = false,
  programs = [],
  busy = null,
  switchBusy = false,
  featuresDisabled = false,
  onSwitchTo,
  onCheckin,
  onRefreshCredits,
  onRefreshPart,
  refreshingKinds,
  doneKinds,
  checkedTodayOverride,
  todayTokens,
  todayTokensTruncated,
  refreshKinds,
  onSaveLogin,
  onRefreshJwt,
  onClearCooldown,
  onDelete,
  selected = false,
  onToggleSelect,
  onOpenDetail,
  onEditRemark,
}: Props) {
  const t = useT();
  const remark = displayText(account.remark)?.trim() ?? "";
  const name = displayText(account.name) || `UID · ${account.userId}`;
  const title = remark || name;
  // 忙状态 key 带上变体（`switch-<uid>@<变体>`）：同一账号可能在切另一条线，
  // 只按 uid 判定会把「切 Trae CN 中」的转圈画到 Trae Work 的按钮上。
  const switchKeyPrefix = `switch-${account.userId}@`;
  const switchingVariant: TraeVariantId | null = busy?.startsWith(switchKeyPrefix)
    ? (busy.slice(switchKeyPrefix.length) as TraeVariantId)
    : null;
  const saving = busy === `save-${account.userId}`;
  const refreshingJwt = busy === `jwt-${account.userId}`;
  const refreshingCredits = busy === `credits-${account.userId}`;
  const thawing = busy === `thaw-${account.userId}`;
  const checkingIn = busy === `checkin-${account.userId}`;
  const deleting = busy === `delete-${account.userId}`;
  const hasCredits = account.remainingCredits !== null;

  const activeProgramCount = programs.filter((program) => program.current).length;
  const cooldownDisplay = describeTraeCooldown(account.cooldownType);
  const cooldownAge = cooldownAgeKey(account.cooldownSince);
  const cooldownTip = cooldownDisplay
    ? [
        account.cooldownType,
        account.cooldownUntil
          ? t("trae.comp.card.cooldown.until", { time: shortTime(account.cooldownUntil) })
          : "",
        // 「11 小时前」必须出现：只给 reason 原文，用户会读成「刚才又失败了」。
        cooldownAge ? t(cooldownAge.key, { minutes: cooldownAge.minutes }) : "",
        t(cooldownDisplay.hintKey),
        account.cooldownReason ?? "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  /** 第 2 槽「状态」—— 与原型 `accountStatus()` 同一口径（互斥的一枚）。 */
  const statusChip =
    account.jwtStatus === "expired" ? (
      <Badge variant="destructive" className={chipClass}>
        {t("trae.comp.card.chip.expired")}
      </Badge>
    ) : cooldownDisplay ? (
      <Badge
        variant={cooldownDisplay.tone}
        className={chipClass}
        title={cooldownTip || undefined}
      >
        {t(cooldownDisplay.labelKey)}
      </Badge>
    ) : !(checkedTodayOverride ?? account.checkedToday) ? (
      <Badge variant="warning" className={chipClass}>
        {t("trae.comp.card.chip.unchecked")}
      </Badge>
    ) : (
      <Badge variant="success" className={chipClass}>
        <CircleCheck /> {t("trae.comp.card.chip.checked")}
      </Badge>
    );

  const packsSorted = [...(account.creditPackages ?? [])].sort((left, right) => {
    if (left.expired !== right.expired) return left.expired ? 1 : -1;
    const leftExpiry = left.expireAt ?? Number.POSITIVE_INFINITY;
    const rightExpiry = right.expireAt ?? Number.POSITIVE_INFINITY;
    return leftExpiry - rightExpiry;
  });

  /** 逐包浮层内容：名称 · 剩余/总额 · 到期。标题钉在浮层顶部，列表限高可滚。 */
  const packsTipBody = (rows: readonly TraeCreditPackage[], title: string) => (
    <>
      <div className="sticky -top-2 -mx-3 -mt-2 bg-popover px-3 pb-1 pt-2 font-medium">{title}</div>
      {rows.map((pkg, index) => (
        <div
          key={`${pkg.packageCode ?? pkg.packageName ?? "pack"}-${index}`}
          className="whitespace-nowrap tabular-nums"
        >
          {t(pkg.expired ? "trae.comp.card.packs.lineExpired" : "trae.comp.card.packs.line", {
            name: pkg.packageName ?? pkg.packageCode ?? t("trae.comp.card.packs.unnamed"),
            remaining: formatCredits(pkg.remaining),
            total: formatCredits(pkg.total),
            expire: formatExpiryDate(pkg.expireAt) ?? t("trae.comp.card.expiry.permanent"),
          })}
        </div>
      ))}
    </>
  );

  const expiring = summarizeExpiring(account.creditPackages, { unit: "s" });
  const expiringChip = expiring ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="warning"
          className={chipClass}
          aria-label={t("trae.comp.card.chip.expiring", {
            amount: formatCredits(expiring.total),
            days: expiring.days,
          })}
        >
          {t("trae.comp.card.chip.expiring", { amount: formatCredits(expiring.total), days: expiring.days })}
        </Badge>
      </TooltipTrigger>
      {/* issue #79：逐批明细可能有几十行 ⇒ 限高可滚，标题钉在浮层顶部。
          与 WB 卡片同一处理（`EXPIRY_TIP_MAX_HEIGHT`），见 `account-card.tsx::expiryTipBody`。 */}
      <TooltipContent side="top" style={{ maxHeight: EXPIRY_TIP_MAX_HEIGHT }}>
        {(() => {
          const soon = packsSorted.filter((pkg) => pkg.expiringSoon && !pkg.expired);
          return packsTipBody(
            soon,
            t("trae.comp.card.packs.title", { n: soon.length }),
          );
        })()}
      </TooltipContent>
    </Tooltip>
  ) : null;

  const statusChips = (
    <>
      {activeProgramCount >= 2 && (
        <Badge variant="info" className={chipClass}>
          <CircleCheck /> {t("trae.comp.card.chip.toolsInUse", { n: activeProgramCount })}
        </Badge>
      )}
      {statusChip}
      {expiringChip}
    </>
  );

  /**
   * 程序按钮的 tooltip：**先说清为什么不能点，再说点了会怎样**。
   *
   * 三种不可用/可用形态互斥，顺序即优先级：没装 → 装了但没数据目录 → 可切。
   * 「装了但没数据目录」这一支此前缺失，于是那种按钮被当成可切（报障来源）。
   */
  const switchTooltip = (program: TraeProgram) => {
    // 同 `programControl`：`program.label` 未归一（可能是对象），取不到时回落程序位标识。
    const label = displayText(program.label) || program.variant;
    return !program.installed
      ? t("trae.comp.card.switch.missing", { label })
      : program.hasDataDir
        ? t("trae.comp.card.switch.tip", { label })
        : t("trae.comp.card.switch.noDataDir", { label });
  };

  const canSaveLogin = programs.some((program) => program.current);

  function programControl(program: TraeProgram) {
    const busyHere = switchingVariant === program.variant;
    const key = `${program.region}:${program.variant}`;
    // `program.label` 来自后端（`TraeProgramStatus.variantLabel`），类型声明是 `string`
    // 但运行时可能是对象 ⇒ 直接当 React 子节点会卸载整棵树（白屏）。取不到时回落到
    // **程序位标识**（`variant`），不编造展示名。下面所有用到 label 的地方（子节点 /
    // `title` / `aria-label` 插值）统一走这一个归一值，避免漏网。
    const label = displayText(program.label) || program.variant;
    const short =
      program.program === "trae_code" ? "Code" : program.program === "trae" ? "Trae" : "Work";

    if (program.current) {
      return (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <span
              role="status"
              aria-label={t("trae.comp.card.currentOf", { label })}
              /* 与 `account-card` 的「当前账号」同口径（原型 `.prog.on`，`demo.css:332`：
                 底 primary **18%** + 描边 primary 40% + 字 primary + **字重 600**；
                 硬编码的 `inset 0 1px 0 rgba(255,255,255,.8)` 在深色下是一条刺眼白线）： */
              className="inline-flex h-[26px] items-center gap-1 rounded-[8px] border border-primary/40 bg-primary/18 px-2 text-[11px] font-semibold text-primary"
            >
              <Check className="size-3" strokeWidth={2.25} />
              <span>{short}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{t("trae.comp.card.currentOf", { label })}</TooltipContent>
        </Tooltip>
      );
    }

    const button = (
      <Button
        variant="outline"
        size="sm"
        className="h-[26px] gap-1 rounded-[8px] border-border bg-transparent px-2 text-[11px] !font-normal text-muted-foreground"
        disabled={featuresDisabled || switchBusy || !program.installed || !program.hasDataDir || !onSwitchTo}
        onClick={() => onSwitchTo?.(account, program.variant, label)}
        aria-label={busyHere ? t("trae.comp.card.switch.ariaBusy", { label }) : t("trae.comp.card.switch.aria", { label })}
        aria-busy={busyHere}
      >
        {busyHere ? <Loader2 className="size-3.5 animate-spin" /> : null}
        <span>{busyHere ? t("trae.comp.card.switch.busy") : short}</span>
      </Button>
    );

    return featuresDisabled ? (
      <DemoAction key={key}>{button}</DemoAction>
    ) : (
      <Tooltip key={key}>
        <TooltipTrigger asChild>
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent side="top">{switchTooltip(program)}</TooltipContent>
      </Tooltip>
    );
  }

  /**
   * 程序位行（**单一定义**，页脚程序位行）——与 WorkBuddy 的 `programRow` 同构。
   *
   * ⚠️ `w-full` + `flex-wrap` 与 WorkBuddy 逐字一致：程序位到 4 个（TraeWork / TraeCode ×
   * 两个区域）时不换行会溢出卡片；只加 `min-w-0` 又会让本行收缩到最小内容宽、槽位被压成多行。
   */
  const programRow = (
    <div className="flex w-full flex-wrap items-center gap-1">
      {programs.map(programControl)}
    </div>
  );

  const identity = remark ? `${name} · UID · ${account.userId}` : `UID · ${account.userId}`;

  /* 「当前登录」徽章**单独拆出来**、与昵称同一行（原型 `:2502`）。
     ⚠️ 不能塞进下面的 `statusChips` 行：那会把头部撑成三行（WorkBuddy 侧已踩过）。 */
  const currentLoginBadge = current ? (
    <Badge variant="secondary" className={cn(chipClass, "shrink-0 border-transparent bg-primary/16 text-primary")}>
      {t("trae.comp.card.currentLogin")}
    </Badge>
  ) : null;

  /* 指标行（原型 `.acct-metrics` `:2510`）：与 WorkBuddy 同位置、同字号、同「标签 + 粗体值」形状。
     ⚠️ Trae **没有**「今日 Token」数据源 ⇒ 该项不渲染（不摆一个永远「—」的假指标）；
     取而代之的是 Trae 真实有的「到期」（WorkBuddy 侧对应的是积分包最早到期）。 */
  const updatedSeconds = account.updatedAt ? Math.floor(new Date(account.updatedAt).getTime() / 1000) : null;
  const creditTotal = (() => {
    const pkgs = account.creditPackages ?? [];
    if (pkgs.length === 0) return null;
    const sum = pkgs.reduce((acc, pkg) => acc + pkg.total, 0);
    return sum > 0 ? sum : null;
  })();

  /** 今日 Token 合计（客户端 + 网关；Trae 客户端档恒为 0）。 */
  const todayTokenTotal = (entry: AccountTokenTodayEntry) =>
    entry.clientIn + entry.clientOut + entry.gatewayIn + entry.gatewayOut;

  const lastUpdatedRelative = formatRelativeTime(updatedSeconds === null ? null : updatedSeconds * 1000, t);
  const metricsRow = (
    <div className="flex min-w-0 gap-[14px] text-[11.5px] text-muted-foreground">
      {packsSorted.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default">
              {t("trae.comp.card.metric.credits")}{" "}
              <b className="font-semibold tabular-nums text-foreground">
                {formatCredits(account.remainingCredits)}
              </b>
              {creditTotal === null ? "" : `/${formatCredits(creditTotal)}`}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" style={{ maxHeight: EXPIRY_TIP_MAX_HEIGHT }}>
            {packsTipBody(
              packsSorted,
              t("trae.comp.card.packs.title", { n: packsSorted.length }),
            )}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span>
          {t("trae.comp.card.metric.credits")}{" "}
          <b className="font-semibold tabular-nums text-foreground">
            {formatCredits(account.remainingCredits)}
          </b>
          {creditTotal === null ? "" : `/${formatCredits(creditTotal)}`}
        </span>
      )}
      <span>
        {t("trae.comp.card.metric.expiry")}{" "}
        <b className="font-semibold tabular-nums text-foreground">
          {formatExpiryDate(account.creditsExpireAt) ?? t("trae.comp.card.expiry.permanent")}
        </b>
      </span>
      {todayTokens ? (
        <span title={t("shared.cardMenu.refresh.tokensHint")}>
          {t("shared.stat.tokens")}{" "}
          <b className="font-semibold tabular-nums text-foreground">
            {todayTokensTruncated
              ? t("wbAccounts.card.metric.atLeast", { value: compactTokens(todayTokenTotal(todayTokens)) })
              : compactTokens(todayTokenTotal(todayTokens))}
          </b>
        </span>
      ) : null}
      {lastUpdatedRelative !== null && (
        <span title={t("trae.comp.card.footer.updatedTip")}>{lastUpdatedRelative}</span>
      )}
    </div>
  );

  /* 「更多」菜单（**单一定义**，页脚 `.acct-actions` 用它）——与 WorkBuddy 卡片同形：
     演示模式下包一层 `DemoAction`（控件保持可见可聚焦，点击只解释为什么不可用）。 */
  const menu = featuresDisabled ? (
    <DemoAction>
      <Button variant="ghost" size="sm" className="!px-[10px] text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("trae.comp.card.manage.aria", { name })} title={t("trae.comp.card.manage.title")}>
        <Ellipsis className="size-4" />
      </Button>
    </DemoAction>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="!px-[10px] text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("trae.comp.card.manage.aria", { name })} title={t("trae.comp.card.manage.title")}>
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <MenuHead>{title}</MenuHead>
        <DropdownMenuItem disabled={!onOpenDetail} onSelect={() => onOpenDetail?.(account)}>
          <Info />{t("trae.comp.card.detail.open")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={featuresDisabled || saving || !canSaveLogin}
          onSelect={() => onSaveLogin(account)}
          title={canSaveLogin ? t("trae.comp.card.action.saveTip") : t("trae.comp.card.action.saveNoLogin")}
        >
          <Save />{t("trae.comp.card.menu.save")}
        </DropdownMenuItem>
        {account.hasRefreshToken && (
          <DropdownMenuItem disabled={featuresDisabled || refreshingJwt} onSelect={() => onRefreshJwt(account)} title={t("trae.comp.card.action.refreshJwtTip")}>
            <KeyRound />{t("trae.comp.card.menu.refreshJwt")}
          </DropdownMenuItem>
        )}
        {/* ★ issue #44：菜单里**真的**要有「刷新积分」，卡片上的提示才不是空口指路。
            此前提示文案指向这个菜单项，而菜单里只有「刷新 JWT」 —— 用户点了也不会刷新积分。
            可见入口在下面未查询到积分的那一行，这里补的是「已有积分时也想强制更新」的路径。 */}
        {onRefreshPart ? (
          <RefreshMenuGroup refreshingKinds={refreshingKinds} doneKinds={doneKinds} kinds={refreshKinds} onPick={(kind) => onRefreshPart(account, kind)} />
        ) : (
          <DropdownMenuItem
            disabled={featuresDisabled || refreshingCredits || !onRefreshCredits}
            onSelect={() => onRefreshCredits?.(account)}
            title={t("trae.comp.card.action.refreshCreditsTip")}
          >
            {refreshingCredits ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t("trae.comp.card.menu.refreshCredits")}
          </DropdownMenuItem>
        )}
        <MenuGroupLabel>{t("shared.cardMenu.accountGroup")}</MenuGroupLabel>
        {/* 「手动签到」与 WorkBuddy 卡片菜单同位（刷新之后、删除之前）。
            只在今日未签到时出现：已签到的账号再点一次只会被跳过策略拦下，
            摆一个点不动的入口比不摆更差。 */}
        {!(checkedTodayOverride ?? account.checkedToday) && (
          <DropdownMenuItem disabled={featuresDisabled || checkingIn} onSelect={() => onCheckin?.(account)}>
            <CircleCheck />{t("trae.comp.card.menu.checkin")}
          </DropdownMenuItem>
        )}
        {account.cooldownType && (
          <DropdownMenuItem disabled={featuresDisabled || thawing} onSelect={() => onClearCooldown(account)}>
            <CircleSlash />{t("trae.comp.card.menu.thaw")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={featuresDisabled || !onEditRemark} onSelect={() => onEditRemark?.(account)}>
          <StickyNote />{t("trae.comp.card.menu.remark")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/5 focus:text-destructive"
          disabled={deleting}
          onSelect={() => onDelete(account)}
        >
          <Trash2 />{t("trae.comp.card.menu.delete")}
        </DropdownMenuItem>
              <MenuNote>{t("shared.cardMenu.note")}</MenuNote>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const checkbox = (
    <Checkbox
      checked={selected}
      onCheckedChange={() => onToggleSelect?.(account)}
      disabled={!onToggleSelect}
      aria-label={t("trae.comp.card.selectAria", { name })}
      className="size-[18px]"
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
          「当前账号」用**左侧 3px 竖条**表达 —— 与头部的「当前登录」徽章构成两重信号。
          条件必须与徽章**同为** `current`，否则会出现「有徽章却无竖条」的矛盾态。 */}
      {current ? (
        <span
          aria-hidden="true"
          data-current-bar="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-l-lg bg-primary"
        />
      ) : null}
        <header className="flex items-center gap-2.5">
          {/* ⚠️ `...` 菜单**不在这里** —— 原型把它放在 `.acct-actions` 里（程序位行右侧），
              见页脚 `{menu}`。
              ⚠️ 2026-10-12 按原型删掉了头部底色带（`bg-primary/5` / `bg-muted/30`）与幽灵水印：
              原型 `.acct-top` 是**透明的**，整张卡只有一个底色；底色带把它变成了一条「页眉」，
              还把卡片切成两半。 */}
          {/* 原型 `.acct-top`（`buddy-switch-prototype.html:2499-2503`）的四件套：
             `[勾选] [头像32] [.acct-id：昵称 + 身份] [当前登录徽章]`。
             ⚠️ 徽章是 `.acct-top` 的**直接子级**（行尾独立件），不是昵称那一行里的小尾巴；
             ⚠️ 状态标签**移出头部** —— 原型里 `.acct-chips` 是 `.acct-top` 的**兄弟块**。 */}
          <div className="relative z-10 flex w-full min-w-0 items-center gap-2.5">
            {checkbox}
            {/* 原型 `.avatar`（`demo.css:308-311`）：32px / 圆角 10px / `12.5px` / `640` / 近白字，
                首字取**前 2 位**（`initials()`）。与 WorkBuddy 卡片逐值一致。 */}
            <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-[10px] text-[12.5px] font-[640]", AVATAR_TEXT_CLASS, avatarTone(name))}>
              {accountInitials(name)}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[13px] font-semibold" title={remark ? `${title}（${name}）` : title}>{title}</h3>
              <p className="truncate text-[11px] text-muted-foreground" title={identity}>{identity}</p>
            </div>
            {currentLoginBadge}
          </div>
        </header>

        {/* ★ 原型 `.acct-chips`（`buddy-switch-prototype.html:341`）：`flex-wrap; gap:5px`，
            是 `.acct-top` 的**兄弟块**（卡片共 4 个块），不是塞在头像右侧的第三行。 */}
        <div className="flex min-w-0 flex-wrap items-center gap-[5px]">{statusChips}</div>

        {/* 原型 `.acct-metrics`（`buddy-switch-prototype.html:2510`）：徽章之下的一行小字，
            **始终渲染** —— 取不到的项显示「—」，不闪不藏。
            ⚠️ 2026-10-12 按原型删掉了「大数字行 + 近期到期逐包列表」：原型卡片只有 4 个块
            （`.acct-top` / `.acct-chips` / `.acct-metrics` / `.acct-actions`），逐包明细改由
            **详情抽屉**承载（`TraeAccountsPage` 装配时读 `creditPackages`）。 */}
        <section className="flex min-w-0 flex-1 flex-col">
          {metricsRow}

          {/* 冷却 / 未查询提示：与 WorkBuddy 的积分错误行同形（同一图标位、同一配色语义）。 */}
          {cooldownDisplay ? (
            <div
              className={cn(
                "flex min-w-0 items-center gap-2 py-3 text-sm",
                cooldownDisplay.tone === "destructive" ? "text-destructive" : "text-muted-foreground",
              )}
              title={cooldownTip || undefined}
            >
              <Coins className="size-4 shrink-0" />
              <span className="min-w-0 truncate">
                {/* ★ 相对时间必须在前：11 小时前的 401 与刚刚的失败，用户要做的事完全不同。 */}
                {cooldownAge ? `${t(cooldownAge.key, { minutes: cooldownAge.minutes })} · ` : ""}
                {account.cooldownReason ||
                  t("trae.comp.card.cooldown.fallback", { type: account.cooldownType ?? "" })}
              </span>
            </div>
          ) : !hasCredits ? (
            <div className="flex min-w-0 items-center gap-2 py-3 text-sm text-muted-foreground">
              <Coins className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("trae.comp.card.credits.notQueried")}</span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                disabled={featuresDisabled || refreshingCredits || !onRefreshCredits}
                onClick={() => onRefreshCredits?.(account)}
                title={t("trae.comp.card.action.refreshCreditsTip")}
              >
                {refreshingCredits ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {t("trae.comp.card.credits.refresh")}
              </Button>
            </div>
          ) : null}
        </section>

        {/* 原型 `.acct-actions`（`demo.css:343` / `accountCard` :2515-2534）：
           `display:flex; align-items:center; gap:6px; padding-top:10px; border-top:1px solid var(--border)`
           ⇒ 页脚 = **程序位行（`flex:1`）+ 「更多」按钮**（菜单在**这里**，不是头部）。
           与 WorkBuddy 卡片页脚逐字同构。 */}
        <footer className="flex items-center gap-1.5 border-t border-border pt-2.5">
          {programRow}
          {menu}
        </footer>
      </article>
    </TooltipProvider>
  );
}
