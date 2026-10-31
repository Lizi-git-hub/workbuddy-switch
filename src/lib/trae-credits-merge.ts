
import type {
  TraeAccountsOverview,
  TraeCreditsOverview,
  TraeRegionId,
  TraeUnsupported,
} from "@/lib/trae-types";

/** 一个区域的积分 + 账号快照（页面按需取 1 或 2 片）。 */
export interface TraeRegionSlice {
  region: TraeRegionId;
  credits: TraeCreditsOverview;
  overview: TraeAccountsOverview;
}

/** 合并后的一行账号积分。 */
export interface TraeCreditsRow {
  /** 行键 = `<region>:<userId>`（**跨区不折叠**，见文件头）。 */
  key: string;
  region: TraeRegionId;
  userId: string;
  name: string;
  groupId: string | null;
  /** 可用积分；两处都取不到 ⇒ `null`（显示「未同步」，**不**当成 0）。 */
  credits: number | null;
  /** 到期时间（**秒**）；无 ⇒ `null`。 */
  expireAt: number | null;
}

/** 每日快照（合并后按日期求和）。 */
export interface TraeCreditsDaily {
  date: string;
  total: number;
  earned: number;
  consumed: number;
}

/**
 * 积分流水的一条（原型「积分流水」表：时间 / 账号 / 变动 / 说明）。
 *
 * `key` 带**区域前缀**：同一 uid 在两条区域线是两个账号，按 uid 折叠会串语义。
 */
export interface TraeCreditsRecord {
  key: string;
  region: TraeRegionId;
  userId: string;
  /** `YYYY-MM-DD`（后端快照按天记，没有更细的时间戳）。 */
  date: string;
  /** 当日余额。 */
  credits: number;
  /** 当日变动（正 = 入账，负 = 消耗）。 */
  delta: number;
}

export interface TraeCreditsMerged {
  rows: TraeCreditsRow[];
  /** 各账号可用积分之和（`credits === null` 的行不计入）。 */
  total: number;
  /** 按日期升序的每日快照（两区同日相加）。 */
  daily: TraeCreditsDaily[];
  /** 积分流水（按日期**降序**，两区合并；行键带区域前缀）。 */
  records: TraeCreditsRecord[];
  /** 最近一次积分缓存更新时间（取最新）。 */
  updatedAt: string | null;
  /** 历史明细保留天数（取最大）。 */
  historyDays: number;
  /** 平台做不到的维度（取首个非空，两区同源同文案）。 */
  unsupported: TraeUnsupported[];
}

export function mergeTraeCredits(slices: TraeRegionSlice[]): TraeCreditsMerged {
  const rows: TraeCreditsRow[] = [];
  const dailyByDate = new Map<string, TraeCreditsDaily>();
  const records: TraeCreditsRecord[] = [];
  let updatedAt: string | null = null;
  let historyDays = 0;
  let unsupported: TraeUnsupported[] = [];

  for (const slice of slices) {
    const { region, credits, overview } = slice;

    for (const account of overview.accounts ?? []) {
      const uid = account.userId;
      rows.push({
        key: `${region}:${uid}`,
        region,
        userId: uid,
        name: account.name,
        groupId: account.groupId,
        credits: credits.remaining?.[uid] ?? account.remainingCredits ?? account.credits ?? null,
        expireAt: credits.expireTimes?.[uid] ?? account.creditsExpireAt ?? null,
      });
    }

    for (const record of credits.records ?? []) {
      records.push({
        key: `${region}:${record.userId}:${record.date}`,
        region,
        userId: record.userId,
        date: record.date,
        credits: record.credits,
        delta: record.delta,
      });
    }

    for (const snapshot of credits.daily ?? []) {
      const entry = dailyByDate.get(snapshot.date) ?? {
        date: snapshot.date,
        total: 0,
        earned: 0,
        consumed: 0,
      };
      entry.total += snapshot.total ?? 0;
      entry.earned += snapshot.earned ?? 0;
      entry.consumed += snapshot.consumed ?? 0;
      dailyByDate.set(snapshot.date, entry);
    }

    if (credits.updatedAt && (!updatedAt || credits.updatedAt > updatedAt)) {
      updatedAt = credits.updatedAt;
    }
    historyDays = Math.max(historyDays, credits.historyDays ?? 0);
    if (unsupported.length === 0 && (credits.unsupported?.length ?? 0) > 0) {
      unsupported = credits.unsupported;
    }
  }

  rows.sort((left, right) => {
    if (left.credits === null && right.credits === null) return left.key < right.key ? -1 : 1;
    if (left.credits === null) return 1;
    if (right.credits === null) return -1;
    if (right.credits !== left.credits) return right.credits - left.credits;
    return left.key < right.key ? -1 : 1;
  });

  const daily = [...dailyByDate.values()].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );

  /* 流水按**日期降序**（原型 `viewUsage` 的积分流水表：最新的在最上）。
     同日按行键定序 ⇒ 顺序**确定性**，两区数据相同也不会抖动。 */
  records.sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? 1 : -1;
    return left.key < right.key ? -1 : 1;
  });

  return {
    rows,
    total: rows.reduce((sum, row) => sum + (row.credits ?? 0), 0),
    daily,
    records,
    updatedAt,
    historyDays,
    unsupported,
  };
}
