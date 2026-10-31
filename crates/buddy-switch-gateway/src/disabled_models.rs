
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use buddy_switch_core::modules::config as core_config;
use buddy_switch_core::modules::product::Scope;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DisabledModels {
    /// 键是作用域 id（[`Scope::as_str`] 的字面量）。
    ///
    /// ⚠️ 用 `String`（**不是** `Scope`）作键：`Scope` 是枚举，**未知键会让整份反序列化失败**
    /// ⇒ `load()` 回落**空表** ⇒ 一个未知键（未来新增作用域 / 手改文件）会**清空全部**
    /// 禁用偏好（P11 T04 发现的脚枪）。改用字符串键后，未知键被**原样保留**、不影响已知键。
    ///
    /// `alias = "regions"`：旧文件的顶层键名是 `regions`（值为 `cn` / `global` 键）——
    /// 借别名读进来后由 [`DisabledModels::migrate_legacy_keys`] 完成键的升级。
    #[serde(alias = "regions")]
    scopes: HashMap<String, BTreeSet<String>>,
}

/// 旧 region 键 → 当时共用它的**平台作用域**（迁移扇出表，见模块文档）。
///
/// ⚠️ 表里**没有 Qoder**：旧键存在时 Qoder 尚未接入，扇给它 = 栽赃。
const LEGACY_REGION_FANOUT: &[(&str, &[&str])] = &[
    ("cn", &["wb-cn", "trae-cn"]),
    ("global", &["wb-global", "trae-global"]),
];

impl DisabledModels {
    /// 从 `~/.buddy-switch/gateway_disabled_models.json` 读取；缺失 / 损坏回落空表。
    ///
    /// 读入后先做一次**幂等的键迁移**（旧 region 键 → 作用域键，见模块文档）；
    /// 若确实发生了迁移，**尽力**把规范化结果写回（写失败忽略 —— 内存态已正确，
    /// 下次启动会再迁一次，不产生任何行为差异）。
    pub fn load() -> Self {
        let file = file();
        let parsed = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<DisabledModels>(&text).ok());
        let mut store = parsed.unwrap_or_default();
        if store.migrate_legacy_keys() {
            let _ = store.save();
        }
        store
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

    /// 旧 region 键 → 作用域键的**一次性、幂等**迁移（见模块文档）。
    ///
    /// 返回是否发生了迁移（`load()` 据此决定要不要回写文件）。
    pub fn migrate_legacy_keys(&mut self) -> bool {
        let mut changed = false;
        for (legacy, targets) in LEGACY_REGION_FANOUT {
            let Some(legacy_set) = self.scopes.remove(*legacy) else {
                continue;
            };
            changed = true;
            // 扇出 = **并集**（只增不减）：不覆盖目标里已有的条目。
            for target in *targets {
                let set = self.scopes.entry((*target).to_string()).or_default();
                set.extend(legacy_set.iter().cloned());
            }
        }
        changed
    }

    /// 某作用域的禁用集合（只读；缺失即空集）。
    ///
    /// 用 `unwrap_or(empty_set())`（**值**，不是 `unwrap_or_else(闭包)`）：后者会让编译器把
    /// 返回类型统一成闭包的 `&'static`，进而要求 `&self` 的借用也活到 `'static`（E0521）。
    /// `empty_set()` 只是取一个 `OnceLock`，开销可忽略。
    pub fn get(&self, scope: Scope) -> &BTreeSet<String> {
        self.scopes.get(scope.as_str()).unwrap_or(empty_set())
    }

    /// 置位 / 清位；返回是否**发生了变化**（幂等）。
    ///
    /// 空白 `model_id` 视为无效输入，直接返回 `false`（不写脏数据）。
    pub fn set(&mut self, scope: Scope, model_id: &str, disabled: bool) -> bool {
        let id = model_id.trim();
        if id.is_empty() {
            return false;
        }
        let set = self.scopes.entry(scope.as_str().to_string()).or_default();
        if disabled {
            set.insert(id.to_string())
        } else {
            set.remove(id)
        }
    }
}

/// 共享的空集（`get` 找不到作用域时的回落）。
fn empty_set() -> &'static BTreeSet<String> {
    static EMPTY: OnceLock<BTreeSet<String>> = OnceLock::new();
    EMPTY.get_or_init(BTreeSet::new)
}

pub fn is_disabled(store: &DisabledModels, scope: Scope, model_id: &str) -> bool {
    is_disabled_in(store.get(scope), model_id)
}

/// 唯一判断点的**核心**：判断一个**已按作用域取出的**禁用集合是否命中某模型。
///
/// ## 为什么**大小写不敏感**（P11 T04 发现的真 bug）
///
/// 上游对模型名**大小写不敏感**：Trae 的 `trae::payload::model_config` 就是先
/// `name.to_lowercase()` 归一后再发给上游。若这里做**精确**匹配，用户禁用 `glm-5.3` 后，
/// 客户端调用 `GLM-5.3` 会**绕过**禁用（不命中 ⇒ 放行 ⇒ 上游接受）—— 正是 P11 要消灭的
/// 「假开关」。故判断一律走 [`eq_ignore_ascii_case`]。
///
/// ## 为什么**存储保持原始大小写**（而不是写入时就归一成小写）
///
/// `get()` 的返回值经命令面（`get_disabled_models`）喂给前端做 `disabledSet.has(model.id)`
/// **精确匹配**。若把存储归一成小写，混合大小写的模型（如 `DeepSeek-V4-Flash-Official`）在
/// UI 上会**显示成未禁用**（用户明明禁用了却看不出）—— 那是更糟的困惑。
/// ⇒ 只让**判断**大小写不敏感，**存储与 `get()` 保持原样**。
pub fn is_disabled_in(set: &BTreeSet<String>, model_id: &str) -> bool {
    let id = model_id.trim();
    // 空 / 空白 id 永远不命中（`set` 也不会写入它）。
    if id.is_empty() {
        return false;
    }
    set.iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(id))
}

pub fn disabled_message(scope: Scope, model: &str) -> String {
    format!(
        "模型 `{model}`（{}）已在「模型」页被禁用，不会出现在 `/v1/models`；\
         如需调用请在「模型」页重新启用",
        scope_display(scope)
    )
}

/// 作用域的中文展示名（`{平台名} {区域名}`，与前端 `scopeLabel` 同一拼法）。
///
/// ⚠️ 前端拼法在 `src/components/scope-chip.tsx::scopeLabel`；两处都要改时**同步**。
/// 这里是后端**错误文案**的用词，不参与前端渲染，故不做过重的防漂移工装 ——
/// 但六个取值必须一一列全（穷举 match，编译期兜住新增作用域）。
fn scope_display(scope: Scope) -> &'static str {
    match scope {
        Scope::WbCn => "WorkBuddy 国内版",
        Scope::WbGlobal => "WorkBuddy 国际版",
        Scope::TraeCn => "TraeWork 国内版",
        Scope::TraeGlobal => "TraeWork 国际版",
        Scope::QoderCn => "Qoder 国内版",
        Scope::QoderGlobal => "Qoder 国际版",
    }
}

/// 禁用偏好文件路径：`~/.buddy-switch/gateway_disabled_models.json`（与 `gateway_config.json` 同目录）。
pub fn file() -> PathBuf {
    buddy_switch_core::modules::region::gateway_config_file()
        .with_file_name("gateway_disabled_models.json")
}

/// 进程内**唯一**的禁用存储句柄：三个网关 / 命令面**共用同一份**（见模块文档）。
pub fn shared() -> Arc<RwLock<DisabledModels>> {
    static SHARED: OnceLock<Arc<RwLock<DisabledModels>>> = OnceLock::new();
    SHARED
        .get_or_init(|| Arc::new(RwLock::new(DisabledModels::load())))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_is_idempotent_and_reports_change() {
        let mut store = DisabledModels::default();
        // 首次禁用 ⇒ 有变化
        assert!(store.set(Scope::WbCn, "glm-5.3", true));
        // 重复禁用 ⇒ 无变化
        assert!(!store.set(Scope::WbCn, "glm-5.3", true));
        assert!(is_disabled(&store, Scope::WbCn, "glm-5.3"));
        // 启用 ⇒ 有变化
        assert!(store.set(Scope::WbCn, "glm-5.3", false));
        // 重复启用 ⇒ 无变化
        assert!(!store.set(Scope::WbCn, "glm-5.3", false));
        assert!(!is_disabled(&store, Scope::WbCn, "glm-5.3"));
    }

    #[test]
    fn scopes_are_independent_including_same_region_across_products() {
        let mut store = DisabledModels::default();
        store.set(Scope::WbCn, "m", true);
        // 禁用了 wb-cn 的 m，不影响同为「国内」的 trae-cn / qoder-cn —— 三套目录互不相通。
        assert!(is_disabled(&store, Scope::WbCn, "m"));
        assert!(!is_disabled(&store, Scope::TraeCn, "m"));
        assert!(!is_disabled(&store, Scope::QoderCn, "m"));
        assert!(!is_disabled(&store, Scope::WbGlobal, "m"));
    }

    #[test]
    fn blank_id_is_rejected_and_trimmed_ids_match() {
        let mut store = DisabledModels::default();
        assert!(!store.set(Scope::WbCn, "   ", true), "空白 id 不得写入");
        assert!(!is_disabled(&store, Scope::WbCn, "   "));

        store.set(Scope::WbCn, "  glm-5.3  ", true);
        // 判断点统一 trim ⇒ 前后空格不影响命中。
        assert!(is_disabled(&store, Scope::WbCn, "glm-5.3"));
        assert!(is_disabled(&store, Scope::WbCn, "  glm-5.3 "));
    }

    #[test]
    fn empty_store_has_no_disabled_models() {
        let store = DisabledModels::default();
        assert!(!is_disabled(&store, Scope::QoderCn, "anything"));
        assert!(store.get(Scope::QoderCn).is_empty());
    }

    #[test]
    fn serde_round_trips_with_scope_keys() {
        let mut store = DisabledModels::default();
        store.set(Scope::WbCn, "a", true);
        store.set(Scope::QoderGlobal, "b", true);
        let text = serde_json::to_string(&store).unwrap();
        // 键是**作用域 id**（不是「cn」这种裸 region）。
        assert!(text.contains("\"wb-cn\""), "{text}");
        assert!(text.contains("\"qoder-global\""), "{text}");
        assert!(text.contains("\"scopes\""), "{text}");
        let back: DisabledModels = serde_json::from_str(&text).unwrap();
        assert!(is_disabled(&back, Scope::WbCn, "a"));
        assert!(is_disabled(&back, Scope::QoderGlobal, "b"));
    }

    #[test]
    fn legacy_region_keys_fan_out_to_platform_scopes_once() {
        let legacy = r#"{
            "regions": {
                "cn": ["model-a", "shared"],
                "global": ["model-b"],
                "wb-cn": ["hand-edited"]
            }
        }"#;
        let mut store: DisabledModels = serde_json::from_str(legacy).expect("旧文件必须能读进来");
        assert!(store.migrate_legacy_keys(), "有旧键 ⇒ 必须报告发生了迁移");

        // 扇出：cn → wb-cn + trae-cn（与 wb-cn 已有条目取并集）。
        for scope in [Scope::WbCn, Scope::TraeCn] {
            assert!(is_disabled(&store, scope, "model-a"), "{scope:?}");
            assert!(is_disabled(&store, scope, "shared"), "{scope:?}");
        }
        assert!(
            is_disabled(&store, Scope::WbCn, "hand-edited"),
            "手改条目不得被覆盖"
        );
        assert!(is_disabled(&store, Scope::WbGlobal, "model-b"));
        assert!(is_disabled(&store, Scope::TraeGlobal, "model-b"));

        // Qoder **不继承**任何旧条目。
        for scope in [Scope::QoderCn, Scope::QoderGlobal] {
            assert!(
                !is_disabled(&store, scope, "model-a"),
                "Qoder 不得继承旧键：{scope:?}"
            );
            assert!(
                !is_disabled(&store, scope, "model-b"),
                "Qoder 不得继承旧键：{scope:?}"
            );
        }

        // 幂等：再迁一次 = 无变化。
        assert!(!store.migrate_legacy_keys(), "迁移必须幂等");

        // 规范化后的序列化不再含裸 region 键。
        let text = serde_json::to_string(&store).unwrap();
        assert!(!text.contains("\"cn\""), "{text}");
        assert!(!text.contains("\"global\""), "{text}");
    }

    /// 未知键（未来作用域 / 手改的垃圾）**原样保留**，不影响已知键 —— P11 T04 的脚枪不复发。
    #[test]
    fn unknown_keys_are_preserved_and_do_not_wipe_known_scopes() {
        let text = r#"{
            "scopes": {
                "wb-cn": ["keep-me"],
                "future-scope": ["whatever"]
            }
        }"#;
        let mut store: DisabledModels = serde_json::from_str(text).unwrap();
        assert!(is_disabled(&store, Scope::WbCn, "keep-me"));
        assert!(!store.migrate_legacy_keys(), "没有旧键 ⇒ 不报告迁移");
        // 未知键在重新序列化后仍在（原样保留）。
        let round = serde_json::to_string(&store).unwrap();
        assert!(round.contains("future-scope"), "{round}");
    }

    #[test]
    fn corrupted_or_missing_file_falls_back_to_empty() {
        // 损坏内容 ⇒ 回落空表（不 panic、不报错）。
        let store: DisabledModels = serde_json::from_str("{ not json").unwrap_or_default();
        assert!(!is_disabled(&store, Scope::WbCn, "x"));
    }

    #[test]
    fn disabled_message_names_the_model_and_says_disabled() {
        let message = disabled_message(Scope::WbCn, "glm-5.3");
        assert!(message.contains("glm-5.3"), "必须点名模型：{message}");
        assert!(
            message.contains("被禁用"),
            "必须说明是「被禁用」：{message}"
        );
        assert!(
            message.contains("/v1/models"),
            "必须说明两个出口：{message}"
        );
        assert!(
            message.contains("WorkBuddy 国内版"),
            "必须点名作用域：{message}"
        );
        let qoder = disabled_message(Scope::QoderCn, "m");
        assert!(qoder.contains("Qoder 国内版"), "{qoder}");
    }
}
