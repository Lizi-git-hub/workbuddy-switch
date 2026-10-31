
use buddy_switch_core::modules::catalog::{is_stale, CatalogSnapshot, CatalogStore};
use buddy_switch_core::modules::region::Region;

use crate::account_strategy::AccountSelector;
use crate::error::GatewayError;
use crate::state::GatewayState;
use crate::timeutil;

/// 探测某 region 的模型目录（**唯一的探测入口**）。
///
/// - 成功 ⇒ 写 live（并落盘 `gateway_models.<region>.json`）；
/// - 上游失败 ⇒ 由 [`CatalogStore::refresh`] 按 cached → builtin 降级，**原因写进 `note`**；
/// - 账号选择失败（池空 / 策略无命中 / 区域不符）⇒ 返回 [`GatewayError`]，
///   **不写脏数据**（调用方决定是静默忽略还是回传错误）。
///
/// ⚠️ 调用方负责 **fire-and-forget**（探测失败不得阻断接入）。
pub async fn probe_region(
    state: &GatewayState,
    region: Region,
) -> Result<CatalogSnapshot, GatewayError> {
    let strategy = state.strategy_for(region).await;
    // 安全边界 F：`AccountSelector::select` 已按 region 校验凭据（区域不符直接拒），
    // 因此本探测**不可能**用别的 region 的凭据去写本 region 的清单。
    let account = AccountSelector.select(region, &strategy).await?;
    Ok(state
        .catalogs
        .refresh(region, &state.upstream, &account)
        .await)
}

/// 需要「启动补识别」的 region（**纯函数**，只读 store，便于单测）。
///
/// 判据 = [`is_stale`]：内置（从未成功识别）或 `fetched_at` 超过 24h。
pub fn stale_regions(store: &CatalogStore, now_ms: i64) -> Vec<Region> {
    Region::all()
        .into_iter()
        .filter(|region| is_stale(&store.current(*region), now_ms))
        .collect()
}

/// [`stale_regions`] 的宿主入口：按当前时刻判定哪些 region 待确认。
pub fn regions_needing_probe(state: &GatewayState) -> Vec<Region> {
    stale_regions(&state.catalogs, timeutil::now_ms())
}

/// 网关启动补识别：对每个「待确认」region 探测一次，返回实际探测的 region 数。
///
/// 失败静默（fire-and-forget 语义）—— 探测只是「顺手把清单变新」，绝不该让启动失败。
pub async fn probe_stale_regions(state: &GatewayState) -> usize {
    let regions = regions_needing_probe(state);
    for region in &regions {
        let _ = probe_region(state, *region).await;
    }
    regions.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    use buddy_switch_core::modules::catalog::CatalogModel;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "buddy-switch-catalog-probe-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_model(id: &str) -> CatalogModel {
        CatalogModel {
            id: id.into(),
            name: id.into(),
            context_window: 1,
            context_window_default: None,
            max_tokens: 1,
            supports_images: false,
            credits: None,
            badges: Vec::new(),
            free: false,
            reasoning: None,
        }
    }

    #[test]
    fn stale_regions_probes_builtin_and_skips_fresh_live() {
        let dir = temp_dir();
        let store = CatalogStore::with_cache_dir(dir.clone());
        let now = timeutil::now_ms();

        // 全新 store：两 region 都是内置（从未成功识别）⇒ 都待确认。
        assert_eq!(
            stale_regions(&store, now),
            Region::all().to_vec(),
            "内置清单必须待确认（否则「接入即识别」的补识别永远不会触发）"
        );

        // 写入新鲜的 live 后，该 region 不再待确认。
        store.set_live(Region::Cn, vec![sample_model("live-model")]);
        assert_eq!(
            stale_regions(&store, now),
            vec![Region::Global],
            "新鲜的 live 不应被反复探测"
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 超过 24h 的 live 会重新进入「待确认」（`fetched_at` 判定，与来源无关）。
    #[test]
    fn stale_regions_probes_expired_live() {
        let dir = temp_dir();
        let store = CatalogStore::with_cache_dir(dir.clone());
        store.set_live(Region::Cn, vec![sample_model("live-model")]);

        let fetched_at = store.current(Region::Cn).fetched_at.unwrap();
        // 刚写入 ⇒ 不待确认；把「现在」推到 24h 之后 ⇒ 待确认。
        assert!(!stale_regions(&store, fetched_at).contains(&Region::Cn));
        assert!(stale_regions(&store, fetched_at + 24 * 60 * 60 * 1000).contains(&Region::Cn));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn both_hosts_wire_the_catalog_probe() {
        const TAURI_COMMANDS_RS: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../src-tauri/src/commands.rs"
        );
        const TAURI_LIB_RS: &str =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../src-tauri/src/lib.rs");
        const SERVER_API_RS: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../crates/buddy-switch-server/src/api.rs"
        );
        const SERVER_MAIN_RS: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../crates/buddy-switch-server/src/main.rs"
        );

        let read = |path: &str| {
            std::fs::read_to_string(path).unwrap_or_else(|error| panic!("读不到 {path}: {error}"))
        };

        // ① 接入即识别（✅ #6：触发点 = 创建 API Key）：两宿主的 create_api_key 都要触发探测。
        for (file, marker) in [
            (TAURI_COMMANDS_RS, "probe_catalog(region)"),
            (SERVER_API_RS, "catalog_probe::probe_region(&state, region)"),
        ] {
            assert!(
                read(file).contains(marker),
                "{file} 缺少「接入即识别」出口 `{marker}` —— 创建 API Key 后不会后台探测，\
                 用户必须手动点「重新识别」才看得到清单（P10 §1.6 / ✅ #6）"
            );
        }

        // ② 启动补识别：两宿主的 spawn 派发都要调 `probe_stale_regions`。
        for file in [TAURI_LIB_RS, SERVER_MAIN_RS] {
            assert!(
                read(file).contains("probe_stale_regions(&state)"),
                "{file} 缺少「启动补识别」出口 —— 「内置 / 陈旧」的清单不会在启动时被补成实时\
                 （P10 §1.6 / ✅ #7）"
            );
        }
    }
}
