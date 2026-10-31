import { isWorkday } from "./holidays";

/**
 * 用量换算费用 —— **单价可编辑**的本地定价表。
 *
 * ## 为什么不用插件那套峰谷定价
 *
 * `dsh-local-usage-rebuild` 的 `pricing.ts` 要处理「家族 / 卡片 / 峰谷倍率」
 * （同一模型在高峰与非高峰是两个价，且卡片可以多选），那是为了核对**真实账单**。
 *
 * 这里的目标不同：用户只想把「积分 / token 用量」换算成一个大致等价的金额，
 * 用来回答「这个月相当于花了多少钱」。所以每个模型只留三档单价：
 *
 * - `input`：普通输入（每百万 token）
 * - `output`：输出
 * - `cacheRead`：缓存命中读（通常比输入便宜一个数量级）
 *
 * 三档都是**每百万 token 的人民币价**，与主流厂商的公开报价同口径，
 * 用户照着官网填即可。改动即时保存到 `localStorage`。
 */

/**
 * 单个模型的单价（元 / 百万 token），**四档 × 两卡**，与插件
 * `dsh-local-usage-rebuild` 的 RateEditor 同构：
 *
 * - 四档 = 输入 / 缓存读 / 缓存写 / 输出（`jsonl` 的 `usage` 四个计数各归各价）；
 * - 两卡 = **非峰**卡与**峰值**卡，各持一套绝对价 —— 不是「非峰 × 倍率」；
 * - `peakEnabled` 决定该模型是否区分峰谷：关掉时峰值卡整个消失，
 *   任何时刻都按非峰卡计（对全天一个价的厂商，这才是诚实配置）。
 */
export interface ModelRate {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  peakEnabled: boolean;
  peakInput: number;
  peakCacheRead: number;
  peakCacheWrite: number;
  peakOutput: number;
}

/** 模型名 → 单价。 */
export type RateTable = Record<string, ModelRate>;

const STORAGE_KEY = "buddy-switch:model-rates";
const PEAK_KEY = "buddy-switch:use-peak-pricing";

/**
 * 内置默认单价（元 / 百万 token）。
 *
 * 取主流公开报价量级，**只作为初值** —— 用户按自己的套餐改。
 * 键是模型名的小写形式（匹配时忽略大小写与前缀厂商名）。
 */
export const DEFAULT_RATES: RateTable = {
  "deepseek-v4.1-flash": card({ input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8 }, { multiplier: 2 }),
  "deepseek-v4-pro": card({ input: 4, cacheRead: 1, cacheWrite: 4, output: 16 }, { multiplier: 2 }),
  "deepseek-flash": card({ input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8 }, { multiplier: 2 }),
  "glm-5.3": card({ input: 4, cacheRead: 1, cacheWrite: 4, output: 16 }, { multiplier: 2 }),
  "glm-5.3-flash": card({ input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8 }, { multiplier: 2 }),
};

/** 由非峰四档造一张完整卡（峰值 = 非峰 × 倍率，峰谷开关默认关）。 */
function card(
  offPeak: { input: number; cacheRead: number; cacheWrite: number; output: number },
  options: { multiplier: number },
): ModelRate {
  return {
    ...offPeak,
    peakEnabled: false,
    peakInput: offPeak.input * options.multiplier,
    peakCacheRead: offPeak.cacheRead * options.multiplier,
    peakCacheWrite: offPeak.cacheWrite * options.multiplier,
    peakOutput: offPeak.output * options.multiplier,
  };
}

/** 没配单价的模型走这张兜底卡，避免整表算不出钱。 */
export const FALLBACK_RATE: ModelRate = card(
  { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8 },
  { multiplier: 2 },
);

function normalize(row: Record<string, unknown>): ModelRate | null {
  const input = Number(row.input);
  const output = Number(row.output);
  const cacheRead = Number(row.cacheRead);
  const cacheWrite = Number(row.cacheWrite);
  if (![input, output, cacheRead, cacheWrite].every((n) => Number.isFinite(n) && n >= 0)) {
    return null;
  }
  const base = { input, output, cacheRead, cacheWrite };
  /* 旧格式里 peak 是「倍率」，新格式是独立的峰值四档 —— 旧倍率直接丢弃，
     峰值卡按非峰 × 2 起步，峰谷开关默认关（与全新安装一致）。 */
  const multiplier = Math.max(Number(row.peak) || 1, 1) * 2;
  return {
    ...base,
    peakEnabled: row.peakEnabled === true,
    peakInput: base.input * multiplier,
    peakCacheRead: base.cacheRead * multiplier,
    peakCacheWrite: base.cacheWrite * multiplier,
    peakOutput: base.output * multiplier,
  };
}

/** 读取本地单价表（与默认表合并；用户改过的覆盖默认）。 */
export function loadRates(): RateTable {
  const merged: RateTable = { ...DEFAULT_RATES };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return merged;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return merged;
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const rate = normalize(value as Record<string, unknown>);
      if (rate) merged[name.toLowerCase()] = rate;
    }
  } catch {
    // 存储损坏 ⇒ 用默认表，不让整页报错。
  }
  return merged;
}

/** 写入本地单价表。 */
export function saveRates(rates: RateTable): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rates));
  } catch {
    // 隐私模式等写不进去的场景：本次仍生效（内存态），下次回落默认。
  }
}

/** 是否按峰值口径计价（全局开关，与单价表分开存）。 */
export function loadUsePeak(): boolean {
  try {
    return localStorage.getItem(PEAK_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveUsePeak(value: boolean): void {
  try {
    localStorage.setItem(PEAK_KEY, value ? "1" : "0");
  } catch {
    // 写不进去就算了：本次内存态仍生效。
  }
}

/**
 * 查某个模型的单价。
 *
 * 匹配规则（从严到宽）：完整名 → 去掉厂商前缀（`vendor/`）→ 忽略大小写 →
 * 兜底卡。这样 `workbuddy/deepseek-v4.1-flash` 能命中 `deepseek-v4.1-flash`。
 */
export function rateOf(rates: RateTable, model: string): ModelRate {
  const raw = model.trim();
  if (!raw) return FALLBACK_RATE;
  const lower = raw.toLowerCase();
  const bare = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  return rates[lower] ?? rates[bare] ?? FALLBACK_RATE;
}

/**
 * 把用量换算成金额（元）。
 *
 * 单价是「每百万 token」，所以除以 1e6。缓存命中部分按 `cacheRead` 计价，
 * **不重复计输入** —— 调用方传进来的 `input` 应当是已经扣掉缓存的那部分。
 */
export interface TokenBundle {
  /** 普通输入（已扣除缓存命中）。 */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 一次用量换算成金额（元）。单价是「每百万 token」，所以除以 1e6。
 * `side` 选计价卡：非峰卡或峰值卡（是否切到峰值卡由调用方按时段与
 * 该模型的 `peakEnabled` 决定，这里只管乘）。
 */
export function costOf(bundle: TokenBundle, rate: ModelRate, side: "off" | "peak" = "off"): number {
  const perMillion = 1_000_000;
  const card = side === "peak" ? rate : rate;
  const pick = (peak: number, off: number) => (side === "peak" ? peak : off);
  void card;
  return (
    (bundle.input / perMillion) * pick(rate.peakInput, rate.input) +
    (bundle.output / perMillion) * pick(rate.peakOutput, rate.output) +
    (bundle.cacheRead / perMillion) * pick(rate.peakCacheRead, rate.cacheRead) +
    (bundle.cacheWrite / perMillion) * pick(rate.peakCacheWrite, rate.cacheWrite)
  );
}

/**
 * 某个小时是否处于**高峰时段** —— 按官方规则内置，不做成可配项：
 *
 * > 北京时间周一至周五（不含法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；
 * > 其余时段，包括周末及中国法定节假日全天均为空闲时段（节假日表见 ）。
 *
 * 整点近似：9-11、14-17 四个整点小时按峰计（半点边界落在相邻整点桶里，
 * 对「看个量级」的用途足够）。法定节假日历不引入 —— 一张会过期的表
 * 不如一条过时几天但永远在的规则。
 */
export function isPeakSlot(dateKey: string, hour: number): boolean {
  if (!isWorkday(dateKey)) return false; // 法定节假日 / 周末（非调班）全天非峰
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 金额显示：`¥723.74`；不足一分钱时保留 4 位，避免一片 `¥0.00`。 */
export function formatCost(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude > 0 && magnitude < 0.01) return `¥${value.toFixed(4)}`;
  return `¥${value.toFixed(2)}`;
}
