import { Seg } from "@/components/ui/seg";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface RegionBarProps {
  /**
   * 是否**合并**两个区域查看。
   *
   * ⚠️ 这是**布尔**而不是 `RegionFilter` —— 见下方说明：区域不在这里选。
   */
  value: boolean;
  onChange: (next: boolean) => void;
  /** 重新取数中：控件保持可点，仅禁用并给出无障碍提示。 */
  disabled?: boolean;
  className?: string;
}

export function RegionBar({ value, onChange, disabled, className }: RegionBarProps) {
  const t = useT();
  return (
    <Seg
      className={cn("shrink-0", className)}
      value={value ? "all" : "only"}
      onChange={(next) => onChange(next === "all")}
      disabled={disabled}
      ariaLabel={t("shared.region.combine.aria")}
      options={[
        { value: "only", label: t("shared.region.combine.only") },
        { value: "all", label: t("shared.region.combine.all") },
      ]}
    />
  );
}
