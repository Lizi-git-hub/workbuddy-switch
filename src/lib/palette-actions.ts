
import type { TranslationKey } from "@/locales/zh";
import type { PaletteContext } from "@/lib/command-palette";

/** 一个可在命令面板里执行的动作。 */
export interface PaletteAction {
  /** 稳定 key（断言 + 去重用）。 */
  id: string;
  /** 标题文案键（已 i18n）。 */
  titleKey: TranslationKey;
  /** 副标题文案键（可空）。 */
  subtitleKey?: TranslationKey;
  enabled?: (ctx: PaletteContext) => boolean;
  /** 执行。副作用经 `ctx.services` 注入（见文件头）。 */
  run: (ctx: PaletteContext) => void | Promise<void>;
}

/**
 * P6 基础动作。P7 往 {@link registerPaletteActions} 追加它的两个动作即可。
 *
 * ⚠️ 三个动作的 `run` 都只转发到 `ctx.services`：它们**没有**对具体平台写死判断，
 * 「当前作用域」由 `ctx.currentScope` 决定，因此对 WorkBuddy / Trae 都成立。
 */
export const BASE_PALETTE_ACTIONS: readonly PaletteAction[] = [
  {
    id: "refresh-scope",
    titleKey: "palette.action.refresh",
    run: (ctx) => ctx.services.refreshScope(ctx.currentScope),
  },
  {
    id: "add-account",
    titleKey: "palette.action.addAccount",
    run: (ctx) => ctx.services.addAccount(ctx.currentScope),
  },
  {
    id: "open-data-dir",
    titleKey: "palette.action.openDataDir",
    run: (ctx) => ctx.services.openDataDir(ctx.currentScope),
  },
];

/** 已注册动作（含基础动作）。**就地可变**：注册是显式副作用。 */
const registered: PaletteAction[] = [...BASE_PALETTE_ACTIONS];

/** 注册动作（按 id 去重，保留首次）。P7 调它挂上自己的两个动作。 */
export function registerPaletteActions(actions: readonly PaletteAction[]): void {
  for (const action of actions) {
    if (registered.some((existing) => existing.id === action.id)) continue;
    registered.push(action);
  }
}

/** 当前动作清单（基础动作 + 注册动作），供面板合并进 `PaletteContext.actions`。 */
export function collectPaletteActions(): readonly PaletteAction[] {
  return registered;
}
