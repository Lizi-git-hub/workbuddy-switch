/**
 * 用量四视图 · **数字格式化**（纯函数）。
 *
 * 图表轴 / 图例 / tile 都用同一套格式化，避免「同一件事的数字在两处显示成不同样式」。
 * 非有限值统一显示 `—`（不显示 `NaN`）。
 */

const exact = new Intl.NumberFormat("en-US");

const credits = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

/** 去掉定点数尾部的 0（`1.20` → `1.2`、`2.00` → `2`）。 */
function trim(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

export function compactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e8) return `${trim(value / 1e8, 2)}亿`;
  if (magnitude >= 1e4) return `${trim(value / 1e4, 2)}万`;
  return String(Math.round(value));
}

/** 精确 Token（1,234,567）。 */
export function exactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return exact.format(value);
}

/** 积分（最多两位小数）。 */
export function formatCredits(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return credits.format(value);
}

/**
 * **带方向符号**的积分（入账 `+` / 消耗 `-`）。
 *
 * 零值不带符号：`-${formatCredits(0)}` 得到的是 `-0`，读起来像解析失败。
 * 「0 消耗」是真实值，照实显示 `0`（与签到流水「拿不到额度就不摆 +0」同一条口径）。
 * 非有限值仍是 `—`（**不带符号**，避免出现 `-—`）。
 */
export function signedCredits(value: number | null | undefined, sign: "+" | "-"): string {
  const text = formatCredits(value);
  if (text === "—" || value === 0) return text;
  return `${sign}${text}`;
}

/** 占比文案：分母为 0 时给 `—`（不给 `0%`，避免「有 0% 数据」的错觉）。 */
export function sharePercent(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "—";
}

/**
 * 带「万 / 亿」后缀的紧凑值（hover、图表副标用）：`1.2 亿`。
 * 与 `compactTokens` 同一刻度，只是单位与数字之间带空格，读起来不挤。
 */
export function compactShare(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e8) return `${trim(value / 1e8, 2)} 亿`;
  if (magnitude >= 1e4) return `${trim(value / 1e4, 2)} 万`;
  return String(Math.round(value));
}
