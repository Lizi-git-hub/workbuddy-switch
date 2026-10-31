import * as api from "@/lib/api";
import { t } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/zh";
import type { TraeProgramStatus, TraeRegionId, TraeVariantId, TraeVariantStatus } from "@/lib/trae-types";

/**
 * 造一个「状态未知」的程序位占位。
 *
 * `label` / `variant` 是**系统性标识**（前端比对与回传后端都用它，例如
 * `program === "trae_code"`），因此始终保持英文；只有 `nameAlias` 是**面向用户
 * 的展示名**，随语言切换。表在模块加载时定型 ⇒ 展示名由 `nameAliasKey` 延迟到
 * 读取时现取（`programNameAlias`），否则切语言后整张表不会更新。
 */
function programStub(
  program: TraeProgramStatus["program"],
  label: string,
  nameAliasKey: TranslationKey,
  variant: TraeVariantId,
): TraeProgramStatus {
  return {
    program,
    label,
    get nameAlias() {
      return t(nameAliasKey);
    },
    variant,
    installed: false,
    running: false,
    version: null,
    path: null,
    dataDir: null,
    dataDirExists: false,
    // 登录态文件是否存在（见 `TraeProgramStatus.storageJsonExists`）：
    // 后端不可用时一律按「不存在」——**不要**跟着 `dataDirExists` 置 true，
    // 那会把「什么都没探测到」说成「登录态在这儿」。
    storageJsonExists: false,
    // 写侧目录（见 `TraeProgramStatus.writeDataDir`）：后端不可用时与 `dataDir` 同样置空。
    writeDataDir: null,
    writeDataDirExists: false,
  };
}

export const TRAE_VARIANT_FALLBACK: TraeVariantStatus[] = [
  {
    variant: "cn",
    // 表在模块加载时就定型 ⇒ 只存文案键，展示名在**读取时**现取，语言切换才不会失效。
    // ⚠️ 区域名走 `trae.region.*`（客户端产品名），**不是** `shared.region.version.*`
    // —— 后端 `TraeRegion::display_name` 给的就是前者，用后者会让演示站与真机文案不同。
    get variantLabel() {
      return t("trae.region.cn");
    },
    consoleBase: "https://www.trae.cn",
    installed: false,
    running: false,
    version: null,
    path: null,
    dataDir: null,
    dataDirExists: false,
    // 登录态文件是否存在（见 `TraeVariantStatus.storageJsonExists`）：后端不可用时按「不存在」。
    storageJsonExists: false,
    // 写侧目录（见 `TraeProgramStatus.writeDataDir`）：后端不可用时与 `dataDir` 同样置空。
    writeDataDir: null,
    writeDataDirExists: false,
    programs: [
      // 展示名规则：**国内版带 ` CN` 后缀、国际版不带后缀**（用户 2026-10-13 更正）。
      // `variant` 是它自己的标识 `trae_merged` —— 变体是快照目录 / Key 归属 /
      // 日志分档的派生来源，退役的 `trae_cn` / `trae_work` 不再是可选目标。
      programStub("trae", "Trae CN", "trae.program.traeCn", "trae_merged"),
    ],
  },
  {
    variant: "global",
    get variantLabel() {
      return t("trae.region.global");
    },
    consoleBase: "https://www.trae.ai",
    installed: false,
    running: false,
    version: null,
    path: null,
    dataDir: null,
    dataDirExists: false,
    // 登录态文件是否存在（见 `TraeVariantStatus.storageJsonExists`）：后端不可用时按「不存在」。
    storageJsonExists: false,
    // 写侧目录（见 `TraeProgramStatus.writeDataDir`）：后端不可用时与 `dataDir` 同样置空。
    writeDataDir: null,
    writeDataDirExists: false,
    programs: [
      // 国际版不带后缀 ⇒ `Trae`；变体是 `global_trae_merged`。
      programStub("trae", "Trae", "trae.program.traeGlobal", "global_trae_merged"),
    ],
  },
];

/**
 * 某个程序位当前登录的账号：**身份与展示名成对出现**。
 *
 * 两者同源于**同一次** `get_trae_profiles` 调用，因此结构上不可能出现
 * 「名字已更新、身份还是旧的」这种半更新状态 —— 这正是把它们放进一个对象、
 * 而不是两个平行的 Map 的理由（两个 Map 迟早漂移成两把不同的键）。
 */
export interface TraeVariantLogin {
  /** 身份（uid）。卡片上「是不是当前账号」的相等比较用它；**不要**拿它渲染文本。 */
  userId: string;
  /**
   * 给人看的名字：优先账号库里的 `name`，**查不到时回落 uid**。
   *
   * 回落只在这里写一次：状态条与设置页显示的是同一句话，两处各写一遍回落链
   * 迟早出现「一处显示名字、一处显示数字」。回落而不是显示「未知账号」的理由见
   * Rust 侧 `account::display_name_for` —— 那串数字仍能让用户去客户端里核对。
   */
  name: string;
}

/** 程序位标识 → 该程序当前登录账号（无 / 读不到时为 `null`）。 */
export type TraeVariantLogins = Partial<Record<TraeVariantId, TraeVariantLogin | null>>;

/**
 * 「全部区域的环境状态」在快照缓存里的键。
 *
 * **只此一份**：侧栏那颗运行状态圆点与账号页都要用这份探测结果，
 * 各自写一遍字符串字面量迟早漂移成两把不同的键（症状是「缓存命中不了、
 * 每次切换都重新探测」，而且不会有任何报错）。
 */
export const TRAE_VARIANTS_KEY = "trae:variants";

/**
 * 读取**全部区域**的环境状态（并排视角）。
 *
 * 返回**永不为空**：探测命令不可用（演示模式、后端未起来）或返回空列表时，
 * 回落到 {@link TRAE_VARIANT_FALLBACK} 的两个区域占位 —— 调用方据此渲染
 * 「有哪些区域」的控件，选项必须在后端不可用时依然存在，
 * 否则用户连切回另一条线的入口都没有。
 */
export async function loadTraeVariantStatuses(): Promise<TraeVariantStatus[]> {
  try {
    const result = await api.getTraeVariants();
    return result.variants?.length ? result.variants : TRAE_VARIANT_FALLBACK;
  } catch {
    return TRAE_VARIANT_FALLBACK;
  }
}

export async function loadTraeVariantLogins(
  statuses: TraeVariantStatus[],
): Promise<TraeVariantLogins> {
  // 每个程序位都带标识（`TraeProgramStatus.variant` 非空）⇒ 这里没有过滤，
  // 遍历到的每个程序位各取一次登录态（收敛后 = 两个区域各一个）。
  const targets: TraeVariantId[] = statuses.flatMap((item) =>
    item.programs.map((program) => program.variant),
  );
  const pairs = await Promise.all(
    targets.map(async (variant): Promise<[TraeVariantId, TraeVariantLogin | null]> => {
      try {
        const profiles = await api.getTraeProfiles(variant);
        const userId = profiles.currentAccount ?? null;
        // 没有当前账号 ⇒ `null`（**不是** `{ userId: "" , name: "" }`）：
        // 调用方靠它区分「未登录」与「已登录但名字读不到」。
        if (userId === null) return [variant, null];
        return [variant, { userId, name: profiles.currentAccountName || userId }];
      } catch {
        return [variant, null];
      }
    }),
  );
  return Object.fromEntries(pairs) as TraeVariantLogins;
}

/** 取某个区域的条目（找不到时返回 `undefined`，调用方自行回落占位）。 */
export function findRegionStatus(
  statuses: TraeVariantStatus[],
  region: TraeRegionId,
): TraeVariantStatus | undefined {
  return statuses.find((item) => item.variant === region);
}

/**
 * 本区域下的**程序位**（收敛后恰好一个），供「按程序位取数据」的卡片使用。
 *
 * ## 为什么取的是 {@link TRAE_VARIANT_FALLBACK} 而不是再探测一次
 *
 * 本函数要回答的是「这个区域**有哪些**程序位」，而这是一个**结构性事实**
 * （每个区域一个：合并后的单一客户端，见 `TraeProgramId` 的说明），
 * 与「装了没 / 在不在跑」无关。
 * `TRAE_VARIANT_FALLBACK` 正是这份结构表（区域切换器在后端不可用时也用它），
 * 复用它就**不会**多出第二份会漂移的程序位清单。
 *
 * ## ⚠️ 别拿它的 `installed` 当判断依据
 *
 * 兜底表里每个程序位都是 `installed: false`（它是「状态未知」的占位）。
 * 调用方需要真实安装状态时应改传探测结果（`get_trae_variants`），
 * **不要**用本函数的结果去禁用控件 —— 那会把所有程序位都禁掉。
 * 本函数只提供 `variant`（回传标识）与 `label`（展示名）。
 *
 * 清单读不到（客户端没启动过 / 没登录）时不需要预先禁用：后端会回
 * `source = "missing"` 与可读原因，界面按空态呈现即可。
 */
export function regionPrograms(region: TraeRegionId): { variant: TraeVariantId; label: string }[] {
  const entry = findRegionStatus(TRAE_VARIANT_FALLBACK, region);
  return (entry?.programs ?? []).map((program) => ({
    variant: program.variant,
    label: program.label,
  }));
}

export function allPrograms(): { variant: TraeVariantId; label: string }[] {
  const seen = new Set<TraeVariantId>();
  const out: { variant: TraeVariantId; label: string }[] = [];
  for (const region of TRAE_VARIANT_FALLBACK) {
    for (const program of region.programs) {
      if (seen.has(program.variant)) continue;
      seen.add(program.variant);
      out.push({ variant: program.variant, label: program.label });
    }
  }
  return out;
}
