/**
 * 账号列表的**共享零件**（三平台共用：WorkBuddy / Trae / Qoder）。
 *
 * ## 为什么单独一个文件
 *
 * 本次重构的目标是「用原型统一 WorkBuddy 与 Trae 两个平台的交互」。逐项核对后发现：
 * 工具栏 / 表格 / 批量条 / 抽屉四个「壳」早已共用，但**骨架屏、批量签到结果条、分组标题**
 * 三处仍是两平台各写一版 —— 于是同一个页面在两个分区里长得不一样。
 *
 * 这三处都**没有平台差异**（差异只在数据），因此收进这里共用；页面只负责喂数据。
 *
 * ⚠️ 本文件内**禁止**出现 `platform === ...` 判断 —— 与 `account-toolbar.tsx` 同一条纪律。
 */

import { CircleCheck, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { AVATAR_TEXT_CLASS, accountInitials, avatarTone } from "@/components/account-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n";
import { useRefreshAction } from "@/lib/use-refresh-action";
import { cn } from "@/lib/utils";

export function AccountsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div
      className="grid grid-cols-1 gap-3 min-[761px]:grid-cols-2 min-[1101px]:grid-cols-3"
      aria-busy="true"
    >
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-44 w-full rounded-lg" />
      ))}
    </div>
  );
}

export function AccountsGroupHeader({ label, count }: { label: string; count: number }) {
  const t = useT();
  return (
    <div className="mb-2.5 mt-[18px] flex items-center gap-2">
      <Badge variant="secondary" className="border-transparent bg-muted font-medium text-foreground">
        {label}
      </Badge>
      <span className="text-[11px] text-muted-foreground">
        {t("shared.list.groupCount", { n: count })}
      </span>
    </div>
  );
}

export function AccountsTableAvatar({ name }: { name: string }) {
  return (
    <span
      className={cn(
        "flex size-[26px] shrink-0 items-center justify-center rounded-[8px] text-[11px] font-[640]",
        AVATAR_TEXT_CLASS,
        avatarTone(name),
      )}
      aria-hidden="true"
    >
      {accountInitials(name)}
    </span>
  );
}

export interface CheckinResultBarProps {
  /** 成功数。 */
  okCount: number;
  /** **失败账号的显示名**（不是 id）—— 由页面装配，本组件只渲染。 */
  failedNames: string[];
  skippedNames?: string[];
  /**
   * 本次**真领到**的额度合计（活动通道专用；其它平台不传）。
   *
   * ⚠️ 可选且**默认为 0/不传** ⇒ 不渲染这枚徽标，WB / Trae 的输出逐字不变。
   * 为什么值得单独显示：历史报障正是「点了签到、界面说成功、额度纹丝不动」，
   * 只说「成功 1 个」不足以证明真的到账。
   */
  earnedCredits?: number;
  /** 有失败项时的「只重试失败项」出口；无失败传 `undefined`（不渲染该按钮）。 */
  onRetry?: () => void | Promise<void>;
  /** 「知道了」：关闭结果条。 */
  onDismiss: () => void;
}

/**
 * 批量签到**结果汇总条**（原型 `checkinResultHtml`，`buddy-switch-prototype.html:2339-2354`）。
 *
 * ## 为什么必须有这条（而不是只弹 toast）
 *
 * 批量操作**必然部分失败**。只用 toast 有两个问题：① 一闪而过，用户来不及看失败的是谁；
 * ② 「一键签到」看起来永远 100% 成功。原型把结果**留在页面上**（工具栏与列表之间的
 * `#batch-slot`），并给出「只重试失败项」与「知道了」两个出口。
 *
 * ⚠️ 位置固定为**工具栏与列表之间**（`role="status"`，不打断读屏）。
 */
export function CheckinResultBar({
  okCount,
  failedNames,
  skippedNames,
  earnedCredits = 0,
  onRetry,
  onDismiss,
}: CheckinResultBarProps) {
  const t = useT();
  /* 「通道未开放」是第三档：既不是成功、也不算失败（重试它永远不会成功）。
     ⚠️ 默认空数组 ⇒ WB / Trae 走的仍是原来那两档分支，渲染逐字不变。 */
  const skipped = skippedNames ?? [];
  const hasFail = failedNames.length > 0;
  const hasSkipped = skipped.length > 0;
  const degraded = hasFail || hasSkipped;
  const { busy, run } = useRefreshAction();

  return (
    <div
      role="status"
      className={cn(
        "mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-2.5",
        degraded
          ? "border-warning/40 bg-warning/[0.07]"
          : "border-primary/35 bg-primary/[0.07]",
      )}
    >
      <Badge
        variant={degraded ? "warning" : "success"}
        className="shrink-0 gap-1 border-transparent"
      >
        {degraded ? <TriangleAlert /> : <CircleCheck />}
        {/* 三档齐全时用 `summary4`（成功 / 未开放 / 失败）；只有两档时沿用旧词条 ⇒
            WB / Trae 的界面输出逐字不变。 */}
        {hasSkipped
          ? t("shared.checkinResult.summary4", {
              ok: String(okCount),
              skip: String(skipped.length),
              fail: String(failedNames.length),
            })
          : t("shared.checkinResult.summary", { ok: okCount, fail: failedNames.length })}
      </Badge>
      {earnedCredits > 0 ? (
        <Badge variant="success" className="shrink-0 tabular-nums border-transparent">
          {t("shared.checkinResult.earned", { n: String(earnedCredits) })}
        </Badge>
      ) : null}
      <span className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">
        {hasFail
          ? t("shared.checkinResult.failedNames", { names: failedNames.join(t("shared.punct.comma")) })
          : hasSkipped
            ? /* ⚠️ 只说「未开放」+ 原因，**不给重试出口**（重试永远不会成功）。
                 账号逐个 toasting 会刷屏，批量场景一律留在这条汇总里。 */
              t("shared.checkinResult.skippedNames", {
                names: skipped.join(t("shared.punct.comma")),
              })
            : t("shared.checkinResult.allOk")}
      </span>
      {hasFail && onRetry ? (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={busy}
          onClick={() => void run(() => onRetry?.())}
        >
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("shared.checkinResult.retryFailed")}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" className="shrink-0" onClick={onDismiss}>
        {t("shared.checkinResult.dismiss")}
      </Button>
    </div>
  );
}
