
import type { TranslationKey } from "@/locales/zh";

/** 窗口覆盖的最多日历日 —— 放宽到一年（「最近一年」档 + 自定义都要它）。 */
export const USAGE_WINDOW_MAX_DAYS = 366;

/**
 * 时间窗口。每个 `kind` 是一个**日历档**，只有 `custom` 带起止键。
 *
 * `custom` 的 `from` / `to` 是**闭区间**的本地日期键（`YYYY-MM-DD`，与后端逐日桶同口径）。
 */
export type UsageWindow =
  | { kind: "today" }
  | { kind: "week" }
  | { kind: "lastWeek" }
  | { kind: "month" }
  | { kind: "lastMonth" }
  | { kind: "half" }
  | { kind: "year" }
  | { kind: "custom"; from: string; to: string };

/**
 * 默认窗口 = **今天**。
 *
 * 四个视图（趋势 / 模型 / 会话 / 积分）共用同一份状态，改这里即全部生效。
 */
export const DEFAULT_USAGE_WINDOW: UsageWindow = { kind: "today" };

/** `.seg` 的档位键。**字符串**，可直接当 `Seg` 的 `value`（它的泛型允许 `string`）。 */
export type UsageWindowMode =
  | "today"
  | "week"
  | "lastWeek"
  | "month"
  | "lastMonth"
  | "half"
  | "year"
  | "custom";

/** 档位顺序 —— 参数条按它渲染。 */
export const USAGE_WINDOW_MODES: readonly UsageWindowMode[] = [
  "today",
  "week",
  "lastWeek",
  "month",
  "lastMonth",
  "half",
  "year",
  "custom",
];

const DAY_MS = 24 * 60 * 60 * 1000;

export function dateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 日期键 → 本地零点。⚠️ 不用 `new Date(key)`：那按 **UTC** 解析，会偏一天。 */
function parseKey(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

/** 合法的日期键（`YYYY-MM-DD` 且可解析）。非法 ⇒ `null`（**fail-closed**，不猜）。 */
export function parseDateKey(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = parseKey(value);
  return Number.isNaN(date.getTime()) ? null : dateKey(date);
}

/** 今天（本地）的日期键。 */
export function todayKey(now: number = Date.now()): string {
  return dateKey(new Date(now));
}

/** 本周**周一**（本地）的日期键 —— 「本周 / 上周」两档的锚点。 */
function mondayKey(now: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return dateKey(date);
}

/** 自定义窗口**可选的最早日期**（今天往前 `USAGE_WINDOW_MAX_DAYS - 1` 天）。 */
export function usageWindowEarliestKey(now: number = Date.now()): string {
  return dateKey(new Date(now - (USAGE_WINDOW_MAX_DAYS - 1) * DAY_MS));
}

function clampCustom(
  from: unknown,
  to: unknown,
  now: number,
): { from: string; to: string } {
  const earliest = usageWindowEarliestKey(now);
  const latest = todayKey(now);
  const lo = parseDateKey(from) ?? latest;
  const hi = parseDateKey(to) ?? latest;
  const [left, right] = lo <= hi ? [lo, hi] : [hi, lo];
  return {
    from: left < earliest ? earliest : left,
    to: right > latest ? latest : right,
  };
}

/** 窗口的**闭区间**日期键。 */
export function usageWindowBounds(
  window: UsageWindow,
  now: number = Date.now(),
): { from: string; to: string } {
  const today = todayKey(now);
  switch (window.kind) {
    case "today":
      return { from: today, to: today };
    case "week":
      return { from: mondayKey(now), to: today };
    case "lastWeek": {
      const thisMonday = parseKey(mondayKey(now));
      const lastMonday = new Date(thisMonday.getTime() - 7 * DAY_MS);
      const lastSunday = new Date(thisMonday.getTime() - DAY_MS);
      return { from: dateKey(lastMonday), to: dateKey(lastSunday) };
    }
    case "month": {
      const now_date = new Date(now);
      return {
        from: dateKey(new Date(now_date.getFullYear(), now_date.getMonth(), 1)),
        to: today,
      };
    }
    case "lastMonth": {
      const now_date = new Date(now);
      const first = new Date(now_date.getFullYear(), now_date.getMonth() - 1, 1);
      const last = new Date(now_date.getFullYear(), now_date.getMonth(), 0);
      return { from: dateKey(first), to: dateKey(last) };
    }
    case "half":
      return { from: dateKey(new Date(now - 179 * DAY_MS)), to: today };
    case "year":
      return { from: dateKey(new Date(now - 365 * DAY_MS)), to: today };
    case "custom":
      return clampCustom(window.from, window.to, now);
  }
}

export function usageWindowKeys(window: UsageWindow, now: number = Date.now()): string[] {
  const { from, to } = usageWindowBounds(window, now);
  const keys: string[] = [];
  const cursor = parseKey(from);
  const end = parseKey(to).getTime();
  while (cursor.getTime() <= end && keys.length < USAGE_WINDOW_MAX_DAYS) {
    keys.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys.length > 0 ? keys : [todayKey(now)];
}

/** 窗口覆盖的**日历天数**（≥ 1）—— 「日均」这类分母必须用它，不是「有数据的天数」。 */
export function usageWindowDays(window: UsageWindow, now: number = Date.now()): number {
  return usageWindowKeys(window, now).length;
}

export function usageWindowSpanDays(window: UsageWindow, now: number = Date.now()): number {
  const { from } = usageWindowBounds(window, now);
  const today = parseKey(todayKey(now)).getTime();
  const cursor = parseKey(from);
  let span = 1;
  while (cursor.getTime() < today && span < USAGE_WINDOW_MAX_DAYS) {
    cursor.setDate(cursor.getDate() + 1);
    span += 1;
  }
  return span;
}

/** 窗口当前对应哪一个 `.seg` 档位。 */
export function usageWindowMode(window: UsageWindow): UsageWindowMode {
  return window.kind;
}

/**
 * 档位 → 窗口。
 *
 * ⚠️ `custom` **不是「一按就生效」的档位**（它要开弹层选日期）⇒ 原样返回 `previous`。
 * 参数条在 `Seg` 的 `onChange` 里拦下 `custom` 去开弹层，不会走到这里的 `custom` 分支；
 * 这个分支存在只是为了让映射**全覆盖**（不留 `undefined` 语义）。
 */
export function usageWindowFromMode(
  mode: UsageWindowMode,
  previous: UsageWindow,
): UsageWindow {
  if (mode === "custom") return previous;
  return { kind: mode } as UsageWindow;
}

/** 固定档位的词条键；`custom` 返回 `null`（它没有固定文案，走 `usageCustomRangeLabel`）。 */
export function usageWindowKey(window: UsageWindow): TranslationKey | null {
  if (window.kind === "custom") return null;
  return `wbStats.usage.range.${window.kind}` as TranslationKey;
}

/** `M/D`（跨年时带年份）—— 自定义区间的轴标签。 */
function shortKey(key: string, withYear: boolean): string {
  const [year, month, day] = key.split("-");
  const md = `${Number(month)}/${Number(day)}`;
  return withYear ? `${year}/${md}` : md;
}

export function shortDateLabel(key: string, now: number = Date.now()): string {
  const safe = parseDateKey(key) ?? todayKey(now);
  return shortKey(safe, safe.slice(0, 4) !== todayKey(now).slice(0, 4));
}

export function usageCustomRangeLabel(
  window: Extract<UsageWindow, { kind: "custom" }>,
  now: number = Date.now(),
): string {
  const { from, to } = clampCustom(window.from, window.to, now);
  const crossYear = from.slice(0, 4) !== to.slice(0, 4);
  return `${shortKey(from, crossYear)} – ${shortKey(to, crossYear)}`;
}
