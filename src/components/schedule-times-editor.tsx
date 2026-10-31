import { useState } from "react";

import { Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n";

/** `HH:MM`（00:00–23:59）。与后端 `schedule::TimeOfDay` 的线上格式**逐字一致**。 */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 抖动幅度选项（分钟）。`0` = 关闭。
 *
 * 只给三档而不是自由输入：抖动是「错开同一分钟」的微调，档位太多只会让人纠结；
 * 后端接受 `0..=60` 的任意整数（老配置里可能有别的值），因此若当前值不在这三档里，
 * 会**动态补进选项**（见 `jitterOptions`）—— 否则 Select 会显示空白，看起来像没读到配置。
 */
const JITTER_OPTIONS = [0, 5, 15, 30];

/** 时点表的排序键：自 00:00 起的分钟数（`"09:37"` → 577）。 */
function minutesOf(time: string): number {
  const [hour, minute] = time.split(":");
  return Number(hour) * 60 + Number(minute);
}

export function TimesEditor({
  id,
  times,
  jitter,
  disabled,
  onChange,
  onJitterChange,
}: {
  id: string;
  times: string[];
  /** 抖动幅度（分钟，`0` = 不抖动）。与 `times` 一起决定「下一次几点触发」。 */
  jitter: number;
  disabled?: boolean;
  onChange: (times: string[]) => void;
  onJitterChange: (minutes: number) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 三档之外的值（老配置 / 手改文件）也要能显示出来，故动态补齐并保持升序。 */
  const jitterOptions = JITTER_OPTIONS.includes(jitter)
    ? JITTER_OPTIONS
    : [...JITTER_OPTIONS, jitter].sort((a, b) => a - b);

  function add() {
    const value = draft.trim();
    if (!TIME_PATTERN.test(value)) {
      setError(t("wbSettings.schedule.timeInvalid"));
      return;
    }
    if (times.includes(value)) {
      setError(t("wbSettings.schedule.timeDuplicate", { time: value }));
      return;
    }
    setError(null);
    setDraft("");
    onChange([...times, value].sort((a, b) => minutesOf(a) - minutesOf(b)));
  }

  return (
    <div className="flex w-full flex-col items-end gap-2 sm:w-auto">
      <div className="flex w-full flex-wrap items-center justify-end gap-1.5">
        {times.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("wbSettings.schedule.timeEmpty")}</span>
        ) : (
          times.map((time) => (
            <Badge key={time} variant="secondary" className="gap-1 pr-1 font-mono">
              {time}
              <button
                type="button"
                aria-label={t("wbSettings.schedule.timeRemoveAria", { time })}
                className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                disabled={disabled}
                onClick={() => onChange(times.filter((value) => value !== time))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))
        )}
      </div>
      <div className="flex w-full items-center justify-end gap-2">
        {/* `type="time"` + `step=60`：秒被隐藏，值恒为 `HH:MM`（带秒时浏览器会给出
            `HH:MM:SS`，那是后端认不出的格式，故必须显式设 step）。 */}
        <Input
          id={id}
          className="w-full sm:w-32"
          type="time"
          step={60}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" size="sm" variant="outline" onClick={add} disabled={disabled}>
          <Plus />
          {t("wbSettings.schedule.timeAdd")}
        </Button>
      </div>
      {/* 抖动与「什么时候触发」是同一件事的两半，放在同一个控件里：
          分成两处设置，用户很难意识到「09:00 + ±15 分钟」才是实际触发区间。 */}
      <div className="flex w-full items-center justify-end gap-2">
        <span className="text-[11.5px] text-muted-foreground">{t("wbSettings.schedule.jitterLabel")}</span>
        <Select
          value={String(jitter)}
          disabled={disabled}
          onValueChange={(value) => onJitterChange(Number(value))}
        >
          <SelectTrigger size="sm" className="w-[104px]" aria-label={t("wbSettings.schedule.jitterAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {jitterOptions.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {minutes === 0
                  ? t("wbSettings.schedule.jitterOff")
                  : t("wbSettings.schedule.jitterOption", { minutes })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
