
import bundledRaw from "@/data/release-notes.json";
import { normalizeReleaseNotes } from "@/lib/release-notes";
import type { ReleaseNotes, UpdateInfo } from "@/lib/types";

/** 归一化后的内置说明（模块级缓存：归一化只做一次）。 */
let cached: ReleaseNotes | null | undefined;

export function bundledReleaseNotes(): ReleaseNotes | null {
  if (cached === undefined) cached = normalizeReleaseNotes(bundledRaw);
  return cached;
}

/**
 * 弹窗最终要渲染的说明。
 *
 * 优先级：后端抓到的这份（版本对得上才用） → 内置的（版本对得上才用） → `null`。
 * 「版本对得上」的判据：等于 `update.latest`，或等于 `update.current`（本版说明）。
 */
export function resolveNotesFor(update: UpdateInfo | null): ReleaseNotes | null {
  const remote = update?.notes ?? null;
  if (remote) return remote;

  const bundled = bundledReleaseNotes();
  if (!bundled) return null;
  if (bundled.version === update?.latest) return bundled;
  if (bundled.version === update?.current) return bundled;
  return null;
}
