export type ThemePreference = "system" | "light" | "dark" | "black";

export const THEME_PREFERENCES = ["system", "light", "dark", "black"] as const satisfies readonly ThemePreference[];

/**
 * 偏好 → 词条键。**顶栏菜单与设置页下拉共用这一份**，不要在组件里再各写一套
 * （之前两处各自硬编码，加一种主题要改两位、且极易只改一处）。
 */
export const THEME_LABEL_KEYS = {
  system: "appSettings.theme.system",
  light: "appSettings.theme.light",
  dark: "appSettings.theme.dark",
  black: "appSettings.theme.black",
} as const satisfies Record<ThemePreference, string>;

const THEME_STORAGE_KEY = "buddy-switch.theme";
const LEGACY_DARK_STORAGE_KEY = "buddy-switch.dark";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value !== null && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(stored)) return stored;

    const legacyDark = localStorage.getItem(LEGACY_DARK_STORAGE_KEY);
    if (legacyDark === "1") return "dark";
    if (legacyDark === "0") return "light";
  } catch {
    // 存储不可用时仍可跟随系统主题。
  }

  return "system";
}

export function applyTheme(preference: ThemePreference) {
  const black = preference === "black";
  const dark =
    black ||
    preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("black", black);
}

export function setThemePreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
    localStorage.removeItem(LEGACY_DARK_STORAGE_KEY);
  } catch {
    // 存储不可用时仍立即应用当前选择。
  }
  applyTheme(preference);
}

export function watchSystemTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getThemePreference() === "system") applyTheme("system");
  };

  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
