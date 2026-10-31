//! `GET /v1/models`：按 Key 绑定 region 返回模型列表 + 来源标注（P0-4）。

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::json;

use crate::disabled_models::is_disabled;
use crate::routes::{authenticate, json_response, openai_error};
use crate::state::GatewayState;
use buddy_switch_core::modules::catalog::{CatalogModel, CatalogSnapshot};
use buddy_switch_core::modules::product::{scope_of_wb_region, Scope};

pub fn model_entry(model: &CatalogModel, max_context: bool, scope: Scope) -> serde_json::Value {
    // 开关决定声明「上限档」还是「默认档」（上游两档：如 300k 默认 / 1M 上限）。
    let window = if max_context {
        model.context_window
    } else {
        model.context_window_default.unwrap_or(model.context_window)
    };
    let mut value = json!({
        "id": model.id,
        "object": "model",
        "created": 0,
        "owned_by": "workbuddy",
        "context_length": window,
        // 两档原值：前端据此本地即时切换，不必等重新取数。
        "context_length_default": model.context_window_default,
        "context_length_max": model.context_window,
        "context_window": window,
        "max_tokens": model.max_tokens,
        // 原文（上游怎么写就怎么给）+ 数字（同一份解析的唯一出口）。
        "credits": model.credits,
        "credits_rate": model.credits_rate(),
        "badges": model.badges,
        // 判零用 `is_free()`（认 `x0.00 credits`），不读落盘的 `free` 快照。
        "free": model.is_free(),
    });
    if let Some(object) = value.as_object_mut() {
        crate::model_capability::apply(object, scope, &model.id, Some(model.supports_images));
        if let Some(region) = scope.wb_region() {
            let ability =
                ModelAbility::resolve(model, crate::outbound::effort::static_effort_cap(region));
            if !ability.efforts.is_empty() {
                object.insert(
                    "reasoning_efforts".into(),
                    serde_json::json!(ability.efforts),
                );
                object.insert(
                    "default_effort".into(),
                    serde_json::json!(ability.default_effort),
                );
                object.insert("efforts_source".into(), serde_json::json!(ability.source));
            }
        }
    }
    value
}

pub fn snapshot_view(snapshot: &CatalogSnapshot, max_context: bool) -> serde_json::Value {
    let table = crate::outbound::effort::static_effort_cap(snapshot.region);
    let mut snapshot = snapshot.clone();
    // 先记上限档，再把 `context_window` 换成生效档 —— 前端要两档原值才能本地即时切换。
    let maxes: Vec<u64> = snapshot.models.iter().map(|m| m.context_window).collect();
    let abilities: Vec<ModelAbility> = snapshot
        .models
        .iter()
        .map(|model| ModelAbility::resolve(model, table))
        .collect();
    for model in &mut snapshot.models {
        model.context_window = model.effective_window(max_context);
        // 老缓存可能带着按旧判据算的 `free`（`x0.00 credits` 判成收费）⇒ 出口重算一次。
        model.refresh_derived();
    }
    let mut value = serde_json::to_value(&snapshot).unwrap_or(serde_json::Value::Null);
    if let Some(rows) = value.get_mut("models").and_then(|v| v.as_array_mut()) {
        let scope = scope_of_wb_region(snapshot.region);
        for ((row, max), ability) in rows.iter_mut().zip(maxes).zip(abilities) {
            if let Some(object) = row.as_object_mut() {
                object.insert("context_length_max".into(), serde_json::json!(max));
                object.remove("reasoning");
                object.insert(
                    "credits_rate".into(),
                    serde_json::json!(ability.credits_rate),
                );
                object.insert(
                    "reasoning_efforts".into(),
                    serde_json::json!(ability.efforts),
                );
                object.insert(
                    "default_effort".into(),
                    serde_json::json!(ability.default_effort),
                );
                object.insert("efforts_source".into(), serde_json::json!(ability.source));
                let id = object
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let upstream = object.get("supports_images").and_then(|v| v.as_bool());
                crate::model_capability::apply(object, scope, &id, upstream);
            }
        }
    }
    value
}

/// 一条模型的「能力面」（思考档位 + 积分倍率），供管理面渲染。
struct ModelAbility {
    efforts: Vec<String>,
    default_effort: Option<String>,
    /// `"upstream"`（上游目录声明）/ `"static"`（内置档位表）/ `None`（两边都没有）。
    source: Option<&'static str>,
    credits_rate: Option<f64>,
}

impl ModelAbility {
    fn resolve(
        model: &CatalogModel,
        table: &std::collections::HashMap<&'static str, crate::outbound::effort::EffortSpec>,
    ) -> Self {
        let upstream = model.reasoning.as_ref().filter(|r| !r.efforts.is_empty());
        let spec = table.get(model.id.trim()).filter(|s| !s.efforts.is_empty());
        let (efforts, source) = match (upstream, spec) {
            (Some(reasoning), _) => (reasoning.efforts.clone(), Some("upstream")),
            (None, Some(spec)) => (spec.efforts.clone(), Some("static")),
            (None, None) => (Vec::new(), None),
        };
        // 默认档只取「确实可选」的那一档：默认值不在可选集里就是上游自相矛盾，
        // 展示它会直接误导（用户照着它传请求会被降级）。
        let default_effort = model
            .reasoning
            .as_ref()
            .and_then(|reasoning| reasoning.default_effort.clone())
            .or_else(|| spec.and_then(|spec| spec.default_effort.clone()))
            .filter(|effort| !efforts.is_empty() && efforts.contains(effort));
        Self {
            efforts,
            default_effort,
            source,
            credits_rate: model.credits_rate(),
        }
    }
}

/// 模型列表处理器。
pub async fn handler(State(state): State<GatewayState>, headers: HeaderMap) -> Response {
    let record = match authenticate(&state, &headers) {
        Ok(record) => record,
        Err(error) => return openai_error(error),
    };

    let snapshot = state.catalogs.current(record.region);
    let disabled = state.disabled.read().await;
    let max_context = state.config.read().await.max_context;
    // 作用域一次算好：禁用过滤与图片能力解析读的是**同一个**作用域（WB 的 region → Scope）。
    let scope = scope_of_wb_region(record.region);
    let data: Vec<serde_json::Value> = snapshot
        .models
        .iter()
        .filter(|model| !is_disabled(&disabled, scope, &model.id))
        .map(|model| model_entry(model, max_context, scope))
        .collect();
    drop(disabled);

    json_response(
        StatusCode::OK,
        json!({
            "object": "list",
            "data": data,
            "wb_region": snapshot.region,
            "wb_source": snapshot.source,
            "wb_fetched_at": snapshot.fetched_at,
            "wb_note": snapshot.note,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use buddy_switch_core::modules::catalog::CatalogReasoning;

    #[test]
    fn wb_model_entry_declares_openai_context_length() {
        let model = CatalogModel {
            id: "hy4-preview".into(),
            name: "Hy4 preview".into(),
            context_window: 960_000,
            context_window_default: Some(300_000),
            max_tokens: 64_000,
            supports_images: true,
            credits: None,
            badges: vec![],
            free: false,
            reasoning: None,
        };
        let max = model_entry(&model, true, Scope::WbCn);
        assert_eq!(max["context_length"], 960_000, "默认用上限档");
        assert_eq!(max["context_window"], 960_000);

        // 开关关 ⇒ 声明默认档（上游 contextWindow.defaultLength）。
        let lower = model_entry(&model, false, Scope::WbCn);
        assert_eq!(lower["context_length"], 300_000);
        assert_eq!(lower["context_window"], 300_000);
    }

    #[test]
    fn wb_model_entry_declares_image_capability() {
        let mut model = CatalogModel {
            id: "issue101-image-probe".into(),
            name: "probe".into(),
            context_window: 200_000,
            context_window_default: None,
            max_tokens: 32_000,
            supports_images: true,
            credits: None,
            badges: vec![],
            free: false,
            reasoning: None,
        };
        let entry = model_entry(&model, true, Scope::WbCn);
        assert_eq!(entry["supports_images"], true);
        assert_eq!(entry["image_input_source"], "upstream");
        // OpenRouter 兼容字段：主流客户端读的是它，不读我们的私有 `supports_images`。
        assert_eq!(
            entry["architecture"]["input_modalities"],
            serde_json::json!(["text", "image"])
        );
        assert_eq!(entry["architecture"]["modality"], "text+image->text");

        // 上游明确说不支持 ⇒ 给 `false`（客户端据此隐藏上传入口），**不是**省略。
        model.supports_images = false;
        let entry = model_entry(&model, true, Scope::WbCn);
        assert_eq!(entry["supports_images"], false);
        assert_eq!(
            entry["architecture"]["input_modalities"],
            serde_json::json!(["text"])
        );
    }

    /// 没有默认档的上游（如国内目录只给一个数）⇒ 关开关也回落到上限，不能变 0。
    #[test]
    fn wb_model_entry_falls_back_when_no_default_window() {
        let model = CatalogModel {
            id: "glm-5.3".into(),
            name: "GLM-5.3".into(),
            context_window: 1_000_000,
            context_window_default: None,
            max_tokens: 48_000,
            supports_images: true,
            credits: None,
            badges: vec![],
            free: false,
            reasoning: None,
        };
        assert_eq!(
            model_entry(&model, false, Scope::WbCn)["context_length"],
            1_000_000
        );
    }

    fn model(id: &str, credits: Option<&str>, reasoning: Option<CatalogReasoning>) -> CatalogModel {
        let mut model = CatalogModel {
            id: id.into(),
            name: id.into(),
            context_window: 200_000,
            context_window_default: None,
            max_tokens: 32_000,
            supports_images: false,
            credits: credits.map(str::to_string),
            badges: vec![],
            free: false,
            reasoning,
        };
        model.refresh_derived();
        model
    }

    fn snapshot(models: Vec<CatalogModel>) -> CatalogSnapshot {
        CatalogSnapshot {
            region: buddy_switch_core::modules::region::Region::Cn,
            source: buddy_switch_core::modules::catalog::CatalogSource::Live,
            fetched_at: Some(1),
            models,
            note: None,
        }
    }

    #[test]
    fn wb_model_entry_declares_reasoning_efforts() {
        // ① 上游声明优先，`efforts_source = "upstream"`。
        let upstream = model(
            "kimi-k2.8-preview",
            None,
            Some(CatalogReasoning {
                efforts: vec!["low".into(), "high".into(), "max".into()],
                default_effort: Some("high".into()),
                can_disable_thinking: None,
            }),
        );
        let entry = model_entry(&upstream, true, Scope::WbCn);
        assert_eq!(
            entry["reasoning_efforts"],
            serde_json::json!(["low", "high", "max"])
        );
        assert_eq!(entry["default_effort"], "high");
        assert_eq!(entry["efforts_source"], "upstream");

        // ② 上游没声明 ⇒ 回落内置静态表，来源必须标明 `"static"`（否则用户以为网关读错了）。
        let fallback = model_entry(&model("glm-5.3", None, None), true, Scope::WbCn);
        assert!(
            fallback["reasoning_efforts"]
                .as_array()
                .is_some_and(|list| !list.is_empty()),
            "{fallback}"
        );
        assert_eq!(fallback["efforts_source"], "static");

        // ③ 两边都没有 ⇒ **不下发**这三个字段（不是空数组：空数组会被读成「不支持思考」）。
        let unknown = model_entry(&model("not-anywhere", None, None), true, Scope::WbCn);
        assert!(unknown.get("reasoning_efforts").is_none(), "{unknown}");
        assert!(unknown.get("efforts_source").is_none(), "{unknown}");
    }

    #[test]
    fn snapshot_view_resolves_efforts_with_source() {
        let view = snapshot_view(
            &snapshot(vec![
                // 上游声明（`kimi-k2.8-preview` 不在任何静态表里）
                model(
                    "kimi-k2.8-preview",
                    Some("x1.65"),
                    Some(CatalogReasoning {
                        efforts: vec!["low".into(), "high".into(), "max".into()],
                        default_effort: Some("high".into()),
                        can_disable_thinking: Some(true),
                    }),
                ),
                // 上游没声明、静态表有
                model("glm-5.3", Some("x0.79"), None),
                // 两边都没有
                model("not-anywhere", None, None),
            ]),
            true,
        );
        let rows = view["models"].as_array().unwrap();

        assert_eq!(rows[0]["efforts_source"], "upstream");
        assert_eq!(
            rows[0]["reasoning_efforts"],
            serde_json::json!(["low", "high", "max"])
        );
        assert_eq!(rows[0]["default_effort"], "high");
        assert_eq!(rows[0]["credits_rate"], 1.65);
        assert!(rows[0].get("reasoning").is_none());

        assert_eq!(rows[1]["efforts_source"], "static");
        assert_eq!(
            rows[1]["reasoning_efforts"],
            serde_json::json!(["low", "high", "max"]),
            "glm-5.3 的 CN 静态表是 low/high/max"
        );
        assert_eq!(rows[1]["default_effort"], "high");

        assert!(rows[2]["efforts_source"].is_null());
        assert_eq!(rows[2]["reasoning_efforts"], serde_json::json!([]));
        assert!(rows[2]["default_effort"].is_null());
        assert!(rows[2]["credits_rate"].is_null());
    }

    #[test]
    fn zero_credits_with_suffix_is_free() {
        let with_suffix = model("hy3", Some("x0.00 credits"), None);
        assert_eq!(with_suffix.credits_rate(), Some(0.0));
        assert!(with_suffix.is_free(), "`x0.00 credits` 必须判免费");
        assert_eq!(model_entry(&with_suffix, true, Scope::WbCn)["free"], true);
        assert_eq!(
            model_entry(&with_suffix, true, Scope::WbCn)["credits_rate"],
            0.0
        );

        // 非零带后缀照常给数字（前端不必各自剥后缀）
        let paid = model("fast-model", Some("x0.34 credits"), None);
        assert_eq!(paid.credits_rate(), Some(0.34));
        assert!(!paid.is_free());
    }

    /// 默认档不在可选集里 ⇒ 不展示（上游自相矛盾时宁可不显示，也别误导）。
    #[test]
    fn default_effort_outside_supported_set_is_dropped() {
        let view = snapshot_view(
            &snapshot(vec![model(
                "weird",
                None,
                Some(CatalogReasoning {
                    efforts: vec!["low".into()],
                    default_effort: Some("max".into()),
                    can_disable_thinking: None,
                }),
            )]),
            true,
        );
        assert_eq!(
            view["models"][0]["reasoning_efforts"],
            serde_json::json!(["low"])
        );
        assert!(view["models"][0]["default_effort"].is_null());
    }
}
