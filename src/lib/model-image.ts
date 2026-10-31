
/** 能力来源：上游目录声明 / 本页手动覆盖 / 都没说。 */
export type ImageCapSource = "upstream" | "override" | "undeclared";

/** 一条模型的图片能力视图。 */
export interface ImageCapView {
  /** `true` = 支持、`false` = 明确不支持、`null` = 未声明（**不要**压成 `false`）。 */
  supports: boolean | null;
  source: ImageCapSource;
}

/** 后端模型条目里与本判据相关的两个字段（WB 目录 / 管理面视图都带）。 */
export interface ImageCapEntry {
  supports_images?: boolean | null;
  image_input_source?: ImageCapSource | null;
}

/**
 * 合成三态视图。`override` 必须是**覆盖表里的原值**（`undefined` = 没有覆盖）。
 *
 * 优先级：用户覆盖 > 上游声明 > 未声明。与后端 `model_capability::resolve` **同序**
 * （后端负责出口 ①，这里负责界面，两边必须给同一个答案）。
 */
export function resolveImageCap(
  entry: ImageCapEntry | undefined,
  override: boolean | undefined,
): ImageCapView {
  if (override !== undefined) return { supports: override, source: "override" };
  const declared = entry?.supports_images;
  if (typeof declared === "boolean") {
    // 后端已把来源算好；老响应没有该字段时按「上游」处理（唯一可能的来源）。
    return {
      supports: declared,
      source: entry?.image_input_source === "override" ? "override" : "upstream",
    };
  }
  return { supports: null, source: "undeclared" };
}
