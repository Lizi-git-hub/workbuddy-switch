
import { useEffect, useMemo } from "react";

import { accountIdentity } from "@/components/account-card";
import { useAccountsStore } from "@/stores/accounts";
import type { TokenStatsGroup } from "@/lib/types";
import type { UsageWindow } from "@/lib/usage-window";
import { usageWindowKeys } from "@/lib/usage-window";
import { displayText } from "@/lib/display-text";
import { compactTokens, exactTokens } from "./format";
import { ChartFrame } from "./chart-frame";

export function AccountRanking({
  sessions,
  viewWindow,
}: {
  sessions: TokenStatsGroup[];
  viewWindow: UsageWindow;
}) {
  /* 账号名映射：store 平时只在账号页触发加载，用量页要用就得自取。
     空表时补一次拉取（fire-and-forget；失败静默，回落短 uid）。 */
  const cnAccounts = useAccountsStore((state) => state.accounts);
  const globalAccounts = useAccountsStore((state) => state.global.accounts);
  const fetchAllRegions = useAccountsStore((state) => state.fetchAllRegions);
  useEffect(() => {
    if (cnAccounts.length === 0 && globalAccounts.length === 0) {
      void fetchAllRegions().catch(() => undefined);
    }
  }, [cnAccounts.length, globalAccounts.length, fetchAllRegions]);

  const nameByUid = useMemo(() => {
    const map = new Map<string, string>();
    for (const account of [...cnAccounts, ...globalAccounts]) {
      const uid = account.uid?.trim();
      if (!uid || map.has(uid)) continue;
      /* 名字优先级与账号卡一致（昵称 → 脱敏邮箱）；都没有就不进表，
         渲染层回落短 uid —— 表面仍不出现完整 UID。 */
      const name = displayText(account.nickname) || (account.email ? accountIdentity(account) : "");
      if (name) map.set(uid, name);
    }
    return map;
  }, [cnAccounts, globalAccounts]);

  const rows = useMemo(() => {
    const keys = new Set(usageWindowKeys(viewWindow));
    const byAccount = new Map<string, { tokens: number; records: number }>();
    for (const session of sessions) {
      const uid = session.accountId ?? "";
      const key = uid || "unknown";
      const entry = byAccount.get(key) ?? { tokens: 0, records: 0 };
      for (const day of session.daily ?? []) {
        if (!keys.has(day.key)) continue;
        entry.tokens += day.total;
        entry.records += day.records;
      }
      byAccount.set(key, entry);
    }
    return [...byAccount.entries()]
      .map(([uid, value]) => ({ uid, ...value }))
      /* 只留**窗口内真有用量**的账号：0/0 的行（其它账号的历史会话落在这窗口外）
         纯属噪音 —— 「会话只显示会话的」。 */
      .filter((row) => row.tokens > 0 || row.records > 0)
      .sort((a, b) => b.tokens - a.tokens);
  }, [sessions, viewWindow]);

  const total = rows.reduce((sum, row) => sum + row.tokens, 0);

  return (
    <ChartFrame
      title="按账号"
      caption={`当前窗口合计 ${compactTokens(total)}`}
      ariaLabel="按账号用量排行"
      exportable={false}
    >
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead>
            <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
              <th className="px-3 py-2 font-medium">账号</th>
              <th className="px-3 py-2 text-right font-medium">tokens</th>
              <th className="px-3 py-2 text-right font-medium">请求</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">
                  当前窗口没有会话用量
                </td>
              </tr>
            ) : (
              rows.map((row) => {
              const name = row.uid === "unknown" ? "未归属" : (nameByUid.get(row.uid) ?? row.uid.slice(0, 8));
              return (
                <tr key={row.uid} className="border-t border-border/60">
                  <td className="max-w-[220px] truncate px-3 py-2" title={row.uid === "unknown" ? undefined : row.uid}>
                    {name}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{compactTokens(row.tokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {exactTokens(row.records)}
                  </td>
                </tr>
              );
            })
            )}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}
