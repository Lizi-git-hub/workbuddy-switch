
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use buddy_switch_core::modules::qoder::region::QoderRegion;

/// 记忆存活时间：到期后重新试一次结构化（上游可能已修）。
const TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// 键 = `区域|模型 key`（模型 key 是**判据本身**：同一区域里不同模型的上游通道不同）。
fn storage() -> &'static Mutex<HashMap<String, Instant>> {
    static STORAGE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    STORAGE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn entry_key(region: QoderRegion, model: &str) -> String {
    format!("{}|{}", region.as_str(), model.trim().to_ascii_lowercase())
}

/// 这条记忆是否仍然有效（纯函数，便于测 TTL 而不必真等 6 小时）。
fn is_fresh(at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(at) < TTL
}

/// 记下「该 (区域, 模型) 的结构化历史被上游拒了」。
pub fn note_rejected(region: QoderRegion, model: &str) {
    let key = entry_key(region, model);
    if key.ends_with('|') {
        // 模型 key 为空 ⇒ 不记（空 key 会命中一大片无关模型）。
        return;
    }
    storage()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, Instant::now());
}

/// 该 (区域, 模型) 是否在 TTL 内已知「结构化不被接受」。
pub fn is_unsupported(region: QoderRegion, model: &str) -> bool {
    let key = entry_key(region, model);
    let mut map = storage()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    match map.get(&key) {
        Some(at) if is_fresh(*at, now) => true,
        Some(_) => {
            // 过期即忘：下一次请求重新试结构化，失败再记。
            map.remove(&key);
            false
        }
        None => false,
    }
}

/// 当前记忆条数（管理面 / 诊断用；不触发任何上游往返）。
pub fn tracked_models() -> usize {
    storage()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .len()
}

/// 清空（测试用：进程内是全局状态，用例之间必须隔离）。
#[cfg(test)]
pub fn reset() {
    storage()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

/// 这次失败该不该降级重试（**纯函数**，网关热路径与测试共用同一个判据）。
///
/// 只认**参数类**拒绝：401/403 是凭据、429 是限流、5xx 是上游故障 —— 那些跟
/// 「请求体形状」无关，换文本模式重发只会白烧一次额度。
///
/// `attempt` 从 1 开始：只降级一次，绝不循环（否则上游持续 400 时会把一条请求
/// 放大成两条、三条）。
pub fn should_degrade(status: u16, structured_used: bool, attempt: u32) -> bool {
    structured_used && attempt == 1 && matches!(status, 400 | 422)
}

/// 降级重试时给用户看的说明（进 `failures`，出问题能查到「为什么多发了一次」）。
pub const DEGRADED_NOTE: &str = "结构化工具历史被拒，已用文本模式重试";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_models_are_remembered_per_region() {
        reset();
        assert!(!is_unsupported(QoderRegion::Cn, "dfmodel"));
        note_rejected(QoderRegion::Cn, "dfmodel");
        assert!(is_unsupported(QoderRegion::Cn, "dfmodel"));
        // 大小写 / 空白归一后再记、再查。
        assert!(is_unsupported(QoderRegion::Cn, "  DFModel "));
        // 区域隔离：同一个模型 key 在国际版仍是「未知」，不该被 CN 的结论连累。
        assert!(!is_unsupported(QoderRegion::Global, "dfmodel"));
        // 空模型 key 不记（否则会命中一大片无关模型）。
        note_rejected(QoderRegion::Cn, "   ");
        assert_eq!(tracked_models(), 1);
        reset();
    }

    /// TTL：到期即忘（用时间戳直测，不真等 6 小时）。
    #[test]
    fn memory_expires_after_ttl() {
        let now = Instant::now();
        assert!(is_fresh(now, now));
        let stale = now
            .checked_sub(TTL + Duration::from_secs(1))
            .expect("Instant 可回退");
        assert!(!is_fresh(stale, now));
    }

    #[test]
    fn degrade_only_on_parameter_rejections_and_only_once() {
        assert!(should_degrade(400, true, 1));
        assert!(should_degrade(422, true, 1));
        // 没用结构化 ⇒ 降级无意义（已经是文本模式了）。
        assert!(!should_degrade(400, false, 1));
        // 只重试一次。
        assert!(!should_degrade(400, true, 2));
        // 凭据 / 限流 / 上游故障与请求体形状无关。
        for status in [401, 403, 404, 429, 500, 502, 503] {
            assert!(!should_degrade(status, true, 1), "{status} 不该降级");
        }
    }
}
