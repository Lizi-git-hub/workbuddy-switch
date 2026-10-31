
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use buddy_switch_core::modules::config as core_config;
use buddy_switch_core::modules::product::Scope;

/// 图片输入能力的**来源**（前端据此显示「来自上游 / 你手动指定」，并提供「还原上游」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageCapSource {
    /// 上游目录声明（WB 的 `supportsImages`）—— 权威，用户没动过。
    Upstream,
    /// 用户在「模型」页手动指定（上游没声明、或声明错了）。
    Override,
}

impl ImageCapSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upstream => "upstream",
            Self::Override => "override",
        }
    }
}

/// 解析结果：能力值 + 它的来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageCapability {
    pub supports: bool,
    pub source: ImageCapSource,
}

/// 按**作用域**的图片能力覆盖（用户偏好）。
///
/// 形状 `HashMap<作用域, HashMap<模型 id, bool>>`：**缺失的条目 = 跟随上游**（不是 `false`）。
/// 这一点决定了「还原上游」只需删键，不需要第三态枚举。
///
/// 与 `disabled_models` **同构**（同样按作用域键控、同样进程内唯一实例），
/// 但**刻意不合并成一个 store**：禁用是「能不能调」，能力是「怎么调」，两者的
/// 默认值方向相反（禁用默认全开、能力默认跟随上游），混在一起会让「缺省」有两种解释。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ImageCaps {
    /// 键是作用域 id（[`Scope::as_str`] 的字面量）。
    ///
    /// ⚠️ 用 `String` 而非 `Scope` 作键：`Scope` 是枚举，未知键会让整份反序列化失败
    /// ⇒ `load()` 回落空表 ⇒ 一个未来新增的作用域会**清空全部**用户指定（与
    /// `disabled_models` 同一个脚枪，那边已经踩过）。
    scopes: HashMap<String, HashMap<String, bool>>,
}

impl ImageCaps {
    /// 从 `~/.buddy-switch/gateway_model_image_caps.json` 读取；缺失 / 损坏回落空表。
    pub fn load() -> Self {
        let file = file();
        std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<ImageCaps>(&text).ok())
            .unwrap_or_default()
    }

    /// 原子写回。
    pub fn save(&self) -> Result<(), String> {
        let file = file();
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let content = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        core_config::atomic_write(&file, &content).map_err(|error| error.to_string())
    }

    /// 某作用域的覆盖表（只读；缺失即空表）。
    pub fn get(&self, scope: Scope) -> &HashMap<String, bool> {
        static EMPTY: OnceLock<HashMap<String, bool>> = OnceLock::new();
        self.scopes
            .get(scope.as_str())
            .unwrap_or_else(|| EMPTY.get_or_init(HashMap::new))
    }

    /// 指定 / 清除（`supports = None` ⇒ 删键 = 跟随上游）；返回是否**发生了变化**（幂等）。
    ///
    /// 空白 `model_id` 视为无效输入，直接返回 `false`（不写脏数据）。
    pub fn set(&mut self, scope: Scope, model_id: &str, supports: Option<bool>) -> bool {
        let id = model_id.trim();
        if id.is_empty() {
            return false;
        }
        let table = self.scopes.entry(scope.as_str().to_string()).or_default();
        match supports {
            Some(value) => {
                // 大小写敏感地**先清同名异写**：`GLM-5.3` 与 `glm-5.3` 是同一个模型，
                // 留着两条会在「还原上游」后残留一条反方向的旧覆盖（判断大小写不敏感，见 `lookup`）。
                let stale: Vec<String> = table
                    .keys()
                    .filter(|key| key.eq_ignore_ascii_case(id) && key.as_str() != id)
                    .cloned()
                    .collect();
                for key in stale {
                    table.remove(&key);
                }
                table.insert(id.to_string(), value) != Some(value)
            }
            None => {
                let stale: Vec<String> = table
                    .keys()
                    .filter(|key| key.eq_ignore_ascii_case(id))
                    .cloned()
                    .collect();
                let changed = !stale.is_empty();
                for key in stale {
                    table.remove(&key);
                }
                changed
            }
        }
    }

    /// 大小写不敏感查找（上游对模型名不敏感，`trae::payload::model_config` 也先 `to_lowercase`）。
    ///
    /// 与 `disabled_models::is_disabled_in` 同一理由：精确匹配会让 `GLM-5.3` 绕过 `glm-5.3`
    /// 的覆盖 ⇒ 同一个模型两副面孔。
    fn lookup(&self, scope: Scope, model_id: &str) -> Option<bool> {
        let id = model_id.trim();
        if id.is_empty() {
            return None;
        }
        self.get(scope)
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(id))
            .map(|(_, value)| *value)
    }
}

/// 覆盖文件路径：`~/.buddy-switch/gateway_model_image_caps.json`（与 `gateway_config.json` 同目录）。
pub fn file() -> PathBuf {
    buddy_switch_core::modules::region::gateway_config_file()
        .with_file_name("gateway_model_image_caps.json")
}

static SHARED: OnceLock<RwLock<ImageCaps>> = OnceLock::new();

/// 取共享存储（首次调用时从磁盘加载）。
pub fn shared() -> &'static RwLock<ImageCaps> {
    SHARED.get_or_init(|| RwLock::new(ImageCaps::load()))
}

/// 某作用域的覆盖表快照（克隆一份，供管理面命令序列化用）。
pub fn overrides_of(scope: Scope) -> HashMap<String, bool> {
    shared()
        .read()
        .map(|guard| guard.get(scope).clone())
        .unwrap_or_default()
}

/// **唯一解析点**（全局版）：上游声明 > 用户覆盖；两边都没有 ⇒ `None`（不下发字段）。
///
/// 读锁中毒时回落「只有上游声明」—— 宁可少一个用户覆盖，也不要让整张清单 500。
pub fn resolve_effective(
    scope: Scope,
    model_id: &str,
    upstream: Option<bool>,
) -> Option<ImageCapability> {
    let override_value = shared()
        .read()
        .ok()
        .and_then(|guard| guard.lookup(scope, model_id));
    if let Some(supports) = override_value {
        return Some(ImageCapability {
            supports,
            source: ImageCapSource::Override,
        });
    }
    upstream.map(|supports| ImageCapability {
        supports,
        source: ImageCapSource::Upstream,
    })
}

/// 写入一条覆盖并**落盘**（`supports = None` ⇒ 删键 = 跟随上游）；返回是否发生了变化。
///
/// ⚠️ 这是**阻塞**调用（含磁盘写）：命令面必须放进 `spawn_blocking`（本仓既有纪律：
/// 同步 IO 不得压在 IPC / 事件循环线程上）。持锁只到内存改完为止，落盘在锁外。
pub fn set_and_save(scope: Scope, model_id: &str, supports: Option<bool>) -> Result<bool, String> {
    let snapshot = {
        let mut guard = shared()
            .write()
            .map_err(|_| "图片能力存储已损坏（锁中毒）".to_string())?;
        let changed = guard.set(scope, model_id, supports);
        if !changed {
            return Ok(false);
        }
        guard.clone()
    };
    snapshot.save()?;
    Ok(true)
}

/// **唯一解析点**：上游声明 > 用户覆盖；两边都没有 ⇒ `None`（不下发字段）。
///
/// `upstream`：WB 目录给的 `supports_images`；Trae / Qoder 传 `None`。
pub fn resolve(
    store: &ImageCaps,
    scope: Scope,
    model_id: &str,
    upstream: Option<bool>,
) -> Option<ImageCapability> {
    if let Some(supports) = store.lookup(scope, model_id) {
        return Some(ImageCapability {
            supports,
            source: ImageCapSource::Override,
        });
    }
    upstream.map(|supports| ImageCapability {
        supports,
        source: ImageCapSource::Upstream,
    })
}

/// 把能力写进一条模型条目（**三个出口 + 两个管理面视图的唯一写入点**）。
///
/// - `Some(cap)` ⇒ `supports_images` + `image_input_source` + OpenRouter 兼容的 `architecture`；
/// - `None` ⇒ 把可能已存在的 `supports_images` **删掉**（上游没声明就不许有残留断言）。
///
/// 返回解析结果，调用方一般不用，测试要用。
pub fn apply(
    object: &mut Map<String, Value>,
    scope: Scope,
    model_id: &str,
    upstream: Option<bool>,
) -> Option<ImageCapability> {
    let capability = resolve_effective(scope, model_id, upstream);
    write_capability(object, capability)
}

/// [`apply`] 的纯函数内核（不读全局存储，便于单测注入存储）。
pub fn write_capability(
    object: &mut Map<String, Value>,
    capability: Option<ImageCapability>,
) -> Option<ImageCapability> {
    match capability {
        Some(cap) => {
            object.insert("supports_images".into(), Value::Bool(cap.supports));
            object.insert(
                "image_input_source".into(),
                Value::String(cap.source.as_str().to_string()),
            );
            object.insert("architecture".into(), architecture(cap.supports));
        }
        None => {
            object.remove("supports_images");
            object.insert("image_input_source".into(), Value::Null);
            object.remove("architecture");
        }
    }
    capability
}

/// OpenRouter 形状的能力块（`/api/v1/models` 的 `architecture`）。
///
/// 只声明输入/输出模态：`modality` 是同一事实的字符串写法，很多客户端读它。
fn architecture(supports_images: bool) -> Value {
    let inputs = if supports_images {
        serde_json::json!(["text", "image"])
    } else {
        serde_json::json!(["text"])
    };
    serde_json::json!({
        "modality": if supports_images { "text+image->text" } else { "text->text" },
        "input_modalities": inputs,
        "output_modalities": ["text"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(scope: Scope, id: &str, value: bool) -> ImageCaps {
        let mut store = ImageCaps::default();
        store.set(scope, id, Some(value));
        store
    }

    #[test]
    fn undeclared_emits_no_field() {
        let mut object = Map::new();
        object.insert("id".into(), serde_json::json!("m"));
        // 上游没声明（Trae / Qoder 的常态）
        assert_eq!(write_capability(&mut object, None), None);
        assert!(
            object.get("supports_images").is_none(),
            "未声明不得下发能力断言"
        );
        assert!(object.get("architecture").is_none());
        assert_eq!(object["image_input_source"], Value::Null);
    }

    /// 上游声明优先；用户覆盖压过上游；覆盖清掉后回落上游。
    #[test]
    fn override_beats_upstream_and_can_be_cleared() {
        let mut store = ImageCaps::default();
        let mut object = Map::new();
        let apply = |store: &ImageCaps, object: &mut Map<String, Value>| {
            write_capability(
                object,
                resolve(store, Scope::WbCn, "deepseek-v4.1", Some(true)),
            )
        };

        // ① 上游声明 true，没有覆盖 ⇒ upstream
        let cap = apply(&store, &mut object).unwrap();
        assert!(cap.supports);
        assert_eq!(cap.source, ImageCapSource::Upstream);
        assert_eq!(object["supports_images"], Value::Bool(true));
        assert_eq!(object["image_input_source"], "upstream");
        assert_eq!(
            object["architecture"]["input_modalities"],
            serde_json::json!(["text", "image"])
        );

        // ② 用户改成「不支持」⇒ 覆盖压过上游
        store.set(Scope::WbCn, "deepseek-v4.1", Some(false));
        let cap = apply(&store, &mut object).unwrap();
        assert!(!cap.supports);
        assert_eq!(cap.source, ImageCapSource::Override);
        assert_eq!(object["supports_images"], Value::Bool(false));
        assert_eq!(
            object["architecture"]["input_modalities"],
            serde_json::json!(["text"])
        );

        // ③ 还原上游（删键）⇒ 回到 upstream 声明
        assert!(store.set(Scope::WbCn, "deepseek-v4.1", None));
        let cap = apply(&store, &mut object).unwrap();
        assert_eq!(cap.source, ImageCapSource::Upstream);
        assert!(cap.supports);
    }

    /// 上游没声明时，用户覆盖就是唯一真值（Trae / Qoder 的全部可用路径）。
    #[test]
    fn override_works_without_upstream() {
        let store = store_with(Scope::QoderCn, "Qwen3.8-Max", true);
        let cap = resolve(&store, Scope::QoderCn, "Qwen3.8-Max", None).unwrap();
        assert!(cap.supports);
        assert_eq!(cap.source, ImageCapSource::Override);
    }

    /// 作用域隔离：`wb-cn` 的覆盖不得影响 `trae-cn` / `qoder-cn`。
    #[test]
    fn scopes_are_independent() {
        let store = store_with(Scope::WbCn, "m", true);
        assert!(resolve(&store, Scope::WbCn, "m", None).is_some());
        assert!(resolve(&store, Scope::TraeCn, "m", None).is_none());
        assert!(resolve(&store, Scope::QoderCn, "m", None).is_none());
    }

    /// 大小写不敏感：覆盖写 `glm-5.3`，查询 `GLM-5.3` 必须命中；且**不留下重复键**。
    #[test]
    fn lookup_is_case_insensitive_and_dedupes() {
        let mut store = ImageCaps::default();
        store.set(Scope::TraeCn, "glm-5.3", Some(true));
        assert_eq!(
            resolve(&store, Scope::TraeCn, "GLM-5.3", None).map(|cap| cap.supports),
            Some(true)
        );
        // 换成另一种写法 ⇒ 旧键被清掉（否则「还原上游」会残留反方向覆盖）
        store.set(Scope::TraeCn, "GLM-5.3", Some(false));
        assert_eq!(store.get(Scope::TraeCn).len(), 1);
        assert_eq!(
            resolve(&store, Scope::TraeCn, "glm-5.3", None).map(|cap| cap.supports),
            Some(false)
        );
    }

    /// `set` 幂等：重复写同值 / 重复清空都返回 `false`（命令面据此跳过落盘）。
    #[test]
    fn set_is_idempotent() {
        let mut store = ImageCaps::default();
        assert!(store.set(Scope::WbCn, "m", Some(true)));
        assert!(!store.set(Scope::WbCn, "m", Some(true)));
        assert!(store.set(Scope::WbCn, "m", None));
        assert!(!store.set(Scope::WbCn, "m", None));
        // 空白 id 一律拒绝（不写脏数据）
        assert!(!store.set(Scope::WbCn, "  ", Some(true)));
    }
}
