
import type { TraeProgram } from "@/components/trae-account-card";
import type { TraeAccount, TraeRegionId, TraeVariantId, TraeVariantStatus } from "@/lib/trae-types";
import type { TraeVariantLogins } from "@/lib/trae-variant-status";

export function traeProgramsFor(
  account: TraeAccount,
  variant: TraeVariantId,
  statuses: readonly TraeVariantStatus[],
  logins: TraeVariantLogins,
): TraeProgram[] {
  return statuses
    .filter((status) => status.variant === variant)
    .flatMap((status) =>
      status.programs.map((program) => ({
        region: status.variant as TraeRegionId,
        variant: program.variant,
        program: program.program,
        label: program.label,
        installed: program.installed,
        /* 「装了」不等于「能用」：客户端从未启动过时它的 userData 目录不存在 ⇒
           切换永远不可能成功。取**写侧**目录的存在性（与后端保存 / 恢复同源）。 */
        hasDataDir: program.writeDataDirExists,
        current: Boolean(account.userId) && logins[program.variant]?.userId === account.userId,
      })),
    );
}
