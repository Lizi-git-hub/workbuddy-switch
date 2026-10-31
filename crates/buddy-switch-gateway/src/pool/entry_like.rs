
use crate::pool::entry::CostTier;
use crate::pool::RealmTag;

/// 选号算法所需的账号视图。
///
/// 只暴露 [`crate::pool::pick`] 真正读取的字段与行为；实现方不得在方法里做
/// 与选号无关的副作用（算法会在同一把锁窗口内对全部候选调用它们）。
pub trait PoolEntryLike {
    /// 账号 uid（池键）。
    fn uid(&self) -> &str;

    /// 可用积分总量。
    fn credits(&self) -> i64;

    fn expiring_credits(&self, now_ms: i64) -> i64;

    /// 到期紧迫度 ∈ `[0,1]`：`0` = 不紧迫（无到期信息 / 远未到期），`1` = 即将到期。
    ///
    /// 默认 `0.0`（不启用）。只有具备「积分到期时间」概念的产品线才需要覆写它，
    /// 并在自己的 [`crate::pool::PickPolicy`] 里把
    /// [`expiry_urgency_weight`](crate::pool::PickPolicy::expiry_urgency_weight)
    /// 设为非零值 —— 否则覆写了也不会生效。
    ///
    /// 实现方必须自己保证单调性（剩余时间越短，返回值越大），算法不做校验。
    fn expiry_urgency(&self, _now_ms: i64) -> f64 {
        0.0
    }

    /// 成功率 EMA（α=0.1）。无记录返回 `0.0`。
    fn success_ema(&self) -> f64;

    /// 错误率 EMA（α=0.1）。无记录返回 `0.0`。
    fn error_ema(&self) -> f64;

    /// 最近被选中时刻（毫秒；`0` = 从未）。
    fn last_used_ms(&self) -> i64;

    /// 选中单调序号（LRU 权威依据）。
    fn used_seq(&self) -> u64;

    /// 当前在途请求数。无统计返回 `0`。
    fn in_flight(&self) -> i64;

    fn model_ema(&self, _model: &str) -> Option<(f64, f64)> {
        None
    }

    /// **自愈版**在途读数（默认 = [`Self::in_flight`]，即「不做租约自愈」）。
    ///
    /// 为什么给默认实现：Qoder / Trae 池不做并发租约（恒 0），不必为它们写空实现；
    /// WorkBuddy 池有真实租约，覆写成「到期即失效」。
    fn in_flight_now(&self, _now_ms: i64) -> i64 {
        self.in_flight()
    }

    /// 归属域标记；`None` 表示未知，不参与 realm 过滤。
    fn realm(&self) -> Option<RealmTag>;

    /// 是否已禁用（终态，需人工或刷新成功复活）。
    fn is_disabled(&self) -> bool;

    fn cool_expiry_ms(&self) -> i64;

    /// 是否正处于**硬冷却**中（余额不足 ⇒ 强试必然再失败且浪费一次上游调用）。
    ///
    /// 全冷却兜底会排除这类账号；软冷却不排除（值得再试一次）。
    fn is_hard_cooled(&self, now_ms: i64) -> bool;

    fn model_cool_expiry_ms(&self, _model: &str) -> i64 {
        0
    }

    fn healthy_for_request(&self, now_ms: i64, model: &str) -> bool;

    fn account_healthy(&self, now_ms: i64) -> bool {
        self.healthy_for_request(now_ms, "")
    }

    /// 惰性清理已过期的模型级冷却。无模型级冷却的实现可为空操作。
    fn prune_model_cooldowns(&mut self, now_ms: i64);

    fn cost_per_1k(&self, now_ms: i64, model: &str, ttl_ms: i64) -> f64;

    fn cost_tier(&self, now_ms: i64, model: &str, ttl_ms: i64) -> CostTier;

    /// 选号写回：记录「被正式选中」的时刻与序号。
    ///
    /// 同时推进 `used_seq`（LRU 权威依据）。
    fn mark_picked(&mut self, now_ms: i64, seq: u64);

    /// 兜底强试写回：只更新「最近使用时刻」，**不推进** `used_seq`。
    ///
    /// 用于全冷却兜底 —— 那只是「试一下」，不应影响 LRU 语义。
    fn mark_probed(&mut self, now_ms: i64);
}
