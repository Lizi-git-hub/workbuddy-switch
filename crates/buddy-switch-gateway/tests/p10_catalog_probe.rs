// 测试串行锁（`guard()` / `ENV_LOCK`）会被**故意**持有到用例结束：它防的是多个用例
// 同时改同一个进程级状态（环境变量 / 全局配置）。`#[tokio::test]` 默认 current-thread，
// 不存在「持锁跨线程唤醒」的风险；clippy::await_holding_lock 在这里是误报。
#![allow(clippy::await_holding_lock)]

use std::sync::Mutex;

use buddy_switch_core::modules::catalog::CatalogSource;
use buddy_switch_core::modules::region::Region;
use buddy_switch_gateway::{catalog_probe, GatewayConfig, GatewayState};

/// 串行化所有触碰 `BUDDY_SWITCH_HOME` 的用例（env 是进程级全局状态）。
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// 把 `BUDDY_SWITCH_HOME` 指向一个已存在的临时目录，返回该目录。
fn isolated_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "wb-gw-p10-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("创建隔离目录");
    std::env::set_var("BUDDY_SWITCH_HOME", &dir);
    dir
}

#[tokio::test]
async fn probe_failure_does_not_block_key_creation() {
    let _guard = ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let home = isolated_home("probe-fail");

    let state = GatewayState::new(GatewayConfig::default());

    // ① 「接入」动作：创建 Key。`keys.create` 签名返回 `(record, plaintext)`（**非 Result**）
    //    ⇒ 本身不可失败；这里把它作为「接入成功」的事实来源。
    let (_record, plaintext) = state.keys.create("p10-verify".to_string(), Region::Cn);
    assert!(!plaintext.is_empty(), "创建 Key 应返回一次性明文");
    let created = state
        .keys
        .list()
        .into_iter()
        .any(|k| k.name == "p10-verify");
    assert!(created, "Key 必须已登记（接入成功的事实）");

    // ② 「探测」：隔离 home 下没有凭据 ⇒ `AccountSelector::select` 返回 Err
    //    ⇒ `probe_region` 必失败。先证明这条路径真的失败（否则本用例是空转）。
    let probe = catalog_probe::probe_region(&state, Region::Cn).await;
    assert!(
        probe.is_err(),
        "隔离 home（无凭据）下探测**必须失败**——若这里 Ok，说明断言空转（选号没走隔离 home）"
    );

    let still_there = state
        .keys
        .list()
        .into_iter()
        .any(|k| k.name == "p10-verify");
    assert!(
        still_there,
        "探测失败**不得**影响已创建的 Key —— 「接入即识别」是 fire-and-forget（§3.17.1 规则 3）"
    );

    // ④ 探测失败**不得写脏数据**：目录仍是「内置」（而非被伪造成「实时」），且带原因。
    let snapshot = state.catalogs.current(Region::Cn);
    assert_eq!(
        snapshot.source,
        CatalogSource::Builtin,
        "选号失败时不得把目录写成 live（否则用户看到「实时」却是内置兜底）"
    );
    assert!(
        snapshot
            .note
            .as_deref()
            .map(|n| !n.trim().is_empty())
            .unwrap_or(false),
        "内置快照必须带原因（非实时必有原因契约），实际 note={:?}",
        snapshot.note
    );

    let _ = std::fs::remove_dir_all(&home);
}
