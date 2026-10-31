//! **统一网关**：把两个产品线的模型合成一个入口（`wb-cn:` / `trae-global:` 这类命名空间前缀）。
//!
//! 设计依据：`docs/specs/UNIFIED-GATEWAY-ARCH.md`（架构与契约）+ `UNIFIED-GATEWAY-UI.md`（交互）。
//!
//! # 现状（**逐步落地中，别把「已建文件」当成「已完成」**）
//!
//! | 部分 | 状态 |
//! |:--|:--|
//! | 命名空间表（`core::modules::gateway_namespace`） | ✅ 已落地 |
//! | 运行配置（[`config`]） | ✅ 已落地 |
//! | 密钥与命名空间授权（[`apikey`]） | ✅ 已落地 |
//! | 运行状态（[`state`]） | ✅ 已落地 |
//! | `GatewayProduct` + 路由 + `/health`（兼容 `/healthz`）`/status` `/v1/models`（[`routes`]） | ✅ 已落地 |
//! | 业务端点 `/v1/chat/completions` `/v1/messages` `/v1/responses` `/biz/*path` | ⬜ 待 P3（抽 `pub(crate) relay_*`） |
//! | 两处宿主接线（server / src-tauri）+ 管理面四处同步 | ⬜ 待做 |
//! | 前端「统一入口」子导航页 | ⬜ 待做（原型已可点：`docs/prototype/buddy-switch-prototype.html`） |
//!
//! # 为什么是**第三个**产品线，而不是合并两个 router
//!
//! 两个网关的 `/v1/models`、`/v1/chat/completions` **逐字相同**，axum 对同路径 `merge`
//! 会**运行期 panic**（不是编译期）。本仓有一条护栏测试
//! （`lib.rs::two_products_own_overlapping_paths`）专门把这个重叠钉死，就是为了防止有人去 merge。
//!
//! ⇒ 统一网关**只挂一份路径**，在 handler 内按模型名前缀分派到两条既有产品线的既有中继实现。
//! **合并的是入口，不是 router。**
//!
//! # 独立 Key 库（不复用两个既有库）
//!
//! 见 [`apikey`] 的模块头：归属语义不同（命名空间集合 vs 单个域/程序位），
//! 且复用会让「改统一入口的 Key」与「改那个产品线自己的 Key」互相影响。

pub mod apikey;
pub mod config;
pub mod routes;
pub mod state;

use std::net::{IpAddr, SocketAddr};

use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub use apikey::{UnifiedApiKeyRecord, UnifiedApiKeyStore, UNIFIED_KEY_PREFIX};
pub use config::{
    known_ids, unified_config_file, unified_keys_file, UnifiedGatewayConfig, DEFAULT_MAX_BODY_MB,
    DEFAULT_STICKY_TTL_MS, DEFAULT_UNIFIED_PORT,
};
pub use state::UnifiedGatewayState;

use crate::{GatewayHandle, GatewayProduct};

/// 统一网关（第三个产品线）。
pub struct UnifiedGateway;

impl GatewayProduct for UnifiedGateway {
    type State = UnifiedGatewayState;

    const OWNED_PATHS: &'static [&'static str] = &[
        "/health",
        "/healthz",
        "/status",
        "/v1/models",
        "/v1/chat/completions",
        "/v1/messages",
        "/v1/responses",
        // ⚠️ 通配符必须是 axum 0.7 的 `*path`（**不是** 0.8 的 `{*path}`）——
        //   写错会在 **router 构建期 panic**，而 `cargo check` 全绿（本仓踩过这个坑）。
        "/biz/*path",
    ];

    fn shared_state() -> UnifiedGatewayState {
        state::shared_state().clone()
    }

    fn is_enabled(state: &UnifiedGatewayState) -> impl std::future::Future<Output = bool> + Send {
        let state = state.clone();
        async move { state.config_snapshot().await.enabled }
    }

    fn router(state: UnifiedGatewayState) -> axum::Router {
        router(state)
    }

    fn spawn_listener(
        state: UnifiedGatewayState,
    ) -> impl std::future::Future<Output = anyhow::Result<GatewayHandle>> + Send {
        spawn_listener_with_state(state)
    }
}

pub mod admin {
    use serde_json::{json, Value};

    use buddy_switch_core::modules::gateway_namespace::{self, NamespaceSpec, RelayTarget};
    use buddy_switch_core::modules::product::{
        scope_of_qoder_region, scope_of_trae_region, scope_of_wb_region,
    };
    use buddy_switch_core::modules::qoder::region::QoderRegion;
    use buddy_switch_core::modules::region::Region;
    use buddy_switch_core::modules::trae::variant::TraeVariant;

    use super::apikey::UnifiedApiKeyStore;
    use super::state::UnifiedGatewayState;
    use crate::pool::RealmTag;

    pub fn keys_list_payload(store: &UnifiedApiKeyStore) -> Value {
        let keys: Vec<Value> = store.list().iter().map(|record| record.masked()).collect();
        json!({ "keys": keys })
    }

    /// `GET /api/unified-gateway/config` 的响应体**中两处宿主共同的那部分**。
    ///
    /// ⚠️ **不含** `running` / `addr`：那两项来自各宿主自己的监听运行时
    /// （server 是 `unified_gateway_host::status()`，桌面端是 `UnifiedGatewayRuntime`）。
    /// 宿主在返回值上补这两个字段即可，**其余一律不得各自重写**。
    pub async fn config_payload(state: &UnifiedGatewayState) -> Value {
        let config = state.config_snapshot().await;
        let keys = state.keys.list();
        json!({
            "config": config,
            // 已启用项按**命名空间表顺序**（与配置文件里的书写顺序无关）
            "namespaces": config
                .enabled_namespaces()
                .iter()
                .map(|spec| spec.id)
                .collect::<Vec<_>>(),
            "allNamespaces": super::config::known_ids(),
            // 只给计数：明细走专门的 keys 命令（一个命令不承担两件事）
            "keys": {
                "total": keys.len(),
                "active": keys.iter().filter(|key| key.is_active()).count(),
            },
        })
    }

    // ─────────────────── 账号池总览（只读投影）───────────────────
    //
    // 统一网关**没有自己的池** —— 它按命名空间把请求分派到三条产品线各自的池
    // （`gateway_namespace::relay_target_of`）。管理面此前**完全没有池数据**
    // （只有 keys / config），前端「账号池」分区因此无从渲染。
    // 本组函数把三条产品线**已有的**池视图投影成一份跨平台汇总：
    // **纯投影，不新增任何选号 / 冷却判定**。

    /// 一组「已启用命名空间 → 同一个池」的归并结果。
    #[derive(Debug, Clone, PartialEq)]
    pub struct PoolGroup {
        /// 池标识 —— 作用域字面量（`wb-cn` / `trae-global` / `qoder-cn` …）。
        pub target: &'static str,
        /// 指向该池的**已启用**命名空间（命名空间表顺序；分组依据 = 去重后的 target）。
        pub namespaces: Vec<&'static str>,
        /// 该组**首个**命名空间的中继目标 —— 取池数据时的依据。
        pub relay: RelayTarget,
    }

    pub fn pool_target_of(relay: RelayTarget) -> &'static str {
        match relay {
            RelayTarget::Wb(region) => scope_of_wb_region(region).as_str(),
            RelayTarget::Trae(variant) => scope_of_trae_region(variant.region()).as_str(),
            RelayTarget::Qoder(region) => scope_of_qoder_region(region).as_str(),
        }
    }

    /// 已启用命名空间按池归并（**纯函数**；顺序 = 命名空间表顺序 = 首次出现顺序）。
    ///
    /// 归并依据一律来自 [`gateway_namespace::relay_target_of`]（+ [`pool_target_of`]），
    /// ⇒ 「哪条命名空间落在哪个池」与真实分派**同源**，不存在第二份映射。
    pub fn group_pools(specs: &[&'static NamespaceSpec]) -> Vec<PoolGroup> {
        let mut groups: Vec<PoolGroup> = Vec::new();
        for spec in specs {
            let relay = gateway_namespace::relay_target_of(spec);
            let target = pool_target_of(relay);
            match groups.iter_mut().find(|group| group.target == target) {
                Some(group) => group.namespaces.push(spec.id),
                None => groups.push(PoolGroup {
                    target,
                    namespaces: vec![spec.id],
                    relay,
                }),
            }
        }
        groups
    }

    /// 组装一个池对象 —— **唯一形状构造点**（两处宿主只调 [`pool_overview_payload`]，不各自拼装）。
    ///
    /// 计数从摘要对象**摊平**到顶层（`total` / `available` / `cooling` / `disabled` /
    /// `expired` / `zero_credits` / `total_credits`，Qoder 另有 `model_cooling`）；
    /// 账号行由三条产品线既有视图**原样透出**（同一张共用池卡的形状，见各自的
    /// `status_list` / `accounts_view`）—— `credits: null` 必须保持 `null`：
    /// 0 会被读成「这个账号没额度了」，而真相是「不可知」（前端渲染成「—」）。
    pub fn pool_object(
        target: &str,
        namespaces: &[&'static str],
        summary: Value,
        accounts: Vec<Value>,
    ) -> Value {
        let mut object = serde_json::Map::new();
        object.insert("target".to_string(), json!(target));
        object.insert("namespaces".to_string(), json!(namespaces));
        object.insert("accounts".to_string(), json!(accounts));
        if let Value::Object(counts) = summary {
            for (key, value) in counts {
                object.insert(key, value);
            }
        }
        Value::Object(object)
    }

    /// `GET /api/unified-gateway/pool-overview` 的响应体：`{ "pools": [ …按池分组… ] }`。
    ///
    /// ## 数据从哪来（**纯投影**）
    ///
    /// 池状态全部来自三条产品线**已有的**视图，本函数一行选号 / 冷却判定都不做：
    /// - WB → `Pool::summary` / `Pool::status_list`（与 `/status`、`gateway_status` 同一对函数）；
    /// - Trae → `TraePool::summary` / `TraePool::status_list`（与 `trae_gateway_status` 同一对）；
    /// - Qoder → `QoderPool::summary` / `QoderPool::accounts_view`（与 `qoder_gateway_status` 同一对）。
    ///
    /// 只列**已启用**命名空间指向的池（未启用段不出现）；多条命名空间共用一个池时
    /// 只出一条（见 [`group_pools`] 的 `namespaces`）。
    pub async fn pool_overview_payload() -> Value {
        let specs = super::state::shared_state()
            .config_snapshot()
            .await
            .enabled_namespaces();
        let mut pools: Vec<Value> = Vec::new();
        for group in group_pools(&specs) {
            pools.push(pool_of(&group).await);
        }
        json!({ "pools": pools })
    }

    /// 取一个池的状态并组装（分派依据 = 分组时记下的 `relay`）。
    async fn pool_of(group: &PoolGroup) -> Value {
        let (summary, accounts) = match group.relay {
            RelayTarget::Wb(region) => wb_pool(region).await,
            RelayTarget::Trae(variant) => trae_pool(variant).await,
            RelayTarget::Qoder(region) => qoder_pool(region).await,
        };
        pool_object(group.target, &group.namespaces, summary, accounts)
    }

    async fn wb_pool(region: Region) -> (Value, Vec<Value>) {
        let state = <crate::WbGateway as crate::GatewayProduct>::shared_state();
        let now = crate::timeutil::now_ms();
        let realm = match region {
            Region::Cn => RealmTag::Cn,
            Region::Global => RealmTag::Global,
        };
        let mut pool = state.pool.write().await;
        crate::state::sync_pool_with_accounts(&mut pool);
        let summary = serde_json::to_value(pool.summary(now, Some(realm))).unwrap_or(Value::Null);
        let realm_key = crate::pool::realm_key(Some(realm));
        let accounts = pool
            .status_list(now)
            .into_iter()
            .filter(|row| row["realm"].as_str() == Some(realm_key))
            .collect();
        (summary, accounts)
    }

    /// Trae：池按**变体**取（分组首个命名空间的变体）。同一区域的三条程序线读的是
    /// 同一本区域库 / 同一份冷却（见 [`pool_target_of`]）⇒ 取哪个变体都得到同一份数据。
    async fn trae_pool(variant: TraeVariant) -> (Value, Vec<Value>) {
        let state = <crate::trae::TraeGateway as crate::GatewayProduct>::shared_state();
        let now = crate::trae::now_secs();
        let (summary, accounts) = {
            let mut pools = state.pools.lock().await;
            let pool = pools
                .entry(variant)
                .or_insert_with(|| crate::trae::pool::TraePool::for_variant(variant));
            pool.sync_for(variant);
            (
                serde_json::to_value(pool.summary(now)).unwrap_or(Value::Null),
                pool.status_list(now),
            )
        };
        (summary, accounts)
    }

    /// Qoder：区域池的摘要（含 Qoder 独有的一格 `model_cooling` —— 上游 429 是**按模型**
    /// 报的，与账号级 `cooling` 正交，有现成字段故一并透出）。
    async fn qoder_pool(region: QoderRegion) -> (Value, Vec<Value>) {
        let state = <crate::qoder::QoderGateway as crate::GatewayProduct>::shared_state();
        let now = buddy_switch_core::modules::config::now_ms();
        let mut pools = state.pools.lock().await;
        let pool = pools.entry(region).or_default();
        pool.sync_for(region);
        (pool.summary(now), pool.accounts_view(now))
    }
}

/// 组装统一网关的路由（**只挂 [`UnifiedGateway::OWNED_PATHS`] 里声明过的路径**）。
pub fn router(state: UnifiedGatewayState) -> axum::Router {
    use axum::routing::{get, post};
    // 请求体上限在 **router 构建期**固化：改配置需重启（与两个既有网关同款语义）。
    let body_limit = state.body_limit_bytes;
    axum::Router::new()
        .merge(crate::health_routes(routes::health))
        .route("/status", get(routes::status))
        .route("/v1/models", get(routes::models))
        .route("/v1/chat/completions", post(routes::chat_completions))
        .route("/v1/messages", post(routes::messages))
        .route("/v1/responses", post(routes::responses))
        .route("/biz/*path", get(routes::biz).post(routes::biz))
        .layer(axum::extract::DefaultBodyLimit::max(body_limit))
        .with_state(state)
    // 不设 fallback：宿主可能把它 merge 进更大的 Router。
}

/// 用**调用方提供的**状态启动独立监听（与 [`crate::spawn_listener_with_state`] 同款语义）。
///
/// - 监听地址 / 端口 / 是否允许非回环均取自状态内的配置快照；
/// - 非回环地址需 `allow_non_loopback`（否则明确拒绝，并说明为什么）；
/// - 端口占用 / 地址非法时返回**可读错误**（不是 panic）。
pub async fn spawn_listener_with_state(
    state: UnifiedGatewayState,
) -> anyhow::Result<GatewayHandle> {
    let config = state.config_snapshot().await;
    let bind_addr = config.bind_addr.clone();
    let port = config.port;

    let ip: IpAddr = bind_addr.parse().map_err(|_| {
        anyhow::anyhow!("统一网关监听地址无效：{bind_addr}（应为 IPv4/IPv6 字面量）")
    })?;

    if !ip.is_loopback() && !config.allow_non_loopback {
        return Err(anyhow::anyhow!(
            "已拒绝监听非回环地址 {bind_addr}：局域网内任何设备都可消耗你的额度，\
             请确认可信网络后，在设置中显式开启『允许局域网访问』再重试"
        ));
    }

    let addr = SocketAddr::new(ip, port);
    let listener = TcpListener::bind(addr).await.map_err(|error| {
        anyhow::anyhow!(
            "无法监听 {addr}：端口可能被占用或不可用（{error}）。\
             注意 5789x 一段已排满：57890 界面 · 57891 WB 网关 · 57893 hook · 57894 Trae 网关 · 57895 Qoder 网关，另有 8899 Trae 登录代理。"
        )
    })?;
    let local = listener.local_addr().unwrap_or(addr);

    let app = router(state);

    let (tx, rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    Ok(GatewayHandle::new(local, tx, join))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GatewayProduct;

    fn temp_state(tag: &str) -> (UnifiedGatewayState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "buddy-switch-unified-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let state = UnifiedGatewayState::with_keys(
            UnifiedGatewayConfig::default(),
            UnifiedApiKeyStore::new(dir.join("keys.json")),
        );
        (state, dir)
    }

    #[tokio::test]
    async fn admin_payloads_pin_the_documented_shape() {
        let (state, dir) = temp_state("admin-shape");
        let keys = super::admin::keys_list_payload(&state.keys);
        assert!(
            keys.is_object(),
            "keys 载荷必须是**对象** `{{ keys: [...] }}`（裸数组曾让桌面端整页白屏）：{keys}"
        );
        assert!(
            keys["keys"].is_array(),
            "keys 载荷里必须有 `keys` **数组**：{keys}"
        );

        let config = super::admin::config_payload(&state).await;
        for field in ["config", "namespaces", "allNamespaces", "keys"] {
            assert!(
                config.get(field).is_some(),
                "config 载荷缺字段 `{field}`（两处宿主与前端都按它取值）：{config}"
            );
        }
        assert!(config["namespaces"].is_array());
        assert!(config["allNamespaces"].is_array());
        assert!(config["keys"]["total"].is_number());
        assert!(config["keys"]["active"].is_number());
        // ⚠️ 这两个字段**刻意不在共享载荷里**（各宿主自己补），
        //    这里断言它缺席 ⇒ 谁把它塞进共享层，本用例会提醒他核对两处宿主。
        assert!(
            config.get("running").is_none(),
            "running 应由各宿主补，不在共享载荷里"
        );
        assert!(
            config.get("addr").is_none(),
            "addr 应由各宿主补，不在共享载荷里"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pool_groups_merge_extension_namespaces_into_the_trae_region_pools() {
        use buddy_switch_core::modules::gateway_namespace;

        // 默认启用集 = 派生层 6 条 ⇒ 6 个池，每条命名空间一个。
        let defaults: Vec<&'static gateway_namespace::NamespaceSpec> =
            gateway_namespace::default_specs().collect();
        let groups = super::admin::group_pools(&defaults);
        assert_eq!(
            groups.iter().map(|group| group.target).collect::<Vec<_>>(),
            vec![
                "wb-cn",
                "wb-global",
                "trae-cn",
                "trae-global",
                "qoder-cn",
                "qoder-global"
            ],
            "池标识必须是作用域字面量（由 relay_target_of 折算，不另建映射表）"
        );
        assert!(
            groups.iter().all(|group| group.namespaces.len() == 1),
            "默认集里不该有两条命名空间共用一个池"
        );

        let all: Vec<&'static gateway_namespace::NamespaceSpec> =
            gateway_namespace::all_specs().iter().collect();
        assert_eq!(all.len(), 6, "全量命名空间应恰为 6 条派生层");
        assert!(
            all.iter().all(|spec| spec.default_on),
            "全量表此时应只有派生层（扩展层已清空）"
        );
        let groups = super::admin::group_pools(&all);
        assert_eq!(
            groups.len(),
            6,
            "收敛后每个作用域各成一个池：{:?}",
            groups.iter().map(|group| group.target).collect::<Vec<_>>()
        );
        let trae_cn = groups
            .iter()
            .find(|group| group.target == "trae-cn")
            .unwrap();
        assert_eq!(trae_cn.namespaces, vec!["trae-cn"]);
        let trae_global = groups
            .iter()
            .find(|group| group.target == "trae-global")
            .unwrap();
        assert_eq!(trae_global.namespaces, vec!["trae-global"]);
        // 退役的四条**不得**再出现（它们指向已卸载的客户端）。
        for retired in [
            "traework-cn",
            "traework-global",
            "traecode-cn",
            "traecode-global",
        ] {
            assert!(
                gateway_namespace::parse(retired).is_none(),
                "退役命名空间 {retired} 仍在册"
            );
        }
    }

    #[test]
    fn pool_object_flattens_summary_and_keeps_null_credits() {
        let object = super::admin::pool_object(
            "qoder-cn",
            &["qoder-cn"],
            serde_json::json!({
                "total": 2,
                "available": 1,
                "cooling": 0,
                "disabled": 1,
                "expired": 0,
                "zero_credits": 0,
                "total_credits": 0,
                "model_cooling": 1,
            }),
            vec![serde_json::json!({
                "uid": "u1",
                "name": "jackey",
                "status": "available",
                "credits": serde_json::Value::Null,
            })],
        );
        assert!(
            object.is_object(),
            "池对象必须是对象（裸数组曾让桌面端整页白屏）：{object}"
        );
        assert_eq!(object["target"], "qoder-cn");
        assert_eq!(object["namespaces"][0], "qoder-cn");
        assert_eq!(
            object["total"], 2,
            "计数必须摊平到池对象顶层（前端按 `pool.total` 取）"
        );
        assert_eq!(object["available"], 1);
        assert_eq!(object["disabled"], 1);
        assert_eq!(
            object["model_cooling"], 1,
            "Qoder 的按模型冷却计数应一并透出"
        );
        assert_eq!(object["accounts"][0]["uid"], "u1");
        assert_eq!(
            object["accounts"][0]["credits"],
            serde_json::Value::Null,
            "credits 不可知必须保持 null（0 会被读成「这个账号没额度了」）"
        );
    }

    #[tokio::test]
    async fn router_builds_and_answers_both_health_paths() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt; // oneshot

        let (state, dir) = temp_state("router");

        // ★ 两个路径都必须 200，且返回体逐字相同（同一个处理器）。
        let mut bodies = Vec::new();
        for path in crate::HEALTH_PATHS {
            let app = router(state.clone());
            let response = app
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .expect("router 必须能构建并响应（构建期 panic 会让网关完全起不来）");
            assert_eq!(
                response.status(),
                axum::http::StatusCode::OK,
                "{path} 必须 200"
            );

            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["service"], "unified-gateway");
            assert_eq!(body["running"], true);
            assert_eq!(
                body["namespaces"].as_array().unwrap().len(),
                6,
                "默认启用集应是派生层 6 条（3 平台 × 2 区域）"
            );
            bodies.push(bytes.to_vec());
        }
        assert_eq!(
            bodies[0], bodies[1],
            "`/health` 与 `/healthz` 必须由同一个处理器产出（返回体逐字相同）"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn business_endpoints_are_not_mounted_yet() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let (state, dir) = temp_state("404");
        let app = router(state);

        assert_eq!(
            UnifiedGateway::OWNED_PATHS,
            &[
                "/health",
                "/healthz",
                "/status",
                "/v1/models",
                "/v1/chat/completions",
                "/v1/messages",
                "/v1/responses",
                "/biz/*path",
            ],
            "路由表变更必须同步本断言与 OWNED_PATHS（两侧一起改）"
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/definitely-not-a-route")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::NOT_FOUND,
            "未知路径必须 404（说明没有 fallback 会吞掉宿主的其它路由）"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 声明过的路径都真的挂上了（防「声明与实现脱节」，同 `lib.rs` 的既有护栏口径）。
    #[tokio::test]
    async fn every_owned_path_is_actually_mounted() {
        use axum::body::Body;
        use axum::http::{Request, StatusCode};
        use tower::ServiceExt;

        let (state, dir) = temp_state("owned");
        let app = router(state);

        for path in UnifiedGateway::OWNED_PATHS {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(*path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_ne!(
                response.status(),
                StatusCode::NOT_FOUND,
                "{path} 声明了所有权却没挂上 —— handler 写了但没人调（本项目已出过三次同类事故）"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn listener_serves_http_on_a_real_socket() {
        let (mut state, dir) = temp_state("tcp");
        {
            let mut config = state.config_snapshot().await;
            config.port = 0; // 内核分配
            config.enabled = true;
            state.set_config(config).await;
        }
        state.body_limit_bytes = crate::state::body_limit_bytes(8);

        let handle = spawn_listener_with_state(state).await.expect("应能起监听");
        let addr = handle.addr();
        assert_ne!(addr.port(), 0, "端口 0 应由内核分配成真实端口");

        let response = reqwest::get(format!("http://{addr}/health"))
            .await
            .expect("真实 HTTP 请求应成功（起不来会在这里连不上）");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body: serde_json::Value = response.json().await.expect("响应应是 JSON");
        assert_eq!(body["service"], "unified-gateway");
        assert_eq!(body["enabled"], true);

        // 已挂的业务端点：真实端口上**存在**（无凭据 ⇒ 401，而不是 404）
        let unauthorized = reqwest::Client::new()
            .post(format!("http://{addr}/v1/chat/completions"))
            .body("{}")
            .send()
            .await
            .expect("请求应送达");
        assert_eq!(
            unauthorized.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "/v1/chat/completions 已挂上，缺凭据应是 401 而不是 404"
        );

        // `/v1/messages` 与 `/v1/responses` 也已挂上（无凭据 ⇒ 401）
        for path in ["/v1/messages", "/v1/responses"] {
            let response = reqwest::Client::new()
                .post(format!("http://{addr}{path}"))
                .body("{}")
                .send()
                .await
                .expect("请求应送达");
            assert_eq!(
                response.status(),
                reqwest::StatusCode::UNAUTHORIZED,
                "{path} 已挂上，缺凭据应是 401 而不是 404"
            );
        }

        // `/biz/*path` 也已挂上（无凭据 ⇒ 401）
        let biz = reqwest::Client::new()
            .post(format!("http://{addr}/biz/anything"))
            .body("{}")
            .send()
            .await
            .expect("请求应送达");
        assert_eq!(biz.status(), reqwest::StatusCode::UNAUTHORIZED);

        let not_found = reqwest::Client::new()
            .post(format!("http://{addr}/definitely-not-a-route"))
            .body("{}")
            .send()
            .await
            .expect("请求应送达");
        assert_eq!(not_found.status(), reqwest::StatusCode::NOT_FOUND);

        handle.shutdown().await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn non_loopback_bind_is_refused_without_the_flag() {
        let dir = std::env::temp_dir().join(format!(
            "buddy-switch-unified-bind-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // 用一个几乎不可能被占用的端口；拒绝发生在 bind **之前**，故不会真的占端口
        let config = UnifiedGatewayConfig {
            bind_addr: "0.0.0.0".to_string(),
            allow_non_loopback: false,
            port: 57997,
            ..Default::default()
        };
        let state =
            UnifiedGatewayState::with_keys(config, UnifiedApiKeyStore::new(dir.join("keys.json")));

        // 不用 `expect_err`：它要求 `Ok` 侧实现 `Debug`，而 `GatewayHandle` 刻意不实现
        // （持有 shutdown sender / join handle，没有可读的 Debug 形态）。
        let error = match spawn_listener_with_state(state).await {
            Ok(_handle) => panic!("未开启 allow_non_loopback 时必须拒绝"),
            Err(error) => error,
        };
        let message = error.to_string();
        assert!(
            message.contains("允许局域网访问"),
            "错误文案要给出出路：{message}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn invalid_bind_addr_yields_a_readable_error() {
        let dir = std::env::temp_dir().join(format!(
            "buddy-switch-unified-badaddr-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let config = UnifiedGatewayConfig {
            bind_addr: "not-an-ip".to_string(),
            ..Default::default()
        };
        let state =
            UnifiedGatewayState::with_keys(config, UnifiedApiKeyStore::new(dir.join("keys.json")));

        let error = match spawn_listener_with_state(state).await {
            Ok(_handle) => panic!("非法地址必须报可读错误"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("监听地址无效"), "{error}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
