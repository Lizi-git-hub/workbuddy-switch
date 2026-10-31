
/** `appSettings` localStorage 段的三个键（顺序即导出顺序）。 */
export const APP_SETTINGS_STORAGE_KEYS = [
  "buddy-switch.language",
  "buddy-switch.theme",
  "buddy-switch:v1:last-scope",
] as const;

export type AppSettingsKey = (typeof APP_SETTINGS_STORAGE_KEYS)[number];

/** 快照：只含**取到的**键（缺省即「该子项未设置」）。 */
export type AppSettingsSnapshot = Partial<Record<AppSettingsKey, string>>;

/**
 * 凭据标记 —— 与后端 `CREDENTIAL_KEYS` 同源（含 snake_case 真实键与加密信封标记）。
 *
 * ⚠️ 这里**只是前端侧的第二道闸**（第一道在后端导出剥离）；前端段本不该有凭据，
 * 这道闸防的是「将来有人把敏感键塞进来」。
 */
const CREDENTIAL_MARKERS = [
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "$wbEncrypted",
] as const;

/** 代理认证形态：`scheme://user:pass@host`（更新代理 URL 可能长这样）。 */
const PROXY_AUTH_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i;

/**
 * 值是否命中凭据判据（标记子串 **或** 代理认证形态）。
 *
 * 导出为公开函数：门禁据此断言「命中即被剥离」这条行为，而不是只断言字符串出现。
 */
export function containsCredential(value: string): boolean {
  if (CREDENTIAL_MARKERS.some((marker) => value.includes(marker))) return true;
  return PROXY_AUTH_PATTERN.test(value);
}

/** 可用的存储（隐私模式 / 未定义时返回 `undefined`，调用方按「无存储」处理）。 */
function safeStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * 读取 localStorage 段。
 *
 * - 缺失的键**不进结果**（不写空串 —— 空串是一个**值**，会被后端当成「用户把语言设成了空」）；
 * - 命中凭据判据的值**跳过**（红线）；
 * - 存储不可用 / 读取抛异常 ⇒ 返回空快照（记不住不影响功能）。
 */
export function readAppSettingsSnapshot(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): AppSettingsSnapshot {
  const out: AppSettingsSnapshot = {};
  if (!storage) return out;
  for (const key of APP_SETTINGS_STORAGE_KEYS) {
    let value: string | null;
    try {
      value = storage.getItem(key);
    } catch {
      continue;
    }
    if (value === null) continue;
    if (containsCredential(value)) continue;
    out[key] = value;
  }
  return out;
}

/** 回写结果：哪些键写成功、哪些被跳过（跳过 = 值非法 / 命中凭据 / 存储不可用）。 */
export interface ApplyResult {
  applied: AppSettingsKey[];
  skipped: AppSettingsKey[];
}

/**
 * 把快照**回写** localStorage（导入侧调用）。
 *
 * 只认 `APP_SETTINGS_STORAGE_KEYS` 里的键：快照里多出来的键**一律忽略**（导入文件可能
 * 来自更高版本，不该让它往本机塞任意键）；值命中凭据判据的也跳过（同读取侧红线）。
 */
export function applyAppSettingsSnapshot(
  snapshot: AppSettingsSnapshot | undefined,
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): ApplyResult {
  const applied: AppSettingsKey[] = [];
  const skipped: AppSettingsKey[] = [];
  if (!snapshot) return { applied, skipped };
  for (const key of APP_SETTINGS_STORAGE_KEYS) {
    const value = snapshot[key];
    if (typeof value !== "string" || containsCredential(value)) {
      if (value !== undefined) skipped.push(key);
      continue;
    }
    if (!storage) {
      skipped.push(key);
      continue;
    }
    try {
      storage.setItem(key, value);
      applied.push(key);
    } catch {
      skipped.push(key);
    }
  }
  return { applied, skipped };
}
