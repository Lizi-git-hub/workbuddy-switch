
import { SideSubnav, type SideSubnavItem } from "@/components/shell/side-subnav";
import { useT } from "@/lib/i18n";

/** 设置分区的标识。 */
export type SettingsSubnavId =
  | "general"
  | "account"
  | "checkin"
  | "schedule"
  | "client"
  | "network"
  | "cli"
  | "diagnostics"
  | "logs"
  | "backup";

export type SettingsSubnavItem = SideSubnavItem<SettingsSubnavId>;

/** 唯一的一份子导航表（顺序即展示顺序）。 */
export const SETTINGS_SUBNAV: readonly SettingsSubnavItem[] = [
  { id: "general", labelKey: "settings.subnav.general" },
  { id: "account", labelKey: "settings.subnav.account" },
  { id: "checkin", labelKey: "settings.subnav.checkin" },
  { id: "schedule", labelKey: "settings.subnav.schedule" },
  { id: "client", labelKey: "settings.subnav.client" },
  { id: "network", labelKey: "settings.subnav.network" },
  { id: "cli", labelKey: "settings.subnav.cli" },
  { id: "diagnostics", labelKey: "settings.subnav.diagnostics" },
  { id: "logs", labelKey: "settings.subnav.logs" },
  { id: "backup", labelKey: "settings.subnav.backup" },
];

/** 从 URL 段解析设置分区（非法值 fail-closed 回 `general`，不把任意串塞进 state）。 */
export function parseSettingsSubnav(raw: string | null): SettingsSubnavId {
  return SETTINGS_SUBNAV.some((item) => item.id === raw) ? (raw as SettingsSubnavId) : "general";
}

interface Props {
  active: SettingsSubnavId;
  onSelect: (id: SettingsSubnavId) => void;
  /** 覆盖表（默认用 `SETTINGS_SUBNAV`）；Trae 设置页若复用可传自己的表。 */
  items?: readonly SettingsSubnavItem[];
  className?: string;
}

/**
 * 设置子导航（版式由 `SideSubnav` 统一提供，这里只钉住自己的**表**与**无障碍名**）。
 */
export function SettingsSubnav({ active, onSelect, items = SETTINGS_SUBNAV, className }: Props) {
  const t = useT();
  return (
    <SideSubnav
      active={active}
      items={items}
      onSelect={onSelect}
      ariaLabel={t("settings.subnav.aria")}
      className={className}
    />
  );
}
