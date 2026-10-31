//! 选号算法：四因子加权 + 成本分层硬过滤 + Top-N 短名单 + 防惊群 + LRU 兜底。
//!
//! 移植自参考实现 `internal/pool/pick.go`。
//!
//! **为什么不只是「按权重排序取第一名」**：单点最优会让同一账号被连续打死（惊群），
//! 也会让「快过期积分优先消耗」与「闲置补偿」这些目标互相压制。因此实际策略是
//! 「分层 → 排序 → 取短名单 → 在短名单内按权重抽签」，把确定性排序转化为有界随机。
//!
//! 实现约束：候选快照在**同一把锁窗口内**一次性拷贝出所需字段，之后不再持有对池的
//! 借用——否则「选出结果后回写 `last_used`」会与候选列表的借用冲突。

use std::collections::{BTreeMap, HashSet};

use crate::pool::entry::CostTier;
use crate::pool::entry_like::PoolEntryLike;
use crate::pool::RealmTag;
use crate::rng::Pcg32;

/// 成本分层与短名单共用的策略参数。
#[derive(Debug, Clone, Copy)]
pub struct PickPolicy {
    /// 快过期积分占比的权重（参考实现 `expiringWeight`）。
    pub expiring_weight: f64,
    pub expiry_urgency_weight: f64,
    /// 闲置补偿：每小时增加的权重。
    pub idle_weight_per_hour: f64,
    /// 闲置补偿权重上限。
    pub idle_weight_max: f64,
    /// 防惊群间隔：此毫秒数内刚被选中的账号不进抽签池。
    pub min_pick_gap_ms: i64,
    /// 成本账本有效期。
    pub model_cost_ttl_ms: i64,
    /// 单账号在途上限（0 = 不限）。
    pub max_in_flight: i64,
    /// 国际版账号在途上限（0 = 沿用 `max_in_flight`）。
    pub max_in_flight_global: i64,
    pub deterministic: bool,
}

/// 短名单长度。
pub const SHORTLIST_SIZE: usize = 5;
/// 权重比较的浮点容差（判定「等权重」用）。
const WEIGHT_EPSILON: f64 = 1e-9;
/// 加权抽签的定点缩放。
const DRAW_SCALE: f64 = 1_000_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PickMode {
    /// 六因子权重 → 成本分层 → Top-N 短名单 → 加权抽签（默认）。
    #[default]
    Weighted,
    /// 候选内**积分最高者**（`AccountStrategy::MaxCredits`）。
    MaxCredits,
    /// 候选内**均匀抽签**（`AccountStrategy::Random`）：不看权重，用于把额度平均分摊。
    ///
    /// 与 `Weighted` 的区别是「有偏 / 无偏」：加权抽签仍然偏爱积分多、闲置久的号，
    /// 长期看会把某几个号抽干。用户明确要「平均分摊」时只有均匀抽签能满足。
    Random,
    Sequential,
}

/// 一次选号的**输入**（把 6 个同类型的参数收成一个结构体）。
///
/// 收成结构体不是为了少打字，而是因为 `realm` / `model` / `tried` / `excluded` 全是
/// `&HashSet<String>` / `Option<RealmTag>` 这类**同形状**参数 —— 位置传参一旦顺序写反，
/// 编译器不会报错（都是引用），只会静默换错语义。
pub struct PickInput<'a> {
    /// 归属域过滤（`None` = 不限）。
    pub realm: Option<RealmTag>,
    /// 本次请求的模型（决定模型级冷却是否命中）。
    pub model: &'a str,
    pub tried: &'a HashSet<String>,
    /// 用户显式排除的 uid（**硬约束**：自动选号、兜底、偏好一律跳过）。
    pub excluded: &'a HashSet<String>,
    pub allowed: Option<&'a HashSet<String>>,
    /// 选号策略。
    pub mode: PickMode,
    /// 抽签种子（生产用时间戳+序号，测试用固定值以保证可复现）。
    pub seed: u64,
}

/// 候选快照（不持有对池的借用）。
#[derive(Debug, Clone)]
struct Candidate {
    uid: String,
    weight: f64,
    credits: i64,
    cost_per_1k: f64,
    used_seq: u64,
    last_used_ms: i64,
    tier: u8,
}

pub fn weight_of<E: PoolEntryLike>(
    entry: &E,
    max_credits: i64,
    now_ms: i64,
    policy: &PickPolicy,
) -> f64 {
    weight_with_ema(
        entry,
        max_credits,
        now_ms,
        policy,
        entry.success_ema().max(0.0),
        entry.error_ema().max(0.0),
    )
}

/// **分模型**版本的权重（O6）：该模型有足够样本就用它的 EMA，否则回落到账号级。
///
/// ## 为什么需要它
///
/// 账号级 EMA 会把「在这个模型上老失败」摊到**所有**模型头上：一个号在 A 模型上
/// 连吃 429，它在 B 模型上的权重也被一起拖下去 —— 可它其实完全能服务 B。
/// 那是**错杀**：用户看到的是「明明换个模型就好，网关却一直不用这个号」。
///
/// 回落到账号级（而不是「没样本就当中性」）是有意的：新号 / 新模型上，
/// 账号的整体表现仍然是唯一可用的证据。
pub fn weight_of_model<E: PoolEntryLike>(
    entry: &E,
    max_credits: i64,
    now_ms: i64,
    policy: &PickPolicy,
    model: &str,
) -> f64 {
    let (success, error) = entry
        .model_ema(model)
        .unwrap_or((entry.success_ema().max(0.0), entry.error_ema().max(0.0)));
    weight_with_ema(
        entry,
        max_credits,
        now_ms,
        policy,
        success.max(0.0),
        error.max(0.0),
    )
}

/// 权重计算的**唯一实现**（两个公开入口只差「取哪一份 EMA」）。
fn weight_with_ema<E: PoolEntryLike>(
    entry: &E,
    max_credits: i64,
    now_ms: i64,
    policy: &PickPolicy,
    success: f64,
    error: f64,
) -> f64 {
    let mut weight = 1.0;

    let credits = entry.credits();
    let credits_expiring = entry.expiring_credits(now_ms);

    if max_credits > 0 {
        weight += (credits.max(0) as f64 / max_credits as f64) * 10.0;
    }

    if credits > 0 && credits_expiring > 0 {
        let ratio = (credits_expiring as f64 / credits as f64).clamp(0.0, 1.0);
        weight += ratio * policy.expiring_weight;
    }

    // 到期紧迫度独立因子：承载「还有多久过期」这类产品线特有语义。
    // 权重为 0 时该项恒为 0，因此对不启用它的产品线零影响。
    weight += entry.expiry_urgency(now_ms).clamp(0.0, 1.0) * policy.expiry_urgency_weight;

    weight += idle_weight(entry.last_used_ms(), now_ms, policy);

    let success = success.max(0.0);
    let error = error.max(0.0);
    let total = success + error;
    weight += if total > 0.0 {
        (success / total) * 3.0
    } else {
        // 无历史记录：给中性值，既不被惩罚也不被优待。
        1.5
    };

    weight
}

/// 闲置补偿权重：从未使用按上限给（鼓励启用新号）；否则随时长线性增长并封顶。
fn idle_weight(last_used_ms: i64, now_ms: i64, policy: &PickPolicy) -> f64 {
    if last_used_ms <= 0 {
        return policy.idle_weight_max.max(0.0);
    }
    let idle_ms = now_ms.saturating_sub(last_used_ms).max(0);
    let hours = idle_ms as f64 / 3_600_000.0;
    (hours * policy.idle_weight_per_hour).clamp(0.0, policy.idle_weight_max.max(0.0))
}

/// 「指定账号」下拉里的**策略哨兵值**（占位 uid）。
///
/// ## 为什么把策略编码进「偏好值」，而不是给两条产品线各加一个配置字段
///
/// Trae / Qoder 的配置里已经有 `preferredUid`（一个字符串，配合前端同一张池卡的
/// 下拉框）。再加一个 `pickMode` 字段意味着：两份配置结构、两个端点参数、两个前端状态
/// —— 而它们表达的其实是**同一个控件的一个取值**。
///
/// 前端早就有这套约定（`AUTO_OPTION = "__auto__"` / `MAX_CREDITS_OPTION = "__max_credits__"`），
/// 这里只是把它变成**后端也认**的语义（否则用户选「按积分择优」在 Trae 侧会被当成一个
/// 不存在的 uid，静默回落到加权 —— 又一个「假开关」）。
///
/// 四个值与前端常量**逐字相同**，改任何一处都必须同步（`parse_preferred` 的用例钉住）。
pub const PREFERRED_AUTO: &str = "__auto__";
/// 「按积分择优」（候选内积分最高者）。
pub const PREFERRED_MAX_CREDITS: &str = "__max_credits__";
/// 「随机」（候选内均匀抽签）。
pub const PREFERRED_RANDOM: &str = "__random__";
pub const PREFERRED_SEQUENTIAL: &str = "__sequential__";

pub fn parse_preferred(value: Option<&str>) -> (PickMode, Option<&str>) {
    match value.map(str::trim) {
        Some(PREFERRED_MAX_CREDITS) => (PickMode::MaxCredits, None),
        Some(PREFERRED_RANDOM) => (PickMode::Random, None),
        Some(PREFERRED_SEQUENTIAL) => (PickMode::Sequential, None),
        Some(PREFERRED_AUTO) | None => (PickMode::Weighted, None),
        Some("") => (PickMode::Weighted, None),
        Some(uid) => (PickMode::Weighted, Some(uid)),
    }
}

/// 空的排除集（「不排除任何账号」的默认值）。
/// 用一个静态单例而不是到处 `&HashSet::new()`：后者要在每个调用点持有临时变量，
/// 容易写成 `&HashSet::new()` 的悬垂借用；且「没有排除」是最常见的默认值。
pub fn no_exclusions() -> &'static HashSet<String> {
    static EMPTY: std::sync::OnceLock<HashSet<String>> = std::sync::OnceLock::new();
    EMPTY.get_or_init(HashSet::new)
}

impl<'a> PickInput<'a> {
    /// 测试与「无排除 / 默认策略」调用点的便捷构造。
    pub fn new(
        realm: Option<RealmTag>,
        model: &'a str,
        tried: &'a HashSet<String>,
        seed: u64,
    ) -> Self {
        Self {
            realm,
            model,
            tried,
            excluded: no_exclusions(),
            // 便捷构造 = 「无排除、无白名单」的最小输入（测试与简单场景用）。
            allowed: None,
            mode: PickMode::Weighted,
            seed,
        }
    }
}

fn entry_usable<E: PoolEntryLike>(
    entry: &E,
    policy: &PickPolicy,
    now_ms: i64,
    model: &str,
) -> bool {
    entry.healthy_for_request(now_ms, model) && !in_flight_full(entry, policy, now_ms)
}

fn in_allowed(input: &PickInput<'_>, uid: &str) -> bool {
    match input.allowed {
        None => true,
        Some(allowed) => allowed.contains(uid),
    }
}

/// 「此刻能不能被选中」= 健康 ∧ 未占满在途 ∧ **不在排除名单里** ∧ **在允许名单里**。
///
/// 排除与「健康」正交：前者是**用户意图**（不想让网关用它），后者是账号状态。
/// 但两者对选号的后果相同 —— 都不能选。因此必须收敛到**同一个谓词**上，
/// 否则「自动选号跳过了、偏好/兜底没跳过」这类缺陷一定会出现（且不报错）。
fn selectable<E: PoolEntryLike>(
    entry: &E,
    policy: &PickPolicy,
    now_ms: i64,
    model: &str,
    excluded: &HashSet<String>,
    allowed: Option<&HashSet<String>>,
) -> bool {
    !excluded.contains(entry.uid())
        && allowed.map(|set| set.contains(entry.uid())).unwrap_or(true)
        && entry_usable(entry, policy, now_ms, model)
}

/// 指定 uid 此刻是否可用于该请求（**与 [`pick`] 同一套判据**，见 [`selectable`]）。
///
/// 供**会话粘性**与**指定账号偏好**使用：两者都要先问「那个账号还能不能用」，
/// 能用就复用、不能用就换号。
pub fn is_usable<E: PoolEntryLike>(
    entries: &BTreeMap<String, E>,
    policy: &PickPolicy,
    uid: &str,
    now_ms: i64,
    model: &str,
    excluded: &HashSet<String>,
    allowed: Option<&HashSet<String>>,
) -> bool {
    entries
        .get(uid)
        .map(|entry| selectable(entry, policy, now_ms, model, excluded, allowed))
        .unwrap_or(false)
}

/// `pub(crate)`：`Pool::summary` 统计 `PoolSummary::in_flight_full` 复用**同一判据**
/// —— 卡片说「可用」而选号一个都不给，就是从这里开始分家的。
pub(crate) fn in_flight_full<E: PoolEntryLike>(
    entry: &E,
    policy: &PickPolicy,
    now_ms: i64,
) -> bool {
    let limit = match entry.realm() {
        Some(RealmTag::Global) if policy.max_in_flight_global > 0 => policy.max_in_flight_global,
        _ => policy.max_in_flight,
    };
    limit > 0 && entry.in_flight_now(now_ms) >= limit
}

pub fn model_cooling_until<E: PoolEntryLike>(
    entries: &BTreeMap<String, E>,
    policy: &PickPolicy,
    now_ms: i64,
    input: &PickInput<'_>,
) -> Option<(i64, usize)> {
    if input.model.is_empty() {
        return None;
    }
    let mut cooled = 0usize;
    let mut latest = 0i64;
    for entry in entries.values() {
        if input.tried.contains(entry.uid()) {
            continue;
        }
        if input
            .realm
            .map(|wanted| entry.realm() == Some(wanted))
            .unwrap_or(true)
            == false
        {
            continue;
        }
        if input.excluded.contains(entry.uid()) {
            continue;
        }
        if let Some(allowed) = input.allowed {
            if !allowed.contains(entry.uid()) {
                continue;
            }
        }
        // 「除了该模型的冷却之外」是否可试：账号级健康 + 未在途占满。
        if !entry.account_healthy(now_ms) || in_flight_full(entry, policy, now_ms) {
            continue;
        }
        let until = entry.model_cool_expiry_ms(input.model);
        if until <= now_ms {
            // 有一个号其实能服务这个模型 ⇒ 不是「整体被限流」。
            return None;
        }
        cooled += 1;
        latest = latest.max(until);
    }
    (cooled > 0).then_some((latest, cooled))
}

pub fn pick<E: PoolEntryLike>(
    entries: &mut BTreeMap<String, E>,
    pick_seq: &mut u64,
    policy: &PickPolicy,
    now_ms: i64,
    input: &PickInput<'_>,
) -> Option<String> {
    // 惰性清理过期的模型级冷却（与选号共用同一次写锁窗口）。
    for entry in entries.values_mut() {
        entry.prune_model_cooldowns(now_ms);
    }

    let candidate_uids: Vec<String> = entries
        .values()
        .filter(|entry| {
            !input.tried.contains(entry.uid())
                && selectable(
                    *entry,
                    policy,
                    now_ms,
                    input.model,
                    input.excluded,
                    input.allowed,
                )
                && input
                    .realm
                    .map(|wanted| entry.realm() == Some(wanted))
                    .unwrap_or(true)
        })
        .map(|entry| entry.uid().to_string())
        .collect();

    if candidate_uids.is_empty() {
        return pick_earliest_expiry(entries, policy, now_ms, input);
    }

    // 归一化基准：分层过滤**之前**的候选集最大值。
    let max_credits = candidate_uids
        .iter()
        .filter_map(|uid| entries.get(uid))
        .map(|entry| entry.credits())
        .max()
        .unwrap_or(0);

    let mut candidates: Vec<Candidate> = candidate_uids
        .iter()
        .filter_map(|uid| entries.get(uid))
        .map(|entry| Candidate {
            uid: entry.uid().to_string(),
            weight: weight_of_model(entry, max_credits, now_ms, policy, input.model),
            credits: entry.credits(),
            cost_per_1k: entry.cost_per_1k(now_ms, input.model, policy.model_cost_ttl_ms),
            used_seq: entry.used_seq(),
            last_used_ms: entry.last_used_ms(),
            tier: entry
                .cost_tier(now_ms, input.model, policy.model_cost_ttl_ms)
                .rank(),
        })
        .collect();

    let best_tier = candidates
        .iter()
        .map(|candidate| candidate.tier)
        .min()
        .unwrap_or(CostTier::Unknown.rank());
    candidates.retain(|candidate| candidate.tier == best_tier);

    match input.mode {
        PickMode::Random => {
            // 均匀抽签：先按 uid 排序（`BTreeMap` 的遍历序天然有序，但 `retain` 之后
            // 仍要显式排序才不依赖实现细节），再取一个下标 ⇒ 同 seed 同结果。
            candidates.sort_by(|left, right| left.uid.cmp(&right.uid));
            let mut rng = Pcg32::new(input.seed, candidates.len() as u64 + 1);
            let index = rng.below(candidates.len() as u64) as usize;
            let uid = candidates[index].uid.clone();
            return Some(mark_selected(entries, uid, now_ms, pick_seq));
        }
        PickMode::MaxCredits => {
            // 积分降序；并列时用权重、再并列用 uid，保证可复现。
            candidates.sort_by(|left, right| {
                right
                    .credits
                    .cmp(&left.credits)
                    .then(
                        right
                            .weight
                            .partial_cmp(&left.weight)
                            .unwrap_or(std::cmp::Ordering::Equal),
                    )
                    .then(left.uid.cmp(&right.uid))
            });
            let uid = candidates.first()?.uid.clone();
            return Some(mark_selected(entries, uid, now_ms, pick_seq));
        }
        PickMode::Sequential => {
            candidates.sort_by(|left, right| {
                right
                    .used_seq
                    .cmp(&left.used_seq)
                    .then(left.uid.cmp(&right.uid))
            });
            let uid = candidates.first()?.uid.clone();
            return Some(mark_selected(entries, uid, now_ms, pick_seq));
        }
        PickMode::Weighted => {}
    }

    // 等权重洗牌：仅当候选超过短名单长度且存在权重并列时执行。
    // 作用：让并列组的 Top-5 不总是同一批 uid（否则短名单会退化成 uid 序前 5 名）。
    let mut rng = Pcg32::new(input.seed, candidates.len() as u64 + 1);
    if candidates.len() > SHORTLIST_SIZE {
        let reference = candidates[0].weight;
        let has_tie = candidates
            .iter()
            .any(|candidate| (candidate.weight - reference).abs() < WEIGHT_EPSILON);
        if has_tie {
            rng.shuffle(&mut candidates);
        }
    }

    // 稳定排序：单价升序 → 权重降序。并列项保持上一步的（可能已打乱的）相对顺序；
    // 未洗牌时并列项保持 BTreeMap 的 uid 升序，因此测试可复现。
    candidates.sort_by(|left, right| {
        left.cost_per_1k
            .partial_cmp(&right.cost_per_1k)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                right
                    .weight
                    .partial_cmp(&left.weight)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    let shortlist_len = candidates.len().min(SHORTLIST_SIZE);
    let shortlist = &candidates[..shortlist_len];

    // 防惊群：短名单内剔除「刚被选过」的账号。被挤出的号**不回填**——
    // 回填会让短名单失去「限流」作用。
    let eligible: Vec<&Candidate> = shortlist
        .iter()
        .filter(|candidate| {
            candidate.last_used_ms <= 0
                || now_ms.saturating_sub(candidate.last_used_ms) >= policy.min_pick_gap_ms
        })
        .collect();

    let chosen_uid = if eligible.is_empty() {
        // LRU 兜底：短名单全被防惊群剔除时，取**全局** used_seq 最小者
        // （与时钟精度无关，因此不受系统时间回拨影响）。
        candidates
            .iter()
            .min_by_key(|candidate| candidate.used_seq)
            .map(|candidate| candidate.uid.clone())
    } else if policy.deterministic {
        // 严格择优：`eligible` 保持排序（单价升序 → 权重降序），首元素即最优。
        eligible.first().map(|candidate| candidate.uid.clone())
    } else {
        draw_weighted(&eligible, &mut rng).map(|candidate| candidate.uid.clone())
    };

    chosen_uid.map(|uid| mark_selected(entries, uid, now_ms, pick_seq))
}

/// 记一次「被选中」：推进 `pick_seq` 并写回 `last_used` / `used_seq`。
///
/// 三条出口（加权 / 积分择优 / 随机）共用它 —— 否则「随机模式下 LRU 语义不生效」
/// 这类缺陷会藏在一个分支里，而三个分支的测试都得各写一遍。
fn mark_selected<E: PoolEntryLike>(
    entries: &mut BTreeMap<String, E>,
    uid: String,
    now_ms: i64,
    pick_seq: &mut u64,
) -> String {
    *pick_seq += 1;
    if let Some(entry) = entries.get_mut(&uid) {
        entry.mark_picked(now_ms, *pick_seq);
    }
    uid
}

pub fn pick_with_preference<E: PoolEntryLike>(
    entries: &mut BTreeMap<String, E>,
    pick_seq: &mut u64,
    policy: &PickPolicy,
    now_ms: i64,
    input: &PickInput<'_>,
    preferred_uid: Option<&str>,
) -> Option<String> {
    if let Some(uid) = preferred_uid {
        let preferred_usable = !input.tried.contains(uid)
            && is_usable(
                entries,
                policy,
                uid,
                now_ms,
                input.model,
                input.excluded,
                input.allowed,
            )
            && input
                .realm
                .map(|wanted| entries.get(uid).and_then(|entry| entry.realm()) == Some(wanted))
                .unwrap_or(true);
        if preferred_usable {
            return Some(mark_selected(entries, uid.to_string(), now_ms, pick_seq));
        }
    }
    pick(entries, pick_seq, policy, now_ms, input)
}

/// 加权抽签：`wi = round(w * 1e6)`，下界 1；前缀累积首个命中者胜出。
fn draw_weighted<'a>(items: &[&'a Candidate], rng: &mut Pcg32) -> Option<&'a Candidate> {
    if items.is_empty() {
        return None;
    }
    let weights: Vec<i64> = items
        .iter()
        .map(|item| {
            let scaled = item.weight * DRAW_SCALE;
            if !scaled.is_finite() || scaled < 1.0 {
                1
            } else {
                scaled.round() as i64
            }
        })
        .collect();
    let total: i64 = weights.iter().sum();
    if total <= 0 {
        return items.first().copied();
    }

    let mut ticket = rng.below(total as u64) as i64;
    for (index, weight) in weights.iter().enumerate() {
        if ticket < *weight {
            return Some(items[index]);
        }
        ticket -= weight;
    }
    items.last().copied()
}

fn effective_cool_expiry_ms<E: PoolEntryLike>(entry: &E, model: &str) -> i64 {
    entry
        .cool_expiry_ms()
        .max(entry.model_cool_expiry_ms(model))
}

fn pick_earliest_expiry<E: PoolEntryLike>(
    entries: &mut BTreeMap<String, E>,
    policy: &PickPolicy,
    now_ms: i64,
    input: &PickInput<'_>,
) -> Option<String> {
    let candidate = entries
        .values()
        .filter(|entry| {
            if input.tried.contains(entry.uid())
                || entry.is_disabled()
                || input.excluded.contains(entry.uid())
                || !in_allowed(input, entry.uid())
            {
                return false;
            }
            if let Some(wanted) = input.realm {
                if entry.realm() != Some(wanted) {
                    return false;
                }
            }
            if in_flight_full(*entry, policy, now_ms) {
                return false;
            }
            // 硬冷却期间余额不足，强试无意义。
            if entry.is_hard_cooled(now_ms) {
                return false;
            }
            effective_cool_expiry_ms(*entry, input.model) > 0
        })
        .min_by_key(|entry| {
            (
                effective_cool_expiry_ms(*entry, input.model),
                entry.uid().to_string(),
            )
        })
        .map(|entry| entry.uid().to_string())?;

    if let Some(entry) = entries.get_mut(&candidate) {
        entry.mark_probed(now_ms);
    }
    Some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pool::entry::PoolEntry;
    use crate::pool::ModelCooldown;

    fn policy() -> PickPolicy {
        PickPolicy {
            expiring_weight: 8.0,
            // WorkBuddy 不启用独立紧迫度因子（它的紧迫度由 `expiring_weight` 表达）。
            expiry_urgency_weight: 0.0,
            idle_weight_per_hour: 0.5,
            idle_weight_max: 5.0,
            min_pick_gap_ms: 100,
            model_cost_ttl_ms: 6 * 60 * 60 * 1000,
            max_in_flight: 3,
            max_in_flight_global: 2,
            // 保持 WorkBuddy 既有的有界随机语义。
            deterministic: false,
        }
    }

    fn pool_of(entries: Vec<PoolEntry>) -> BTreeMap<String, PoolEntry> {
        entries
            .into_iter()
            .map(|entry| (entry.uid.clone(), entry))
            .collect()
    }

    fn base_entry(uid: &str) -> PoolEntry {
        PoolEntry::new(uid)
    }

    const NOW: i64 = 1_000_000_000_000;

    #[allow(clippy::too_many_arguments)]
    // 测试夹具的参数逐项对应一个约束维度。
    /// 测试用简写：默认策略（加权）+ 不排除任何账号。
    ///
    /// `PickInput` 是生产签名的唯一入口；这里保留旧的位置参数形式，是为了让
    /// 二十多个既有选号用例**逐字不动** —— 它们测的是算法，不是参数打包。
    fn pick(
        entries: &mut BTreeMap<String, PoolEntry>,
        pick_seq: &mut u64,
        policy: &PickPolicy,
        now_ms: i64,
        realm: Option<RealmTag>,
        model: &str,
        tried: &HashSet<String>,
        seed: u64,
    ) -> Option<String> {
        super::pick(
            entries,
            pick_seq,
            policy,
            now_ms,
            &PickInput::new(realm, model, tried, seed),
        )
    }

    fn entries_of(uids: &[&str]) -> BTreeMap<String, PoolEntry> {
        uids.iter()
            .map(|uid| (uid.to_string(), base_entry(uid)))
            .collect()
    }

    fn uid_set(uids: &[&str]) -> HashSet<String> {
        uids.iter().map(|uid| uid.to_string()).collect()
    }

    #[test]
    fn every_pick_mode_honours_the_allowlist() {
        for mode in [
            PickMode::Weighted,
            PickMode::MaxCredits,
            PickMode::Random,
            PickMode::Sequential,
        ] {
            let mut entries = entries_of(&["a", "b"]);
            let allowed = uid_set(&["a"]);
            let tried = HashSet::new();
            let input = PickInput {
                realm: None,
                model: "m",
                tried: &tried,
                excluded: no_exclusions(),
                allowed: Some(&allowed),
                mode,
                seed: 7,
            };
            let mut seq = 0;
            let picked = super::pick(&mut entries, &mut seq, &policy(), NOW, &input);
            assert_eq!(
                picked.as_deref(),
                Some("a"),
                "{mode:?} 必须只选白名单内的账号（b 不在名单里）"
            );
        }
    }

    #[test]
    fn preference_cannot_escape_the_allowlist() {
        let mut entries = entries_of(&["a", "b"]);
        let allowed = uid_set(&["a"]);
        let tried = HashSet::new();
        let input = PickInput {
            realm: None,
            model: "m",
            tried: &tried,
            excluded: no_exclusions(),
            allowed: Some(&allowed),
            mode: PickMode::Weighted,
            seed: 3,
        };
        let mut seq = 0;
        let picked =
            super::pick_with_preference(&mut entries, &mut seq, &policy(), NOW, &input, Some("b"));
        assert_eq!(
            picked.as_deref(),
            Some("a"),
            "偏好指向名单外的号时必须回落到名单内，而不是照办"
        );
    }

    #[test]
    fn fallback_never_jumps_outside_the_allowlist() {
        let mut entries = entries_of(&["a", "b"]);
        let allowed = uid_set(&["a"]);
        // 两个号都在冷却（`pick_earliest_expiry` 的语义就是「从冷却中的号里挑最早到期的
        // 去强试」），且 b 更早到期 ⇒ 它天然是兜底首选，而它**不在**名单里。
        entries.get_mut("a").unwrap().until_ms = NOW + 60_000;
        entries.get_mut("b").unwrap().until_ms = NOW + 30_000;

        let tried = HashSet::new();
        let input = PickInput {
            realm: None,
            model: "m",
            tried: &tried,
            excluded: no_exclusions(),
            allowed: Some(&allowed),
            mode: PickMode::Weighted,
            seed: 11,
        };
        let picked = super::pick_earliest_expiry(&mut entries, &policy(), NOW, &input);
        assert_ne!(
            picked.as_deref(),
            Some("b"),
            "兜底绝不能越过白名单 —— 那等于用别人的账号刷额度"
        );
        // 反向对照：名单**包含两者**时，b 是合法兜底目标（证明上面的断言不是因为
        // 「兜底根本选不出东西」而假绿）。
        let both = uid_set(&["a", "b"]);
        let input_both = PickInput {
            allowed: Some(&both),
            ..input
        };
        let picked = super::pick_earliest_expiry(&mut entries, &policy(), NOW, &input_both);
        assert_eq!(picked.as_deref(), Some("b"), "白名单放宽后兜底应当能选中 b");
    }

    /// `excluded` 同样要在**三条路径**上生效：通用选号 / 偏好 / 兜底。
    #[test]
    fn exclusions_apply_on_every_selection_path() {
        let mut entries = entries_of(&["a", "b"]);
        let excluded = uid_set(&["a"]);
        let tried = HashSet::new();
        let input = PickInput {
            realm: None,
            model: "m",
            tried: &tried,
            excluded: &excluded,
            allowed: None,
            mode: PickMode::Weighted,
            seed: 5,
        };
        let mut seq = 0;

        // ① 通用选号
        let picked = super::pick(&mut entries, &mut seq, &policy(), NOW, &input);
        assert_eq!(picked.as_deref(), Some("b"), "被排除的号不得被自动选中");

        // ② 偏好（用户显式指定了被排除的号 —— 硬排除语义优先）
        let picked =
            super::pick_with_preference(&mut entries, &mut seq, &policy(), NOW, &input, Some("a"));
        assert_eq!(
            picked.as_deref(),
            Some("b"),
            "被排除的号即使被显式指定也不可用（硬排除）"
        );

        // ③ 兜底
        let picked = super::pick_earliest_expiry(&mut entries, &policy(), NOW, &input);
        assert_ne!(
            picked.as_deref(),
            Some("a"),
            "兜底同样受排除约束（改造前这条路径就查 excluded，此处钉住它别被删）"
        );
    }

    /// 同上，用于 `is_usable`（不排除任何账号）。
    fn is_usable(
        entries: &BTreeMap<String, PoolEntry>,
        policy: &PickPolicy,
        uid: &str,
        now_ms: i64,
        model: &str,
    ) -> bool {
        super::is_usable(entries, policy, uid, now_ms, model, no_exclusions(), None)
    }

    #[test]
    fn model_scoped_ema_does_not_punish_other_models() {
        let mut flaky = base_entry("flaky");
        let mut clean = base_entry("clean");
        // 两者账号级 EMA 完全相同（中性 0.5 / 0.5）—— 只有**分模型**证据不同。
        for entry in [&mut flaky, &mut clean] {
            entry.success_ema = 0.5;
            entry.error_ema = 0.5;
        }
        for _ in 0..3 {
            flaky.note_model_result("mA", false);
        }
        for _ in 0..3 {
            flaky.note_model_result("mB", true);
        }

        let bad_model = weight_of_model(&flaky, 0, NOW, &policy(), "mA");
        let good_model = weight_of_model(&flaky, 0, NOW, &policy(), "mB");
        let neutral = weight_of_model(&clean, 0, NOW, &policy(), "mB");

        assert!(
            good_model > bad_model,
            "同一账号在「它能用的模型」上权重必须更高：mB={good_model} mA={bad_model}"
        );
        assert!(
            good_model > neutral,
            "有该模型成功证据的号必须高于只有账号级中性证据的号：{good_model} vs {neutral}"
        );

        // 样本不足 ⇒ 回落到账号级（1 次偶发失败不该改变评价）。
        let mut fresh = base_entry("fresh");
        fresh.success_ema = 0.5;
        fresh.error_ema = 0.5;
        fresh.note_model_result("mC", false);
        assert!(
            (weight_of_model(&fresh, 0, NOW, &policy(), "mC")
                - weight_of(&fresh, 0, NOW, &policy()))
            .abs()
                < 1e-9,
            "样本 < MODEL_EMA_MIN_SAMPLES 时必须回落到账号级 EMA"
        );
    }

    #[test]
    fn parse_preferred_maps_sentinels_to_modes() {
        assert_eq!(parse_preferred(None), (PickMode::Weighted, None));
        assert_eq!(parse_preferred(Some("")), (PickMode::Weighted, None));
        assert_eq!(parse_preferred(Some("  ")), (PickMode::Weighted, None));
        assert_eq!(
            parse_preferred(Some(PREFERRED_AUTO)),
            (PickMode::Weighted, None)
        );
        assert_eq!(
            parse_preferred(Some(PREFERRED_MAX_CREDITS)),
            (PickMode::MaxCredits, None)
        );
        assert_eq!(
            parse_preferred(Some(PREFERRED_RANDOM)),
            (PickMode::Random, None)
        );
        assert_eq!(
            parse_preferred(Some(PREFERRED_SEQUENTIAL)),
            (PickMode::Sequential, None)
        );
        // 普通 uid ⇒ 仍是「偏好」（不是策略）
        assert_eq!(
            parse_preferred(Some("uid-1")),
            (PickMode::Weighted, Some("uid-1"))
        );
        // 前后空白要吃掉（前端偶尔会带）
        assert_eq!(
            parse_preferred(Some(" __random__ ")),
            (PickMode::Random, None)
        );
    }

    /// 带策略的选号（测试用；`PickInput::new` 恒为加权档）。
    // 参数逐项对应一个约束维度（与上面的 `pick` 夹具同形），不为过 lint 而合并。
    #[allow(clippy::too_many_arguments)]
    fn pick_with_mode(
        entries: &mut BTreeMap<String, PoolEntry>,
        pick_seq: &mut u64,
        policy: &PickPolicy,
        now_ms: i64,
        model: &str,
        tried: &HashSet<String>,
        mode: PickMode,
        seed: u64,
    ) -> Option<String> {
        super::pick(
            entries,
            pick_seq,
            policy,
            now_ms,
            &PickInput {
                realm: None,
                model,
                tried,
                excluded: no_exclusions(),
                allowed: None,
                mode,
                seed,
            },
        )
    }

    #[test]
    fn sequential_sticks_to_the_same_account() {
        let mut entries = pool_of(vec![base_entry("a"), base_entry("b"), base_entry("c")]);
        let mut seq = 0u64;
        let mut seen = Vec::new();
        for round in 0..5u64 {
            let uid = pick_with_mode(
                &mut entries,
                &mut seq,
                &policy(),
                NOW,
                "m",
                &HashSet::new(),
                PickMode::Sequential,
                round,
            )
            .expect("必须有候选");
            seen.push(uid);
        }
        assert!(
            seen.iter().all(|uid| uid == "a"),
            "顺序档必须一直用同一个号（uid 序第一个）：{seen:?}"
        );
    }

    #[test]
    fn sequential_moves_to_next_only_when_current_is_unusable() {
        let mut entries = pool_of(vec![base_entry("a"), base_entry("b")]);
        let mut seq = 0u64;

        let first = pick_with_mode(
            &mut entries,
            &mut seq,
            &policy(),
            NOW,
            "m",
            &HashSet::new(),
            PickMode::Sequential,
            1,
        )
        .expect("必须有候选");
        assert_eq!(first, "a", "冷启动取 uid 序第一个");

        // a 被账号级限流 ⇒ 不可用 ⇒ 换 b。
        entries
            .get_mut("a")
            .expect("a 存在")
            .cooldown_fixed(NOW, 60_000, "429 账号级限流");
        let second = pick_with_mode(
            &mut entries,
            &mut seq,
            &policy(),
            NOW,
            "m",
            &HashSet::new(),
            PickMode::Sequential,
            2,
        )
        .expect("必须有候选");
        assert_eq!(second, "b", "当前号被限流后必须换下一个");

        // a 的冷却到期（60s 后）：**仍然留在 b** —— b 已是当前号。
        let third = pick_with_mode(
            &mut entries,
            &mut seq,
            &policy(),
            NOW + 61_000,
            "m",
            &HashSet::new(),
            PickMode::Sequential,
            3,
        )
        .expect("必须有候选");
        assert_eq!(
            third, "b",
            "冷却恢复后不得把请求从 b 抢回 a —— 那等于每 60 秒清一次缓存"
        );
    }

    #[test]
    fn sequential_respects_tried_and_exclusions() {
        let mut entries = pool_of(vec![base_entry("a"), base_entry("b"), base_entry("c")]);
        let mut seq = 0u64;
        let mut tried = HashSet::new();
        tried.insert("a".to_string());
        let uid = pick_with_mode(
            &mut entries,
            &mut seq,
            &policy(),
            NOW,
            "m",
            &tried,
            PickMode::Sequential,
            1,
        )
        .expect("必须有候选");
        assert_eq!(uid, "b", "本轮已试过的号不得再被选中");

        let excluded: HashSet<String> = ["b".to_string()].into_iter().collect();
        let input = PickInput {
            realm: None,
            model: "m",
            tried: &HashSet::new(),
            excluded: &excluded,
            allowed: None,
            mode: PickMode::Sequential,
            seed: 2,
        };
        let uid = super::pick(&mut entries, &mut seq, &policy(), NOW, &input).expect("必须有候选");
        assert_eq!(uid, "a", "排除是硬约束：被排除的号即使「最近用过」也不能选");
    }

    #[test]
    fn weight_increases_with_credit_ratio_and_is_bounded() {
        let mut small = base_entry("small");
        small.credits = 100;
        let mut big = base_entry("big");
        big.credits = 1000;

        let small_weight = weight_of(&small, 1000, NOW, &policy());
        let big_weight = weight_of(&big, 1000, NOW, &policy());

        // 基准 1 + 积分项 10 + 闲置项 5（从未使用）+ 成功率项 1.5 = 17.5
        assert!(
            (big_weight - 17.5).abs() < 1e-9,
            "满配应约 17.5，实际 {big_weight}"
        );
        assert!(
            (small_weight - (1.0 + 1.0 + 5.0 + 1.5)).abs() < 1e-9,
            "实际 {small_weight}"
        );
        assert!(big_weight > small_weight);
    }

    #[test]
    fn zero_max_credits_skips_credit_term_instead_of_uniformizing() {
        let mut entry = base_entry("a");
        entry.credits = 0;
        // max=0 时积分项跳过：1 + 闲置 5 + 成功率 1.5 = 7.5
        let weight = weight_of(&entry, 0, NOW, &policy());
        assert!((weight - 7.5).abs() < 1e-9, "实际 {weight}");
    }

    #[test]
    fn expiring_ratio_uses_own_credits_as_denominator() {
        let mut entry = base_entry("a");
        entry.credits = 1000;
        entry.credits_expiring = 500;
        entry.last_used_ms = NOW; // 闲置项归零
                                  // 1 + 10 + 0.5*8 + 1.5 = 16.5
        let weight = weight_of(&entry, 1000, NOW, &policy());
        assert!((weight - 16.5).abs() < 1e-9, "实际 {weight}");

        // 占比超过 100% 时必须钳制（脏数据防御）
        entry.credits_expiring = 5000;
        let clamped = weight_of(&entry, 1000, NOW, &policy());
        assert!(
            (clamped - 20.5).abs() < 1e-9,
            "占比应钳到 1.0，实际 {clamped}"
        );
    }

    #[test]
    fn idle_weight_is_capped_and_never_used_gets_max() {
        let mut entry = base_entry("a");
        entry.last_used_ms = 0;
        let never_used = weight_of(&entry, 0, NOW, &policy());
        entry.last_used_ms = NOW - 100 * 3_600_000; // 闲置 100 小时
        let long_idle = weight_of(&entry, 0, NOW, &policy());
        assert!((never_used - long_idle).abs() < 1e-9, "两者都应取上限 5.0");

        entry.last_used_ms = NOW - 3_600_000; // 闲置 1 小时
        let one_hour = weight_of(&entry, 0, NOW, &policy());
        assert!(
            (one_hour - (1.0 + 0.5 + 1.5)).abs() < 1e-9,
            "1 小时闲置 → 0.5 权重，实际 {one_hour}"
        );
    }

    #[test]
    fn success_ratio_uses_ema_and_defaults_to_neutral() {
        let mut good = base_entry("good");
        good.success_ema = 0.9;
        good.error_ema = 0.1;
        let good_weight = weight_of(&good, 0, NOW, &policy());
        // 1 + 闲置 5 + 0.9*3 = 8.7
        assert!((good_weight - 8.7).abs() < 1e-9, "实际 {good_weight}");

        let neutral = base_entry("neutral");
        let neutral_weight = weight_of(&neutral, 0, NOW, &policy());
        assert!((neutral_weight - 7.5).abs() < 1e-9, "无记录应取 1.5");
        assert!(good_weight > neutral_weight);
    }

    #[test]
    fn in_flight_full_blocks_candidate() {
        let mut entry = base_entry("a");
        entry.in_flight = 3;
        let mut pool = pool_of(vec![entry]);
        let mut seq = 0;
        assert_eq!(
            pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "",
                &HashSet::new(),
                1
            ),
            None,
            "占满在途的账号不得被选中"
        );
    }

    #[test]
    fn zero_max_in_flight_means_unlimited() {
        let mut entry = base_entry("a");
        entry.in_flight = 99;
        let mut pool = pool_of(vec![entry]);
        let mut seq = 0;
        let mut relaxed = policy();
        relaxed.max_in_flight = 0;
        assert!(pick(
            &mut pool,
            &mut seq,
            &relaxed,
            NOW,
            None,
            "",
            &HashSet::new(),
            1
        )
        .is_some());
    }

    #[test]
    fn realm_filter_isolates_cn_and_global() {
        let mut cn = base_entry("cn-1");
        cn.realm = Some(RealmTag::Cn);
        let mut global = base_entry("global-1");
        global.realm = Some(RealmTag::Global);
        let mut pool = pool_of(vec![cn, global]);
        let mut seq = 0;

        assert_eq!(
            pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                Some(RealmTag::Global),
                "",
                &HashSet::new(),
                1
            ),
            Some("global-1".to_string())
        );
        assert_eq!(
            pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                Some(RealmTag::Cn),
                "",
                &HashSet::new(),
                2
            ),
            Some("cn-1".to_string())
        );
    }

    #[test]
    fn tried_accounts_are_excluded_across_retries() {
        let mut pool = pool_of(vec![base_entry("a"), base_entry("b")]);
        let mut seq = 0;

        let first = pick(
            &mut pool,
            &mut seq,
            &policy(),
            NOW,
            None,
            "",
            &HashSet::new(),
            1,
        )
        .unwrap();
        let mut tried = HashSet::new();
        tried.insert(first.clone());
        let second = pick(&mut pool, &mut seq, &policy(), NOW, None, "", &tried, 2).unwrap();
        assert_ne!(first, second, "换号重试必须换到另一个账号");

        tried.insert(second);
        assert_eq!(
            pick(&mut pool, &mut seq, &policy(), NOW, None, "", &tried, 3),
            None,
            "全部试过后不得重复尝试"
        );
    }

    #[test]
    fn anti_thundering_herd_prefers_untouched_account() {
        // 两个账号权重相同；刚被选中的那个在 100ms 内不应再被选中。
        let mut pool = pool_of(vec![base_entry("a"), base_entry("b")]);
        let mut seq = 0;

        for _ in 0..30 {
            let chosen = pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "",
                &HashSet::new(),
                7,
            )
            .expect("有候选");
            let next = pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "",
                &HashSet::new(),
                7,
            )
            .expect("有候选");
            assert_ne!(chosen, next, "100ms 内不得重复选中同一账号");
        }
    }

    #[test]
    fn lru_fallback_kicks_in_when_shortlist_all_recently_used() {
        // 单账号池：它刚被选中 → 防惊群会剔除它 → 走 LRU 兜底仍返回它
        let mut pool = pool_of(vec![base_entry("only")]);
        let mut seq = 0;
        let first = pick(
            &mut pool,
            &mut seq,
            &policy(),
            NOW,
            None,
            "",
            &HashSet::new(),
            1,
        );
        assert_eq!(first, Some("only".to_string()));
        let second = pick(
            &mut pool,
            &mut seq,
            &policy(),
            NOW,
            None,
            "",
            &HashSet::new(),
            2,
        );
        assert_eq!(
            second,
            Some("only".to_string()),
            "LRU 兜底必须保证不空手而回"
        );
    }

    #[test]
    fn cost_tier_hard_filters_paid_when_free_available() {
        let mut free = base_entry("free");
        free.record_cost(NOW, "m", 0.0, 1000);
        let mut paid = base_entry("paid");
        paid.record_cost(NOW, "m", 9.0, 1000);
        // 让收费号积分极高——若不做分层过滤，它必然胜出
        paid.credits = 1_000_000;
        free.credits = 0;

        let mut pool = pool_of(vec![free, paid]);
        let mut seq = 0;
        for seed in 0..20 {
            let chosen = pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "m",
                &HashSet::new(),
                seed,
            )
            .expect("有候选");
            assert_eq!(chosen, "free", "实测免费号必须硬胜过积分高的收费号");
        }
    }

    #[test]
    fn unknown_tier_keeps_learning_opportunity() {
        let mut paid = base_entry("paid");
        paid.record_cost(NOW, "m", 9.0, 1000);
        paid.credits = 1_000_000;
        let unknown = base_entry("unknown");

        let mut pool = pool_of(vec![paid, unknown]);
        let mut seq = 0;
        let chosen = pick(
            &mut pool,
            &mut seq,
            &policy(),
            NOW,
            None,
            "m",
            &HashSet::new(),
            3,
        )
        .expect("有候选");
        assert_eq!(chosen, "unknown", "无观测号应保留被观测的机会");
    }

    #[test]
    fn expired_cost_observation_falls_back_to_unknown() {
        let mut entry = base_entry("a");
        entry.record_cost(0, "m", 9.0, 1000); // 很久以前
        assert_eq!(
            entry.cost_tier(NOW, "m", policy().model_cost_ttl_ms),
            CostTier::Unknown,
            "超 TTL 的观测视为无观测"
        );
    }

    #[test]
    fn pick_marks_last_used_and_advances_sequence() {
        let mut pool = pool_of(vec![base_entry("a")]);
        let mut seq = 0;
        pick(
            &mut pool,
            &mut seq,
            &policy(),
            NOW,
            None,
            "",
            &HashSet::new(),
            1,
        );
        let entry = pool.get("a").expect("存在");
        assert_eq!(entry.last_used_ms, NOW);
        assert_eq!(entry.used_seq, 1);
        assert_eq!(seq, 1);
    }

    #[test]
    fn pick_is_deterministic_for_same_seed() {
        let build = || pool_of(vec![base_entry("a"), base_entry("b"), base_entry("c")]);
        let mut pool_a = build();
        let mut pool_b = build();
        let mut seq_a = 0;
        let mut seq_b = 0;
        for _ in 0..10 {
            let left = pick(
                &mut pool_a,
                &mut seq_a,
                &policy(),
                NOW,
                None,
                "",
                &HashSet::new(),
                42,
            );
            let right = pick(
                &mut pool_b,
                &mut seq_b,
                &policy(),
                NOW,
                None,
                "",
                &HashSet::new(),
                42,
            );
            assert_eq!(left, right, "同种子必须选出同一账号");
        }
    }

    #[test]
    fn empty_pool_returns_none() {
        let mut pool: BTreeMap<String, PoolEntry> = BTreeMap::new();
        let mut seq = 0;
        assert_eq!(
            pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "",
                &HashSet::new(),
                1
            ),
            None
        );
    }

    #[test]
    fn all_cooling_falls_back_to_earliest_expiry() {
        let mut soon = base_entry("soon");
        soon.cooldown_fixed(NOW, 1000, "404");
        let mut late = base_entry("late");
        late.cooldown_fixed(NOW, 60_000, "429");
        let mut pool = pool_of(vec![soon, late]);
        let mut seq = 0;
        assert_eq!(
            pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "",
                &HashSet::new(),
                1
            ),
            Some("soon".to_string()),
            "全冷却时选最早解冻者"
        );
    }

    #[test]
    fn hard_cooled_accounts_are_excluded_from_expiry_fallback() {
        let mut hard = base_entry("hard");
        hard.cooldown_until_tomorrow_4am(NOW, "余额不足");
        let mut pool = pool_of(vec![hard]);
        let mut seq = 0;
        assert_eq!(
            pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "",
                &HashSet::new(),
                1
            ),
            None,
            "硬冷却（余额不足）不得被兜底强试"
        );
    }

    #[test]
    fn disabled_accounts_never_selected() {
        let mut disabled = base_entry("disabled");
        disabled.disable("12153 session dead");
        let mut pool = pool_of(vec![disabled]);
        let mut seq = 0;
        assert_eq!(
            pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "",
                &HashSet::new(),
                1
            ),
            None
        );
    }

    #[test]
    fn model_cooldown_falls_back_to_a_probe_instead_of_giving_up() {
        let mut entry = base_entry("a");
        entry.cooldown_model(NOW, "glm-5.2", 0, 60_000, "6004", false);
        let mut pool = pool_of(vec![entry]);
        let mut seq = 0;
        assert_eq!(
            pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "glm-5.2",
                &HashSet::new(),
                1
            ),
            Some("a".to_string()),
            "只剩模型级冷却时必须给出一个半开试探号，而不是整池放弃（那会变成 401）"
        );
        // 但它在**择优**阶段仍被视为不可用：冷却未到期时不会因为「健康」被选中。
        // （上面那次是兜底 `pick_earliest_expiry`，走的是 `mark_probed`，不推进 `used_seq`。）
        assert_eq!(pool["a"].used_seq, 0, "兜底强试不得推进 LRU 序号");
        assert_eq!(
            pick(
                &mut pool,
                &mut seq,
                &policy(),
                NOW,
                None,
                "deepseek-v4-flash",
                &HashSet::new(),
                1
            ),
            Some("a".to_string()),
            "其它模型应立即可用"
        );
    }

    #[test]
    fn draw_weighted_respects_weights() {
        let heavy = Candidate {
            uid: "heavy".to_string(),
            weight: 1000.0,
            credits: 0,
            cost_per_1k: 0.0,
            used_seq: 1,
            last_used_ms: 0,
            tier: 0,
        };
        let light = Candidate {
            uid: "light".to_string(),
            weight: 1.0,
            credits: 0,
            cost_per_1k: 0.0,
            used_seq: 2,
            last_used_ms: 0,
            tier: 0,
        };
        let items = vec![&heavy, &light];
        let mut rng = Pcg32::new(1, 1);
        let mut heavy_wins = 0;
        for _ in 0..1000 {
            if draw_weighted(&items, &mut rng).map(|item| item.uid.as_str()) == Some("heavy") {
                heavy_wins += 1;
            }
        }
        assert!(
            heavy_wins > 900,
            "权重 1000:1 应几乎必胜，实际 {heavy_wins}/1000"
        );
    }

    #[test]
    fn draw_weighted_handles_empty_and_zero_weights() {
        let mut rng = Pcg32::new(1, 1);
        assert!(draw_weighted(&[], &mut rng).is_none());

        let zero = Candidate {
            uid: "z".to_string(),
            weight: 0.0,
            credits: 0,
            cost_per_1k: 0.0,
            used_seq: 1,
            last_used_ms: 0,
            tier: 0,
        };
        let items = vec![&zero];
        assert_eq!(
            draw_weighted(&items, &mut rng).map(|item| item.uid.as_str()),
            Some("z"),
            "零权重也应能被选中（下界 1），避免死锁"
        );
    }

    #[test]
    fn is_usable_agrees_with_pick_on_each_state() {
        let policy = policy();

        let healthy = base_entry("healthy");
        let mut saturated = base_entry("saturated");
        saturated.in_flight = 3; // 与 `in_flight_full_blocks_candidate` 同款：占满在途
        let mut cooling = base_entry("cooling");
        cooling.until_ms = NOW + 60_000;

        let map = pool_of(vec![healthy, saturated, cooling]);

        assert!(
            is_usable(&map, &policy, "healthy", NOW, ""),
            "健康账号应可用"
        );
        assert!(
            !is_usable(&map, &policy, "saturated", NOW, ""),
            "在途占满应不可用"
        );
        assert!(
            !is_usable(&map, &policy, "cooling", NOW, ""),
            "冷却中应不可用"
        );
        assert!(
            !is_usable(&map, &policy, "absent", NOW, ""),
            "不在池里应不可用"
        );

        // 同一组条目下 `pick` 必须只挑到 `healthy` —— 与上面三条否定断言互为印证。
        let mut for_pick = map.clone();
        let mut seq = 0;
        assert_eq!(
            pick(
                &mut for_pick,
                &mut seq,
                &policy,
                NOW,
                None,
                "",
                &HashSet::new(),
                1
            )
            .as_deref(),
            Some("healthy"),
            "pick 只能选到 `is_usable` 为 true 的那个"
        );
    }

    /// 模型级冷却也必须被 `is_usable` 看到 —— 粘性传的是**模型名**，
    /// 若这里漏看模型维度，粘性会把请求钉到一个「该模型正被限流」的账号上。
    #[test]
    fn is_usable_honours_model_scoped_cooldown() {
        let policy = policy();
        let mut blocked = base_entry("blocked");
        blocked.model_cooldowns.insert(
            "m1".to_string(),
            ModelCooldown {
                until_ms: NOW + 60_000,
                reset_at_ms: 0,
                upstream_reset_at_ms: 0,
                reason: String::new(),
                hits: 0,
                from_upstream: false,
                verify_fails: 0,
            },
        );
        let map = pool_of(vec![blocked]);

        assert!(
            !is_usable(&map, &policy, "blocked", NOW, "m1"),
            "该模型正被冷却 ⇒ 粘性不得钉住它"
        );
        assert!(
            is_usable(&map, &policy, "blocked", NOW, "m2"),
            "换模型立即可用（模型级限流只封锁该模型）"
        );
    }

    #[test]
    fn is_usable_treats_expired_model_cooldown_as_available() {
        let policy = policy();
        let mut recovered = base_entry("recovered");
        recovered.model_cooldowns.insert(
            "m1".to_string(),
            ModelCooldown {
                until_ms: NOW - 1, // 刚过期
                reset_at_ms: 0,
                upstream_reset_at_ms: 0,
                reason: String::new(),
                hits: 1,
                from_upstream: false,
                verify_fails: 0,
            },
        );
        let map = pool_of(vec![recovered.clone()]);

        assert!(
            is_usable(&map, &policy, "recovered", NOW, "m1"),
            "已过期的模型级冷却不得判为不可用（is_usable 不 prune，判据必须自带过期判断）"
        );

        // 与 pick 的行为互为印证：只有这一个候选，必须能选到它。
        let mut for_pick = pool_of(vec![recovered]);
        let mut seq = 0;
        assert_eq!(
            pick(
                &mut for_pick,
                &mut seq,
                &policy,
                NOW,
                None,
                "m1",
                &HashSet::new(),
                1
            )
            .as_deref(),
            Some("recovered")
        );
    }

    fn cooling_entry(uid: &str, model: &str, until_ms: i64) -> PoolEntry {
        let mut entry = base_entry(uid);
        entry.model_cooldowns.insert(
            model.to_string(),
            ModelCooldown {
                until_ms,
                reset_at_ms: 0,
                upstream_reset_at_ms: 0,
                reason: String::new(),
                hits: 0,
                from_upstream: true,
                verify_fails: 0,
            },
        );
        entry
    }

    fn cooling_input<'a>(
        model: &'a str,
        tried: &'a HashSet<String>,
        excluded: &'a HashSet<String>,
    ) -> PickInput<'a> {
        PickInput {
            realm: None,
            model,
            tried,
            excluded,
            allowed: None,
            mode: PickMode::MaxCredits,
            seed: 0,
        }
    }

    #[test]
    fn model_cooling_until_reports_every_cooled_account() {
        let policy = policy();
        let entries = pool_of(vec![
            cooling_entry("a", "m1", NOW + 60_000),
            cooling_entry("b", "m1", NOW + 120_000),
        ]);
        let (tried, excluded) = (HashSet::new(), HashSet::new());
        let input = cooling_input("m1", &tried, &excluded);
        assert_eq!(
            model_cooling_until(&entries, &policy, NOW, &input),
            Some((NOW + 120_000, 2)),
            "最晚截止 + 账号数都要给对（前者进 Retry-After，后者进文案）"
        );
    }

    #[test]
    fn model_cooling_until_returns_none_when_one_account_is_free() {
        let policy = policy();
        let entries = pool_of(vec![
            cooling_entry("a", "m1", NOW + 60_000),
            base_entry("b"),
        ]);
        let (tried, excluded) = (HashSet::new(), HashSet::new());
        let input = cooling_input("m1", &tried, &excluded);
        assert_eq!(
            model_cooling_until(&entries, &policy, NOW, &input),
            None,
            "还有号能用 ⇒ 不是「整体限流」，不能报 503"
        );
    }

    #[test]
    fn model_cooling_until_ignores_other_models() {
        let policy = policy();
        let entries = pool_of(vec![
            cooling_entry("a", "m1", NOW + 60_000),
            cooling_entry("b", "m1", NOW + 60_000),
        ]);
        let (tried, excluded) = (HashSet::new(), HashSet::new());
        let input = cooling_input("m2", &tried, &excluded);
        assert_eq!(
            model_cooling_until(&entries, &policy, NOW, &input),
            None,
            "冷却的是 m1，请求的是 m2 ⇒ 与本次请求无关，不许报 503"
        );
    }

    #[test]
    fn model_cooling_until_skips_excluded_and_tried_accounts() {
        let policy = policy();
        let entries = pool_of(vec![
            cooling_entry("a", "m1", NOW + 60_000),
            // 唯一「没冷却」的号被排除 / 已试 ⇒ 不参与判定，判据仍成立。
            base_entry("b"),
        ]);
        let mut excluded = HashSet::new();
        excluded.insert("b".to_string());
        let tried = HashSet::new();
        let input = cooling_input("m1", &tried, &excluded);
        assert_eq!(
            model_cooling_until(&entries, &policy, NOW, &input),
            Some((NOW + 60_000, 1)),
            "被排除的号不算「可用账号」—— 否则永远报 401"
        );

        let entries2 = pool_of(vec![
            cooling_entry("a", "m1", NOW + 60_000),
            base_entry("b"),
        ]);
        let mut tried = HashSet::new();
        tried.insert("b".to_string());
        let excluded2 = HashSet::new();
        let input2 = cooling_input("m1", &tried, &excluded2);
        assert_eq!(
            model_cooling_until(&entries2, &policy, NOW, &input2),
            Some((NOW + 60_000, 1)),
            "本轮已试过的号同样不算"
        );
    }
}
