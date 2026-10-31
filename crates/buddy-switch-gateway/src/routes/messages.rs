//! `POST /v1/messages`：Anthropic 协议 + tool use 双向转换。
//!
//! 与 `/v1/chat/completions` 共用同一套中继（选号 / 轮换 / 冷却），差别只在协议层：
//! 入站 Anthropic → 上游 OpenAI 形态，出站上游 SSE → Anthropic 事件流。

use std::time::Instant;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;

use buddy_switch_core::modules::product::scope_of_wb_region;
use buddy_switch_core::modules::region::Region;

use crate::logging::RequestMeta;
use crate::outbound::PromptMode;
use crate::protocol::anthropic::{
    aggregate_message, to_upstream_request_adaptive, AnthropicSseStream,
};
use crate::routes::relay::{self, RelayKind, RelayOutcome, RelayRequest};
use crate::routes::{
    anthropic_error, anthropic_error_with_fallback, authenticate, json_response, parse_body,
    sse_response,
};
use crate::session_headers;
use crate::state::GatewayState;
use crate::timeutil;

/// Anthropic messages 处理器。
pub async fn handler(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let record = match authenticate(&state, &headers) {
        Ok(record) => record,
        Err(error) => return anthropic_error(error),
    };
    let actor = std::sync::Arc::new(crate::apikey::KeyActor::new(
        record.id.clone(),
        record.policy(),
        state.key_usage.clone(),
        "wb",
    ));
    let allow_reroute = state.config_snapshot().await.allow_model_region_prefix;
    messages_for_region(
        state,
        record.region,
        headers,
        body,
        crate::routes::chat::PrefixPolicy::RegionPrefix { allow_reroute },
        Some(actor),
    )
    .await
}

/// 一趟 Anthropic 中继（**认证之后的全部逻辑**）—— 产品线入口与统一网关**共用**这一份实现。
///
/// `state` **按值**传入（`Arc` 句柄，克隆极廉价）⇒ 函数体内既有的 `&state` 写法一行都不用改。
pub async fn messages_for_region(
    state: GatewayState,
    region: Region,
    headers: HeaderMap,
    body: Bytes,
    policy: crate::routes::chat::PrefixPolicy,
    key: Option<std::sync::Arc<crate::apikey::KeyActor>>,
) -> Response {
    let started = Instant::now();
    let mut region = region;

    let parsed = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return anthropic_error(error),
    };
    let requested_model = parsed
        .get("model")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let wants_stream = parsed
        .get("stream")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    // 模型名前缀路由：与 `/v1/chat/completions` **同一策略对象**（见 `PrefixPolicy`）——
    // 统一入口传 `AlreadyResolved`，此处**不再**解析 `cn:` / `global:`。
    let model = match policy {
        crate::routes::chat::PrefixPolicy::AlreadyResolved => requested_model.clone(),
        crate::routes::chat::PrefixPolicy::RegionPrefix { allow_reroute } => {
            let route = crate::model_route::split_model_prefix(&requested_model);
            match crate::model_route::decide(region, allow_reroute, &route) {
                crate::model_route::PrefixDecision::NoPrefix => requested_model.clone(),
                crate::model_route::PrefixDecision::StripOnly => route.bare_model.clone(),
                crate::model_route::PrefixDecision::Reroute(target) => {
                    region = target;
                    route.bare_model.clone()
                }
                crate::model_route::PrefixDecision::Rejected {
                    requested,
                    key_region,
                } => {
                    return anthropic_error(crate::error::GatewayError::BadRequest(
                        crate::model_route::rejection_message(requested, key_region),
                    ))
                }
            }
        }
    };

    {
        let scope = scope_of_wb_region(region);
        let disabled = state.disabled.read().await;
        if crate::disabled_models::is_disabled(&disabled, scope, &model) {
            return anthropic_error(crate::error::GatewayError::ModelDisabled { scope, model });
        }
    }

    let upstream_body = to_upstream_request_adaptive(&parsed);
    let upstream_raw = serde_json::to_string(&upstream_body).unwrap_or_else(|_| "{}".to_string());
    let raw = if model == requested_model {
        upstream_raw
    } else {
        crate::model_route::rewrite_body_model(&upstream_raw, &model)
    };

    let conversation_id = relay::conversation_id_of(&parsed);
    let turn_key = session_headers::turn_key(&parsed);
    let inbound_request_id = header_of(&headers, "x-conversation-request-id");
    let trace_id = header_of(&headers, "x-trace-id");

    let key_ref = key.as_deref();
    let mut attempt = run(
        &state,
        region,
        &raw,
        &model,
        conversation_id.clone(),
        turn_key.as_deref(),
        inbound_request_id.as_deref(),
        trace_id.clone(),
        key_ref,
    )
    .await;

    // 与 chat 端点同一套降级策略。
    if let Err(failure) = &attempt {
        let status = failure.error.status();
        let mode = state.outbound_options().await.prompt.mode;
        let already_degraded = state.degrade_active(timeutil::now_ms()).await;
        if !already_degraded
            && mode == PromptMode::Passthrough
            && relay::should_degrade_retry(status, &failure.upstream_message, failure.sanitized)
            && relay::trip_degrade(&state).await
        {
            attempt = run(
                &state,
                region,
                &raw,
                &model,
                conversation_id,
                turn_key.as_deref(),
                inbound_request_id.as_deref(),
                trace_id,
                key_ref,
            )
            .await;
        }
    }

    match attempt {
        Ok(RelayOutcome::Ready { response, model }) => {
            let elapsed = started.elapsed().as_millis() as i64;
            state.log.record(
                RequestMeta {
                    endpoint: "/v1/messages",
                    key_id: key.as_deref().map(|actor| actor.key_id.clone()),
                    key_scope: key.as_deref().map(|actor| actor.scope),
                    method: "POST",
                    region,
                    account: String::new(),
                    account_uid: String::new(),
                    model,
                    status: response.status().as_u16(),
                    latency_ms: elapsed,
                    total_ms: elapsed,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    credit: 0.0,
                    stream: true,
                    error: None,
                }
                .to_value(),
            );
            return response;
        }
        Err(failure) => {
            // 先取轨迹：下面的日志会把 `failure.uid` move 走，之后再借整条 `failure` 就晚了。
            let note = relay::fallback_summary_json(&failure);
            let http_status = failure.error.status();
            let elapsed_ms = started.elapsed().as_millis() as i64;
            state.log.record(
                RequestMeta {
                    endpoint: "/v1/messages",
                    key_id: key.as_deref().map(|actor| actor.key_id.clone()),
                    key_scope: key.as_deref().map(|actor| actor.scope),
                    method: "POST",
                    region,
                    account: failure.account,
                    account_uid: failure.uid,
                    model,
                    status: http_status,
                    // 失败时没有「首字节」，两字段同值（诚实：不编 TTFB）。
                    latency_ms: elapsed_ms,
                    total_ms: elapsed_ms,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    credit: 0.0,
                    stream: wants_stream,
                    error: None,
                }
                .to_value(),
            );
            anthropic_error_with_fallback(failure.error, note)
        }
        Ok(RelayOutcome::Ok {
            response,
            prefix,
            account,
            uid,
            fallback,
        }) => {
            let model = fallback
                .as_ref()
                .map(|info| info.to.clone())
                .unwrap_or_else(|| model.clone());
            let header_at_ms = started.elapsed().as_millis() as i64;
            let auto_failover = state.config_snapshot().await.auto_failover;
            let failure = crate::failover::StreamFailure::new(auto_failover);
            // 粘性键用**客户端请求的模型**（与 `relay` 内部推导同一口径）。
            let sticky_key = relay::sticky_key_for(
                region,
                &model,
                relay::conversation_id_of(&parsed).as_deref(),
            );
            let mut resp = if wants_stream {
                let sinks = relay::stream_sinks(
                    &state,
                    RequestMeta {
                        endpoint: "/v1/messages",
                        key_id: key.as_deref().map(|actor| actor.key_id.clone()),
                        key_scope: key.as_deref().map(|actor| actor.scope),
                        method: "POST",
                        region,
                        // 留给 `with_failover` 的对外文案（下面还要读一次）。
                        account: account.clone(),
                        account_uid: uid.clone(),
                        model: model.clone(),
                        status: 200,
                        // TTFB：现在就填实（sink **不会**覆盖它）。
                        latency_ms: header_at_ms,
                        // 占位：由 sink 在流结束时补齐。
                        total_ms: 0,
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        credit: 0.0,
                        stream: true,
                        error: None,
                    },
                    started,
                    &uid,
                    &model,
                    key.as_deref(),
                    Some(failure.clone()),
                );
                sse_response(
                    AnthropicSseStream::new(
                        crate::protocol::usage_tap::UsageTap::new(
                            relay::prefix_stream(prefix, response),
                            sinks,
                        )
                        .with_error_sink(relay::envelope_error_sink(
                            &state,
                            &uid,
                            &model,
                            sticky_key.as_deref(),
                        ))
                        .with_failure(Some(failure.clone())),
                        model.clone(),
                    )
                    .with_estimated_input(crate::protocol::anthropic::estimate_input_tokens(
                        &parsed,
                    ))
                    .with_failover(Some(failure), &account),
                )
            } else {
                let text = relay::body_text_with_prefix(prefix, response).await;
                if let Some(envelope) = crate::protocol::error_sniffer::sniff_http_body(&text) {
                    relay::note_envelope_failure(&state, &uid, &model, &envelope.event).await;
                    let elapsed_ms = started.elapsed().as_millis() as i64;
                    state.log.record(
                        RequestMeta {
                            endpoint: "/v1/messages",
                            key_id: key.as_deref().map(|actor| actor.key_id.clone()),
                            key_scope: key.as_deref().map(|actor| actor.scope),
                            method: "POST",
                            region,
                            account,
                            account_uid: uid,
                            model,
                            status: envelope.status,
                            latency_ms: header_at_ms,
                            total_ms: elapsed_ms,
                            prompt_tokens: 0,
                            completion_tokens: 0,
                            credit: 0.0,
                            stream: false,
                            error: None,
                        }
                        .to_value(),
                    );
                    // 降级后仍然拿到「200 信封错误」：头要带上，否则客户端不知道是备选模型的锅。
                    let mut resp = anthropic_error(crate::error::GatewayError::Upstream {
                        kind: relay::upstream_kind_of(&envelope.event),
                        status: envelope.status,
                        message: envelope.message,
                        attempts: Vec::new(),
                    });
                    if let Some(info) = fallback.as_ref() {
                        relay::apply_fallback_headers(&mut resp, info);
                    }
                    return resp;
                }
                let message = aggregate_message(&text, &model);
                let prompt_tokens = message
                    .get("usage")
                    .and_then(|usage| usage.get("input_tokens"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let completion_tokens = message
                    .get("usage")
                    .and_then(|usage| usage.get("output_tokens"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                /* 积分：与 chat / responses 同一口径（上游 `usage.credit`）。
                缺字段记 0.0（= 不知道），不猜、不按 token 折算。 */
                let credit = message
                    .get("usage")
                    .and_then(|usage| usage.get("credit"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                state.log.record(
                    RequestMeta {
                        endpoint: "/v1/messages",
                        key_id: key.as_deref().map(|actor| actor.key_id.clone()),
                        key_scope: key.as_deref().map(|actor| actor.scope),
                        method: "POST",
                        region,
                        account,
                        account_uid: uid,
                        model,
                        status: 200,
                        latency_ms: header_at_ms,
                        total_ms: started.elapsed().as_millis() as i64,
                        prompt_tokens,
                        completion_tokens,
                        credit,
                        stream: false,
                        error: None,
                    }
                    .to_value(),
                );
                json_response(StatusCode::OK, message)
            };
            // 降级成功：把「从谁降到谁、为什么」写进响应头（与 chat 路由同一套头）。
            if let Some(info) = fallback.as_ref() {
                relay::apply_fallback_headers(&mut resp, info);
            }
            resp
        }
    }
}

#[allow(clippy::result_large_err)]
// `RelayFailure` 承载完整上游响应与诊断上下文，装箱会丢掉「一次就能定位」的可读性。
/// 改写 + 中继一趟（供首次尝试与降级重试共用）。
#[allow(clippy::too_many_arguments)]
async fn run(
    state: &GatewayState,
    region: Region,
    raw: &str,
    model: &str,
    conversation_id: Option<String>,
    turn_key: Option<&str>,
    inbound_request_id: Option<&str>,
    trace_id: Option<String>,
    key: Option<&crate::apikey::KeyActor>,
) -> Result<RelayOutcome, relay::RelayFailure> {
    let prepared = relay::prepare_body(
        state,
        region,
        raw,
        "",
        conversation_id.as_deref(),
        turn_key,
        inbound_request_id,
    )
    .await;

    relay::relay(
        state,
        RelayRequest {
            openai_shape: false,
            region,
            kind: RelayKind::Llm,
            model: model.to_string(),
            prepared_body: prepared.body,
            sanitized: prepared.sanitized,
            conversation_request_id: prepared.conversation_request_id,
            conversation_id,
            trace_id,
            key_policy: key.map(|actor| actor.policy.clone()),
            key_id: key.as_deref().map(|actor| actor.key_id.clone()),
        },
    )
    .await
}

/// 读取请求头（去空白；空值视为未提供）。
fn header_of(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
