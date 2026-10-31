
use std::collections::BTreeSet;

use axum::http::StatusCode;
use buddy_switch_gateway::unified::{
    router, spawn_listener_with_state, UnifiedApiKeyStore, UnifiedGatewayConfig,
    UnifiedGatewayState,
};
use serde_json::Value;

fn isolate_home() {
    static HOME: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    HOME.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!(
            "buddy-switch-unified-e2e-home-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("隔离 home 应可创建");
        std::env::set_var("BUDDY_SWITCH_HOME", &dir);
        dir
    });
}

/// 起一个隔离的统一网关（端口 0 = 内核分配），返回 (基址, 明文Key, 临时目录)。
///
/// 密钥库放临时目录；命名空间取默认集（派生层 4 条）。
async fn start_gateway(
    key_namespaces: &[&str],
    biz_namespace: Option<&str>,
    tune: impl FnOnce(&mut UnifiedGatewayConfig),
) -> (
    String,
    String,
    std::path::PathBuf,
    buddy_switch_gateway::GatewayHandle,
) {
    let (base, key, dir, handle, _state) =
        start_gateway_with_state(key_namespaces, biz_namespace, tune).await;
    (base, key, dir, handle)
}

async fn start_gateway_with_state(
    key_namespaces: &[&str],
    biz_namespace: Option<&str>,
    tune: impl FnOnce(&mut UnifiedGatewayConfig),
) -> (
    String,
    String,
    std::path::PathBuf,
    buddy_switch_gateway::GatewayHandle,
    UnifiedGatewayState,
) {
    isolate_home();

    let dir = std::env::temp_dir().join(format!(
        "buddy-switch-unified-e2e-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();

    // 端口 0 = 内核分配，避免与并发测试抢端口
    let mut config = UnifiedGatewayConfig {
        port: 0,
        enabled: true,
        ..Default::default()
    };
    tune(&mut config);

    let state =
        UnifiedGatewayState::with_keys(config, UnifiedApiKeyStore::new(dir.join("keys.json")));
    let (record, plaintext) = state
        .keys
        .create(
            "e2e".to_string(),
            key_namespaces.iter().map(|id| id.to_string()).collect(),
            biz_namespace.map(str::to_string),
        )
        .expect("授权集应合法");
    assert!(record.is_active());

    let handle = spawn_listener_with_state(state.clone())
        .await
        .expect("统一网关应能起监听");
    (
        format!("http://{}", handle.addr()),
        plaintext,
        dir,
        handle,
        state,
    )
}

/// 发一条请求并取 (状态码, JSON 体)。
async fn send(
    method: reqwest::Method,
    url: String,
    key: Option<&str>,
    body: Option<&str>,
) -> (StatusCode, Value) {
    let mut last_error = None;
    let mut response = None;
    for attempt in 1..=5u32 {
        let client = reqwest::Client::new();
        let mut retry = client.request(method.clone(), url.clone());
        if let Some(key) = key {
            retry = retry.header("authorization", format!("Bearer {key}"));
        }
        if let Some(body) = body {
            retry = retry
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        match retry.send().await {
            Ok(ok) => {
                response = Some(ok);
                break;
            }
            Err(error) => {
                last_error = Some(error);
                tokio::time::sleep(std::time::Duration::from_millis(50 * u64::from(attempt))).await;
            }
        }
    }
    let response = response.unwrap_or_else(|| {
        panic!(
            "请求应送达（连不上说明监听没起来）：{:?}",
            last_error.expect("必然有错误")
        )
    });
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap();
    let json: Value = response.json().await.unwrap_or(Value::Null);
    (status, json)
}

async fn get(base: &str, path: &str, key: Option<&str>) -> (StatusCode, Value) {
    send(reqwest::Method::GET, format!("{base}{path}"), key, None).await
}

async fn post(base: &str, path: &str, key: Option<&str>, body: &str) -> (StatusCode, Value) {
    send(
        reqwest::Method::POST,
        format!("{base}{path}"),
        key,
        Some(body),
    )
    .await
}

/// 所有对外路径在**无凭据**下都必须是 401（不是 404、更不是 200）。
///
/// 这是「路径真的挂上了」的**最强判据**：404 说明没挂、200 说明鉴权漏了。
#[tokio::test]
async fn every_path_is_mounted_and_requires_credentials() {
    let (base, _key, dir, handle) = start_gateway(&["wb-cn"], None, |_| {}).await;

    for path in [
        "/status",
        "/v1/models",
        "/v1/chat/completions",
        "/v1/messages",
        "/v1/responses",
        "/biz/anything",
    ] {
        let (status, body) = if path == "/status" || path == "/v1/models" {
            get(&base, path, None).await
        } else {
            post(&base, path, None, "{}").await
        };
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{path} 无凭据应为 401（404 = 没挂上；200 = 鉴权漏了）"
        );
        assert!(
            body["error"]["code"].is_string(),
            "{path} 的错误体应带可诊断的 code：{body}"
        );
    }

    // 未知路径必须 404 —— 证明**没有 fallback**（fallback 会静默吞掉宿主的其它路由）
    let (status, _) = get(&base, "/definitely-not-a-route", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

/// 两个健康检查路径都免鉴权，且内容能反映配置。
#[tokio::test]
async fn health_paths_are_public_and_reflect_the_config() {
    let (base, _key, dir, handle) = start_gateway(&["wb-cn"], None, |_| {}).await;
    let mut bodies = Vec::new();
    for path in buddy_switch_gateway::HEALTH_PATHS {
        let (status, body) = get(&base, path, None).await;
        assert_eq!(status, StatusCode::OK, "{path} 必须免鉴权且 200");
        assert_eq!(body["service"], "unified-gateway");
        assert_eq!(body["running"], true);
        assert_eq!(body["enabled"], true);
        assert_eq!(
            body["namespaces"].as_array().unwrap().len(),
            6,
            "默认启用集应是派生层 6 条（3 平台 × 2 区域；Qoder 于 2026-10-15 加入）"
        );
        bodies.push(body);
    }
    assert_eq!(
        bodies[0], bodies[1],
        "`/health` 与 `/healthz` 必须同源（返回体逐字相同）"
    );
    assert_eq!(bodies[0]["keys"]["total"], 1);

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

/// `/status` 只列**该 Key 已授权**的命名空间（未授权对它等于不存在）。
#[tokio::test]
async fn status_lists_only_the_authorized_namespaces() {
    let (base, key, dir, handle) = start_gateway(&["wb-cn", "trae-global"], None, |_| {}).await;
    let (status, body) = get(&base, "/status", Some(&key)).await;
    assert_eq!(status, StatusCode::OK);
    let namespaces: Vec<&str> = body["namespaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(
        namespaces,
        vec!["wb-cn", "trae-global"],
        "应只有被授权的两条，且按命名空间表顺序"
    );
    assert_eq!(body["key"]["name"], "e2e");

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn models_aggregates_every_enabled_namespace_with_a_reason_per_segment() {
    let (base, key, dir, handle) = start_gateway(&["wb-cn", "trae-cn"], None, |_| {}).await;
    let (status, body) = get(&base, "/v1/models", Some(&key)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["object"], "list");

    // 只列已授权 ∩ 已启用 ⇒ 恰好这两段（顺序取命名空间表）
    let namespaces = body["namespaces"].as_object().expect("应有逐段来源表");
    // ⚠️ **不断言键序**：JSON 对象的成员顺序在语义上不保证（`serde_json` 默认按字典序存），
    //    断言它等于「表顺序」是在测实现细节。有意义的是**集合相等** + 下面 `data` 的顺序。
    let keys: BTreeSet<&str> = namespaces.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        BTreeSet::from(["wb-cn", "trae-cn"]),
        "应只列已授权 ∩ 已启用的两段"
    );

    for (namespace, meta) in namespaces {
        let source = meta["source"].as_str().unwrap_or_default();
        assert!(
            matches!(source, "live" | "cached" | "builtin"),
            "{namespace} 的来源应是既有词汇表里的值，实际 {source}"
        );
        if source != "live" {
            assert!(
                meta["note"]
                    .as_str()
                    .map(|note| !note.trim().is_empty())
                    .unwrap_or(false),
                "{namespace} 来源为 {source} 却没有原因（非实时必有原因）"
            );
        }
    }

    // data 里的每条 id 都必须带前缀，且 namespace 字段与 id 前缀一致
    if let Some(data) = body["data"].as_array() {
        for model in data {
            let id = model["id"].as_str().expect("模型应有 id");
            let namespace = model["namespace"].as_str().expect("模型应有 namespace");
            assert!(
                id.starts_with(&format!("{namespace}:")),
                "id `{id}` 的前缀应与 namespace `{namespace}` 一致"
            );
        }
    }

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn namespace_guards_reject_in_the_documented_order() {
    // 只授权 `wb-cn` ⇒ 请求 `trae-cn:*` 应 403（而不是 400）
    let (base, key, dir, handle) = start_gateway(&["wb-cn"], None, |_| {}).await;

    // 1) 不在册（且不带前缀）⇒ 400 + 列出可用前缀
    let (status, body) = post(
        &base,
        "/v1/chat/completions",
        Some(&key),
        r#"{"model":"deepseek-v4.1-flash"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "namespace_prefix_required");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("wb-cn:"),
        "应列出可用前缀：{}",
        body["error"]["message"]
    );

    // 2) 前缀后为空 ⇒ 400
    let (status, body) = post(
        &base,
        "/v1/chat/completions",
        Some(&key),
        r#"{"model":"wb-cn:"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "empty_model_name");

    let (status, retired_body) = post(
        &base,
        "/v1/chat/completions",
        Some(&key),
        r#"{"model":"traework-cn:glm-5.3"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "退役命名空间必须 400");
    assert_ne!(
        retired_body["error"]["code"], "namespace_not_enabled",
        "退役 id 已不在册，不该报「未启用」"
    );
    assert_ne!(
        retired_body["error"]["code"], "namespace_forbidden",
        "退役 id 已不在册，不该走到授权判定（那说明它在册）"
    );

    // 4) 已启用但未授权 ⇒ 403
    let (status, body) = post(
        &base,
        "/v1/chat/completions",
        Some(&key),
        r#"{"model":"trae-cn:deepseek-v4.1-flash"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "namespace_forbidden");

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn all_three_llm_endpoints_share_one_guard() {
    let (base, key, dir, handle) = start_gateway(&["wb-cn"], None, |_| {}).await;
    for path in ["/v1/chat/completions", "/v1/messages", "/v1/responses"] {
        let (status, body) = post(&base, path, Some(&key), r#"{"model":"glm-5.3"}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path} 应拒绝裸模型名");
        assert_eq!(body["error"]["code"], "namespace_prefix_required", "{path}");
    }
    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn messages_uses_the_anthropic_error_shape() {
    let (base, key, dir, handle) = start_gateway(&["wb-cn"], None, |_| {}).await;
    let (status, body) = post(
        &base,
        "/v1/messages",
        Some(&key),
        r#"{"model":"glm-5.3","max_tokens":16}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["type"], "error", "Anthropic 形状的顶层判别字段");
    assert_eq!(body["error"]["type"], "invalid_request_error");
    assert_eq!(body["error"]["code"], "namespace_prefix_required");
    assert!(body.get("error").and_then(|e| e.get("message")).is_some());

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn responses_is_served_for_trae_namespaces() {
    let (base, key, dir, handle) = start_gateway(&["trae-cn"], None, |_| {}).await;
    let (status, body) = post(
        &base,
        "/v1/responses",
        Some(&key),
        r#"{"model":"trae-cn:deepseek-v4.1-flash"}"#,
    )
    .await;
    assert_ne!(
        status,
        StatusCode::NOT_IMPLEMENTED,
        "Trae 已支持 /v1/responses：{body}"
    );
    let code = body["error"]["code"].as_str().unwrap_or_default();
    assert_ne!(
        code, "endpoint_not_supported_for_namespace",
        "该错误码已随端点补齐删除：{body}"
    );

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn biz_requires_the_key_to_declare_a_namespace() {
    // 未指定 biz_namespace ⇒ 400（不猜、也不隐式取第一个 wb-*）
    let (base, key, dir, handle) = start_gateway(&["wb-cn"], None, |_| {}).await;
    let (status, body) = post(&base, "/biz/any/path", Some(&key), "{}").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "biz_namespace_missing");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("WorkBuddy"),
        "应说明只有 WB 合法：{}",
        body["error"]["message"]
    );
    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();

    // 指定了 biz_namespace 且是 WB ⇒ 过掉命名空间三道把关，进入白名单校验
    // （白名单外一律 404 —— 那也是「真的走到了 `biz_for_region`」的证据）
    let (base, key, dir, handle) = start_gateway(&["wb-cn"], Some("wb-cn"), |_| {}).await;
    let (status, _body) = post(&base, "/biz/definitely-not-whitelisted", Some(&key), "{}").await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "应已进入既有 `biz_for_region` 的白名单校验（fail-closed 404），而不是卡在命名空间把关"
    );
    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn biz_accepts_get_for_read_only_whitelisted_paths() {
    let (base, key, dir, handle) = start_gateway(&["wb-cn"], Some("wb-cn"), |_| {}).await;

    // ① 白名单外：GET 也必须**到达处理器**（旧实现会在路由层就 405，压根进不到白名单校验）
    let (status, body) = send(
        reqwest::Method::GET,
        format!("{base}/biz/definitely-not-whitelisted"),
        Some(&key),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "GET 也必须进到白名单校验（405 = 路由没接 GET）：{body}"
    );

    // ② 白名单内：GET 必须**过掉白名单**。隔离 store 里没有账号 ⇒ 到不了上游，
    //    但**不该**是 404（白名单拒了）或 405（路由没接 GET）。
    let (status, _body) = send(
        reqwest::Method::GET,
        format!("{base}/biz/activity/growth/streak"),
        Some(&key),
        None,
    )
    .await;
    assert_ne!(status, StatusCode::METHOD_NOT_ALLOWED, "GET 路由没接上");
    assert_ne!(
        status,
        StatusCode::NOT_FOUND,
        "白名单内的 GET 路径应被放行到中继（GET-only 的 streak 正是这条用例要保的）"
    );

    // ③ 同样要保住 POST 那一半（写操作不能被这次改动弄丢）
    let (status, _body) = send(
        reqwest::Method::POST,
        format!("{base}/biz/v2/billing/meter/daily-checkin"),
        Some(&key),
        Some("{}"),
    )
    .await;
    assert_ne!(status, StatusCode::METHOD_NOT_ALLOWED, "POST 路由没接上");
    assert_ne!(
        status,
        StatusCode::NOT_FOUND,
        "白名单内的 POST 路径应被放行到中继"
    );

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn config_changes_apply_to_the_running_listener() {
    let (base, key, dir, handle, state) = start_gateway_with_state(&["wb-cn"], None, |_| {}).await;

    let (_, body) = post(
        &base,
        "/v1/chat/completions",
        Some(&key),
        r#"{"model":"wb-cn:x"}"#,
    )
    .await;
    assert_eq!(
        body["error"]["code"], "no_credential",
        "应停在本地「无可用账号」，说明隔离生效、没打到真实上游：{body}"
    );

    // ② 热改：只留 trae-cn 启用 ⇒ 同一把 Key 打 wb-cn 应**立刻**变成「未启用」
    let mut config = state.config_snapshot().await;
    config.namespaces = vec!["trae-cn".to_string()];
    state.set_config(config).await;

    let (status, body) = post(
        &base,
        "/v1/chat/completions",
        Some(&key),
        r#"{"model":"wb-cn:x"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "未启用必须 400：{body}");
    assert_eq!(
        body["error"]["code"], "namespace_not_enabled",
        "应明确报「未启用」，而不是别的 400：{body}"
    );

    // ③ 再改回来 ⇒ 又放行（证明读的是配置，不是启动期快照）
    let mut config = state.config_snapshot().await;
    config.namespaces = vec!["wb-cn".to_string()];
    state.set_config(config).await;

    let (_, body) = post(
        &base,
        "/v1/chat/completions",
        Some(&key),
        r#"{"model":"wb-cn:x"}"#,
    )
    .await;
    assert_eq!(
        body["error"]["code"], "no_credential",
        "改回来应立刻放行（同样停在本地，不再是被命名空间把关拒绝）：{body}"
    );

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

/// 端口被占用时**返回可读错误**（而不是 panic）—— 文案要点出「谁占了」。
#[tokio::test]
async fn occupied_port_yields_a_readable_error() {
    let (base, _key, dir, handle) = start_gateway(&["wb-cn"], None, |_| {}).await;
    let occupied: u16 = base.rsplit(':').next().unwrap().parse().unwrap();

    let dir2 = std::env::temp_dir().join(format!(
        "buddy-switch-unified-e2e2-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir2).unwrap();
    let config = UnifiedGatewayConfig {
        enabled: true,
        port: occupied, // 故意撞端口
        ..Default::default()
    };
    let state =
        UnifiedGatewayState::with_keys(config, UnifiedApiKeyStore::new(dir2.join("keys.json")));
    let error = match spawn_listener_with_state(state).await {
        Ok(_handle) => panic!("端口已占用时应报错"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("端口"), "错误文案要点出端口问题：{error}");
    assert!(
        error.contains("57891") || error.contains("占用"),
        "文案要给出「谁占了」或候选端口：{error}"
    );

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
    std::fs::remove_dir_all(dir2).unwrap();
}

/// 声明的路径集合必须与 `router()` 实际挂载一致（防「声明与实现脱节」）。
///
/// 用**真实请求**逐条探：声明过的路径不得是 404。
#[tokio::test]
async fn every_owned_path_is_really_mounted() {
    use buddy_switch_gateway::unified::UnifiedGateway;
    use buddy_switch_gateway::GatewayProduct;

    let (base, _key, dir, handle) = start_gateway(&["wb-cn"], None, |_| {}).await;
    // 每个声明的路径都必须有人接（404 即「声明了却没挂」）
    let mut probed: BTreeSet<&str> = BTreeSet::new();
    for path in UnifiedGateway::OWNED_PATHS {
        let target = path.replace("/*path", "/probe");
        let (status, _) = if buddy_switch_gateway::HEALTH_PATHS.contains(path) {
            get(&base, &target, None).await
        } else {
            post(&base, &target, None, "{}").await
        };
        assert_ne!(
            status,
            StatusCode::NOT_FOUND,
            "{path} 声明了所有权却拿不到（404）—— handler 写了但没人调"
        );
        probed.insert(path);
    }
    assert_eq!(probed.len(), UnifiedGateway::OWNED_PATHS.len());
    // 8 条 = 健康检查 2 条（canonical + 兼容别名）+ status / models / chat / messages / responses / biz
    assert_eq!(probed.len(), 8, "统一网关应声明 8 条路径");

    handle.shutdown().await;
    std::fs::remove_dir_all(dir).unwrap();
}

/// 用 `router()` 直接构造（不起监听）也能应答 —— 保证宿主的 merge 路径同样可用。
#[tokio::test]
async fn router_can_be_used_without_a_listener() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let dir = std::env::temp_dir().join(format!(
        "buddy-switch-unified-e2e3-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let state = UnifiedGatewayState::with_keys(
        UnifiedGatewayConfig::default(),
        UnifiedApiKeyStore::new(dir.join("keys.json")),
    );
    let response = router(state)
        .oneshot(
            Request::builder()
                .uri(buddy_switch_gateway::HEALTH_CANONICAL_PATH)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::OK,
        "router 必须能独立构造并应答（构建期 panic 会让网关完全起不来）"
    );
    std::fs::remove_dir_all(dir).unwrap();
}
