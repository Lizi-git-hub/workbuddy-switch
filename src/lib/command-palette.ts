
import { accountSearchText, matchesAccountQuery } from "@/lib/account-search";
import { displayText } from "@/lib/display-text";
import type { Destination } from "@/lib/platforms/registry";
import { platformDescriptor } from "@/lib/platforms/registry";
import type { Translate } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/zh";
import type { Scope } from "@/lib/scope";
import { scopeParts } from "@/lib/scope";
import type { AccountMeta } from "@/lib/types";
import type { TraeAccount } from "@/lib/trae-types";
import type { PaletteAction } from "@/lib/palette-actions";

/** 条目分组。顺序即渲染顺序（页面 / 作用域 / 账号 / 动作）。 */
export type PaletteGroup = "page" | "scope" | "account" | "action";

/** 面板里的一行。**所有展示字段都已是字符串**（组装前过了 `displayText`）。 */
export interface PaletteItem {
  /** 稳定 key（React key + 门禁断言用）。 */
  id: string;
  group: PaletteGroup;
  /** 已 i18n 的标题。 */
  title: string;
  /** 已 i18n 的副标题（可空）。 */
  subtitle?: string;
  shortcutHint?: string;
  /** 已归一的搜索文本（复用 `accountSearchText` 的归一规则）。 */
  searchText: string;
  /** 执行该行（导航 / 动作）。 */
  run: () => void;
}

/**
 * 跨作用域账号的**归一视图**（字段归属见文件头表）。
 *
 * ⚠️ 刻意**不含** `lastUsedAt` —— 它属 `ApiKeyRecord` / `TraeApiKeyRecord`，
 * 不是账号字段。引用它只会读到 `undefined`（本仓已因此翻过一次车）。
 */
export interface PaletteAccount {
  scope: Scope;
  /** 稳定键：WB = `AccountMeta.id`；Trae = `TraeAccount.userId`。 */
  key: string;
  /** 展示名：WB = `nickname`；Trae = `name`。 */
  displayName: string;
  email?: string | null;
  uid?: string | null;
  remark?: string | null;
}

/**
 * 动作执行所需的**副作用接口** —— 由组件（持有 `api` / `navigate`）注入。
 *
 * 动作清单（{@link PaletteAction}）住在 `palette-actions.ts` 里保持纯净、可被门禁加载；
 * 真正碰 `api` 的部分收敛到本接口，经 `ctx.services` 传入 —— 这样「基础动作在此注册」
 * 与「palette-actions.ts 零重依赖」两件事同时成立。
 */
export interface PaletteServices {
  /** 刷新某作用域的账号数据（就地，不导航）。 */
  refreshScope: (scope: Scope) => void | Promise<void>;
  /** 打开某作用域的「新增账号」入口（通常导航到账号页）。 */
  addAccount: (scope: Scope) => void;
  /** 打开某作用域的数据目录。 */
  openDataDir: (scope: Scope) => void | Promise<void>;
}

/** `buildPaletteItems` 的全部输入 —— 纯数据，便于门禁构造。 */
export interface PaletteContext {
  t: Translate;
  currentScope: Scope;
  scopes: readonly Scope[];
  /** 作用域 → 快捷键序号；降级时为空 Map（序号提示据此渲染）。 */
  scopeShortcutIndex: ReadonlyMap<Scope, number>;
  accounts: readonly PaletteAccount[];
  destinations: readonly Destination[];
  navigate: (to: string) => void;
  actions: readonly PaletteAction[];
  /** 动作副作用（见 {@link PaletteServices}）。 */
  services: PaletteServices;
}

/** 目的地 → 侧栏文案键（与 `App.tsx` 的 `DEST_META` 同键，保证面板与侧栏同名）。 */
const DESTINATION_LABEL_KEY: Record<Destination, TranslationKey> = {
  overview: "nav.overview",
  accounts: "nav.accounts",
  usage: "nav.usage",
  sessions: "nav.sessions",
  settings: "nav.settings",
};

/** 区域 → 版本名文案键（与 `lib/region.ts` 的 `versionLabel` 同键）。 */
const REGION_LABEL_KEY: Record<"cn" | "global", TranslationKey> = {
  cn: "shared.region.version.cn",
  global: "shared.region.version.global",
};

/**
 * 作用域的展示名（`WorkBuddy · 国内版`）—— 面板与账号副标题共用。
 *
 * ⚠️ 平台名走 `platformDescriptor().labelKey`（注册表唯一来源），区域名走 `t()`
 * 现取 —— 不 import `lib/region.ts`（它连带 i18n 词表，会让门禁加载变重且脆弱）。
 */
export function scopeLabel(scope: Scope, t: Translate): string {
  const parts = scopeParts(scope);
  const productKey = platformDescriptor(parts.product).labelKey;
  return `${t(productKey)} · ${t(REGION_LABEL_KEY[parts.region])}`;
}

/**
 * WorkBuddy 账号 → {@link PaletteAccount}。稳定键取 `id`、展示名取 **`nickname`**。
 *
 * ⚠️ 这里**不出现** `account.name` —— WB 账号类型没有 `name` 字段。
 */
export function paletteAccountFromWorkbuddy(account: AccountMeta, scope: Scope): PaletteAccount {
  return {
    scope,
    key: account.id,
    displayName: displayText(account.nickname) ?? "",
    email: displayText(account.email),
    uid: displayText(account.uid),
    remark: displayText(account.remark),
  };
}

/**
 * Trae 账号 → {@link PaletteAccount}。稳定键取 **`userId`**、展示名取 `name`。
 *
 * ⚠️ 这里**不出现** `account.id` / `account.uid` —— Trae 账号类型没有这两个字段。
 */
export function paletteAccountFromTrae(account: TraeAccount, scope: Scope): PaletteAccount {
  return {
    scope,
    key: account.userId,
    displayName: displayText(account.name) ?? "",
    uid: displayText(account.userId),
    remark: displayText(account.remark),
  };
}

/** 账号条目的展示名：展示名为空时按「邮箱 → uid → 稳定键」回落，避免空标题。 */
function accountTitle(account: PaletteAccount): string {
  return account.displayName || account.email || account.uid || account.key;
}

export function buildPaletteItems(ctx: PaletteContext): PaletteItem[] {
  const items: PaletteItem[] = [];

  // ── 页面组：当前作用域的 5 个目的地 ──────────────────────────────
  for (const dest of ctx.destinations) {
    const title = ctx.t(DESTINATION_LABEL_KEY[dest]);
    items.push({
      id: `page:${dest}`,
      group: "page",
      title,
      searchText: accountSearchText({ name: title }),
      run: () => ctx.navigate(`/s/${ctx.currentScope}/${dest}`),
    });
  }

  // ── 作用域组：全部作用域（含各自登录态摘要的位置留给调用方）────────
  for (const scope of ctx.scopes) {
    const index = ctx.scopeShortcutIndex.get(scope);
    const title = scopeLabel(scope, ctx.t);
    items.push({
      id: `scope:${scope}`,
      group: "scope",
      title,
      subtitle: scope === ctx.currentScope ? ctx.t("palette.scope.current") : undefined,
      shortcutHint: typeof index === "number" ? `⌘${index}` : undefined,
      searchText: accountSearchText({ name: title, group: scope }),
      run: () => ctx.navigate(`/s/${scope}/accounts`),
    });
  }

  // ── 账号组：**跨作用域**全部账号 ────────────────────────────────
  for (const account of ctx.accounts) {
    const name = accountTitle(account);
    items.push({
      id: `account:${account.scope}:${account.key}`,
      group: "account",
      title: name,
      subtitle: ctx.t("palette.account.inScope", { scope: scopeLabel(account.scope, ctx.t) }),
      // 搜索文本与列表搜索**同字段同顺序**（复用 accountSearchText 的归一）。
      searchText: accountSearchText({
        name: account.displayName,
        email: account.email,
        uid: account.uid,
        remark: account.remark,
      }),
      run: () => ctx.navigate(`/s/${account.scope}/accounts?q=${encodeURIComponent(name)}`),
    });
  }

  for (const action of ctx.actions) {
    if (action.enabled && !action.enabled(ctx)) continue; // 条件不满足 ⇒ 不渲染（§3.4 规则 1）
    const title = ctx.t(action.titleKey);
    items.push({
      id: `action:${action.id}`,
      group: "action",
      title,
      subtitle: action.subtitleKey ? ctx.t(action.subtitleKey) : undefined,
      searchText: accountSearchText({ name: title }),
      run: () => {
        void action.run(ctx);
      },
    });
  }

  return items;
}

export function filterPaletteItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return [...items];
  return items.filter((item) => matchesAccountQuery(item.searchText, query));
}
