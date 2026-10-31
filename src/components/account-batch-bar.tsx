import { CircleCheck, Download, Loader2, RefreshCw, Trash2, XIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface AccountBatchBarProps {
  /** 已选数量；`<= 0` 时整个条不渲染。 */
  selectedCount: number;
  /** 任一批量动作进行中（禁用所有动作，避免并发）。 */
  busy?: boolean;
  onCheckin?: () => void;
  onRefresh?: () => void;
  /** 导出所选账号（原型 `batch-export`：批量条上的第四个动作）。 */
  onExport?: () => void;
  onDelete?: () => void;
  /** 清除选择（必填：这是「退出选择模式」的唯一出口）。 */
  onClear: () => void;
}

export function AccountBatchBar({
  selectedCount,
  busy = false,
  onCheckin,
  onRefresh,
  onExport,
  onDelete,
  onClear,
}: AccountBatchBarProps) {
  const t = useT();
  if (selectedCount <= 0) return null;

  return (
    <div
      className="mb-3 flex min-w-0 w-full items-center gap-2.5 rounded-lg border border-primary/35 px-3.5 py-2.5"
      style={{ background: "color-mix(in oklab, var(--primary) 10%, var(--card))" }}
    >
        <Badge variant="secondary" className="tabular-nums">
          {t("shared.batch.selected", { n: selectedCount })}
        </Badge>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        {onRefresh && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={busy}
            onClick={onRefresh}
          >
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t("shared.batch.refresh")}
          </Button>
        )}
        {onCheckin && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={busy}
            onClick={onCheckin}
          >
            <CircleCheck />
            {t("shared.batch.checkin")}
          </Button>
        )}
        {onExport && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={busy}
            onClick={onExport}
          >
            <Download />
            {t("shared.batch.export")}
          </Button>
        )}
        {onDelete && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-8 rounded-full px-3 text-xs text-destructive hover:bg-destructive/5 hover:text-destructive")}
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 />
            {t("shared.batch.delete")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-0.5 size-8 rounded-full text-muted-foreground hover:text-foreground"
          onClick={onClear}
          aria-label={t("shared.batch.clear")}
          title={t("shared.batch.clear")}
        >
          <XIcon />
        </Button>
    </div>
  );
}
