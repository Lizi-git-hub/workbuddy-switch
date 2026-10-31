/**
 * 中国法定节假日表 —— 峰谷判断的依据。
 *
 * 规则（DeepSeek 官方峰谷定义）：
 *
 * > 北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；
 * > 其余时段（含周末、调班周末、法定节假日全天）均为空闲时段。
 *
 * ## 口径（按用户确认）
 *
 * **调班补班的周末也是低谷** —— 即使那天按国家安排要上班，也全天按非峰计。
 * ⇒ 表里只需要「落在周一至五的放假日子」，周末天然非峰，不用进表。
 *
 * ## 覆盖 2026 - 2030 的推算方式
 *
 * 未来年份的官方安排国务院只提前一年公布，但**农历节日的公历日期可以精确推算**
 * （`Intl.DateTimeFormat` 的 `chinese` 日历）：正月初一（春节）、五月初五（端午）、
 * 八月十五（中秋）逐年遍历即可，比手工抄表可靠。公历节（元旦 / 清明 / 五一 / 国庆）
 * 日期固定或近似固定。
 *
 * 连休长度按惯例（春节 8 天、五一 5 天、国庆 7 天、清明 / 端午 / 中秋 3 天）；
 * 若与当年官方安排差一天，改 `addRange` 的天数即可 —— 表是推算的，不是抄的。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地日期键 `YYYY-MM-DD`。 */
function dateKeyOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 农历查询器（`chinese` 日历）。引擎差异：闰月在 month 里带 `闰` / `bis` 字样。 */
const lunarFormatter = new Intl.DateTimeFormat("en-u-ca-chinese", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

function lunarOf(key: string): { month: number; day: number; leap: boolean } | null {
  try {
    const parts = lunarFormatter.formatToParts(new Date(`${key}T00:00:00`));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const monthRaw = get("month");
    const leap = /闰|bis|l/i.test(monthRaw);
    const month = Number.parseInt(monthRaw.replace(/\D+/g, ""), 10);
    const day = Number.parseInt(get("day").replace(/\D+/g, ""), 10);
    if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
    return { month, day, leap };
  } catch {
    return null;
  }
}

/** 惰性构建（模块级缓存）：2026 - 2030。 */
let holidayCache: ReadonlySet<string> | null = null;

function buildHolidays(firstYear: number, lastYear: number): ReadonlySet<string> {
  const set = new Set<string>();
  const isWeekend = (date: Date) => date.getDay() === 0 || date.getDay() === 6;
  /** 连休区间里**非周末**的日子才进表（周末天然非峰，不需要标记）。 */
  const addRange = (start: Date, days: number) => {
    for (let index = 0; index < days; index += 1) {
      const date = new Date(start.getTime() + index * DAY_MS);
      if (isWeekend(date)) continue;
      set.add(dateKeyOf(date));
    }
  };

  for (let year = firstYear; year <= lastYear; year += 1) {
    // 公历节：元旦 1 天；清明取 4/4 - 4/6（节气 4/4 或 4/5，区间覆盖）；
    // 五一 5 天；国庆 7 天。
    addRange(new Date(year, 0, 1), 1);
    addRange(new Date(year, 3, 4), 3);
    addRange(new Date(year, 4, 1), 5);
    addRange(new Date(year, 9, 1), 7);

    // 农历节：春节（除夕起 8 天）、端午（当天起 3 天）、中秋（当天起 3 天）。
    for (let offset = 0; offset < 366; offset += 1) {
      const date = new Date(year, 0, 1 + offset);
      if (date.getFullYear() !== year) break;
      const lunar = lunarOf(dateKeyOf(date));
      if (!lunar || lunar.leap) continue;
      if (lunar.month === 1 && lunar.day === 1) {
        addRange(new Date(date.getTime() - DAY_MS), 8); // 除夕起 8 天
      }
      if (lunar.month === 5 && lunar.day === 5) addRange(date, 3);
      if (lunar.month === 8 && lunar.day === 15) addRange(date, 3);
    }
  }
  return set;
}

function holidays(): ReadonlySet<string> {
  if (holidayCache === null) holidayCache = buildHolidays(2026, 2030);
  return holidayCache;
}

/**
 * 该日期是否为**工作日**（峰谷判断用）：
 * 周末（含调班周末）与放假的日子都是低谷 —— 用户口径。
 */
export function isWorkday(dateKey: string): boolean {
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return true; // 解析失败按工作日（不把峰谷静默抹掉）
  const weekday = date.getDay();
  if (weekday === 0 || weekday === 6) return false;
  return !holidays().has(dateKey);
}
