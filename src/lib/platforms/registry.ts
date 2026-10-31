
/** 平台标识。**刻意保持 `trae` 而非 `traework`**：路由前缀 `/trae/...` 与既有键名都依赖它。 */
export type Product = "workbuddy" | "trae" | "qoder";

import type { TranslationKey } from "@/locales/zh";

export type Capability =
  | "checkin" // 签到
  | "travel" // 自动旅行（**WorkBuddy 独有**）
  | "credits" // 积分 / 资源包
  | "oauth" // 扫码登录
  | "gateway" // API 网关
  | "autoRotate" // 自动轮换（**WorkBuddy 独有**）
  | "sessionCopy"; // 会话复制（**只有 WorkBuddy 桌面**，见下）

export interface ProgramSpec {
  readonly id: string;
  /** 展示名文案键（与后端 `ProgramSpec.label_key` 逐字一致）。 */
  readonly labelKey: TranslationKey;
  /** `available` = 已支持；`planned` = 计划新增（**尚未支持**）。 */
  readonly status: "available" | "planned";
}

export const WORKBUDDY_PROGRAMS: readonly ProgramSpec[] = [
  { id: "codebuddy_cn_ide", labelKey: "wbAccounts.program.codebuddyCnIde", status: "available" },
  { id: "codebuddy_cli", labelKey: "wbAccounts.program.codebuddyCli", status: "available" },
  { id: "vscode_cn_inject", labelKey: "wbAccounts.program.vscodeCnInject", status: "available" },
  { id: "vscode_codebuddy_plugin", labelKey: "wbAccounts.program.vscodeCodebuddyPlugin", status: "available" },
  { id: "jetbrains_codebuddy_plugin", labelKey: "wbAccounts.program.jetbrainsCodebuddyPlugin", status: "available" },
];

/** 计划新增（**尚未支持**）的程序位。⚠️ 当前**为空**（两条目标均已落地），机制保留。 */
export const PLANNED_PROGRAMS: readonly ProgramSpec[] = WORKBUDDY_PROGRAMS.filter(
  (p) => p.status === "planned",
);

export interface PlatformDescriptor {
  readonly id: Product;
  readonly labelKey: TranslationKey;
  /** 该平台的首页路径（切到该平台且当前路由不属于它时落到这里）。 */
  readonly home: string;
  /** 该平台拥有的区域（**顺序即 UI 展示顺序**）。 */
  readonly regions: readonly ("cn" | "global")[];
  /** 该平台具备的能力。 */
  readonly capabilities: readonly Capability[];
}

/**
 * 平台注册表 —— **平台的唯一事实来源**。
 *
 * ⚠️ 新增平台 = 这里加一条 + `scope.ts` 的 `Scope` 加对应值，**页面组件零改动**。
 */
export const PLATFORM_DESCRIPTORS: Record<Product, PlatformDescriptor> = {
  workbuddy: {
    id: "workbuddy",
    labelKey: "product.workbuddy",
    home: "/",
    regions: ["cn", "global"],
    capabilities: ["checkin", "travel", "credits", "oauth", "gateway", "autoRotate", "sessionCopy"],
  },
  trae: {
    id: "trae",
    labelKey: "product.trae",
    home: "/trae/accounts",
    regions: ["cn", "global"],
    capabilities: ["checkin", "credits", "oauth", "gateway"],
  },
  /**
   * Qoder —— 阿里出品的 AI 编程 IDE，国内版 / 国际版两套账号体系。
   *
   * ⚠️ **双区域是一个平台内的两个 realm，不是两个平台**：两版共用同一套客户端形态
   * （同一份协议、同一套令牌家族、同一组能力），差别只在端点 / 客户端 id / 本地目录
   * 这几张常量表上 ⇒ 建模成 `qoder-cn` / `qoder-global` 两个作用域。
   *
   * 能力**刻意只有四项**：没有 `sessionCopy`（会话复制依赖客户端自身的会话存储与云端
   * 归属，当前只有 WorkBuddy 桌面具备）、没有 `travel` / `autoRotate`（WorkBuddy 独有）、
   * 没有 `snapshot` / `group`（Trae 有，Qoder 侧无等价物）。
   */
  qoder: {
    id: "qoder",
    labelKey: "product.qoder",
    home: "/qoder/accounts",
    regions: ["cn", "global"],
    capabilities: ["checkin", "credits", "oauth", "gateway"],
  },
};

/** 全部平台，按 UI 展示顺序。 */
export const PRODUCTS: readonly Product[] = ["workbuddy", "trae", "qoder"];

export type Destination = "overview" | "accounts" | "usage" | "sessions" | "settings";

export const DESTINATIONS: readonly Destination[] = [
  "overview",
  "accounts",
  "usage",
  "sessions",
  "settings",
];

export function destinationOfLegacyPath(pathname: string): Destination | null {
  const p = pathname.replace(/\/+$/, "") || "/"; // 去掉尾斜杠（根路径除外）
  const bare = p.startsWith("/trae") ? p.slice("/trae".length) || "/" : p;

  switch (bare) {
    case "/":
    case "/accounts":
      return "accounts";
    case "/overview":
      return "overview";
    case "/token-stats":
    case "/usage":
      return "usage";
    case "/credit-stats":
    case "/credits":
      return "usage";
    case "/settings":
      return "settings";
    default:
      return null;
  }
}

/**
 * 目的地在**新路由**里的路径段。与 `Destination` 同名 —— 这样
 * `/s/wb-cn/accounts` 一眼能读出「哪个作用域的哪个页面」，无需查表。
 */
export function destinationPath(dest: Destination): string {
  return dest;
}

export function platformDescriptor(product: Product): PlatformDescriptor {
  return PLATFORM_DESCRIPTORS[product];
}

export function hasCapability(product: Product, capability: Capability): boolean {
  return PLATFORM_DESCRIPTORS[product].capabilities.includes(capability);
}

export const DESTINATION_CAPABILITY: Partial<Record<Destination, Capability>> = {
  sessions: "sessionCopy",
};

/**
 * 该目的地在该平台是否**可渲染入口**（按能力门控；无门控项恒 `true`）。
 *
 * 侧栏（`App.tsx` 的 `scopedNav`）与命令面板据此过滤 —— 单一实现，避免两处各写一份门控。
 */
export function destinationAvailable(product: Product, dest: Destination): boolean {
  const capability = DESTINATION_CAPABILITY[dest];
  return capability === undefined || hasCapability(product, capability);
}

/**
 * 平台在**作用域字面量**里的短标识。
 *
 * ⚠️ **为什么不直接用 `Product`**：`workbuddy-cn` 太长，而作用域要进 URL 路径段
 * （`/s/wb-cn/accounts`）与 `localStorage` 键 —— 短标识更省也更易读。
 *
 * ⚠️ **映射只有这一处**（下面两张表）。别在别处再写一份 `"wb"` 字面量 ——
 * 那会让「改标识」变成全仓搜索。
 */
export type PlatformSlug = "wb" | "trae" | "qoder";

export const PLATFORM_SLUG: Record<Product, PlatformSlug> = {
  workbuddy: "wb",
  trae: "trae",
  qoder: "qoder",
};

export const SLUG_TO_PRODUCT: Record<PlatformSlug, Product> = {
  wb: "workbuddy",
  trae: "trae",
  qoder: "qoder",
};

export function platformOfPath(pathname: string): Product {
  const m = /^\/s\/([^/]+)/.exec(pathname);
  if (m) {
    const slug = m[1].split("-")[0] as PlatformSlug;
    if (Object.prototype.hasOwnProperty.call(SLUG_TO_PRODUCT, slug)) {
      return SLUG_TO_PRODUCT[slug];
    }
  }
  /* 前缀必须带分隔符：`/traeish` / `/qoderish` 不是这两个分区（见门禁用例）。 */
  if (pathname === "/trae" || pathname.startsWith("/trae/")) return "trae";
  if (pathname === "/qoder" || pathname.startsWith("/qoder/")) return "qoder";
  return "workbuddy";
}

/** 该路径是否属于该平台（用于「切平台时判断当前路由是否要跳走」）。 */
export function pathBelongsTo(pathname: string, product: Product): boolean {
  return platformOfPath(pathname) === product;
}
