
use std::sync::LazyLock;

use crate::modules::client_settings::variant_for_program;
use crate::modules::product::{Product, Scope};
use crate::modules::qoder::region::QoderRegion;
use crate::modules::region::Region;
use crate::modules::trae::region::{TraeProgram, TraeRegion};
use crate::modules::trae::variant::TraeVariant;

/// 命名空间与模型名之间的分隔符。
///
/// 取**第一个** `:`；词法上 `split_once(':')` 即够（本仓既有的 `model_route::split_model_prefix`
/// 用的是同一套词法）。
pub const NAMESPACE_SEPARATOR: char = ':';

pub const MAIN_TRAE_PROGRAM: TraeProgram = TraeProgram::Trae;

static TRAE_PROGRAM_NAMESPACES: [NamespaceSpec; 0] = [];

/// 命名空间要落到哪个轴（**表内显式**，不是运行时推断）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamespaceTarget {
    /// **派生层**：该命名空间就是一个作用域，程序位取该平台的主程序位。
    Scope(Scope),
    /// **扩展层**：平台内部的额外程序线（当前仅 Trae）。
    TraeProgram {
        /// 该程序线的区域（账号体系轴）。
        region: TraeRegion,
        /// 程序位（执行轴）。
        program: TraeProgram,
    },
}

/// 一条命名空间的元数据。
///
/// 全部字段都是 `&'static` / 简单枚举 ⇒ 可在 `const` 上下文中构造，
/// 从而既能放进 `static` 表，也能由 `Scope::all()` 在运行期派生。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NamespaceSpec {
    /// 对外字面量（也是模型名前缀），如 `wb-cn`。**唯一事实来源**。
    pub id: &'static str,
    /// 所属产品线。
    pub product: Product,
    /// 展示名**文案键**（不写成品文案：本表在模块加载时定型，写中文会让语言切换对它失效）。
    pub label_key: &'static str,
    /// 落到哪个轴。
    pub target: NamespaceTarget,
    /// 是否进**默认启用集**（派生层恒 `true`；扩展层恒 `false`）。
    pub default_on: bool,
}

/// 全量命名空间表（**派生层 + 扩展层**）。
///
/// 派生层由 [`Scope::all()`] 生成 ⇒ **新增平台/区域时无需改本文件**：
/// 加完 `Product` / `Scope` / `ProductSpec` 三处声明，命名空间的 id / product / 目标轴
/// 会自动出现在这里（并由 `scope_all_has_a_namespace` 用例钉住，漏了会红）。
static SPECS: LazyLock<Vec<NamespaceSpec>> = LazyLock::new(|| {
    let mut specs: Vec<NamespaceSpec> = Scope::all()
        .iter()
        .map(|scope| NamespaceSpec {
            id: scope.as_str(),
            product: scope.product(),
            label_key: scope_label_key(*scope),
            target: NamespaceTarget::Scope(*scope),
            default_on: true,
        })
        .collect();
    specs.extend(TRAE_PROGRAM_NAMESPACES.iter().copied());
    specs
});

/// 全部命名空间（顺序 = **UI 展示顺序**：派生层按 `Scope::all()`，随后扩展层）。
pub fn all_specs() -> &'static [NamespaceSpec] {
    SPECS.as_slice()
}

/// 默认启用集（= 派生层）。
pub fn default_specs() -> impl Iterator<Item = &'static NamespaceSpec> {
    all_specs().iter().filter(|spec| spec.default_on)
}

/// 解析命名空间 id —— **整段精确匹配**，未命中 `None`（fail-closed）。
///
/// 用线性查表而不是 `match`：① 表是唯一事实来源，新增项无需改函数；
/// ② 天然**不可能**出现前缀匹配（那正是本模块要防的静默走错池）。
pub fn parse(id: &str) -> Option<&'static NamespaceSpec> {
    all_specs().iter().find(|spec| spec.id == id)
}

/// 作用域 → 它对应的**派生层**命名空间（穷举，无回落：改 `Scope` 时编译失败而不是静默取错）。
pub fn spec_of_scope(scope: Scope) -> &'static NamespaceSpec {
    parse(scope.as_str()).expect("派生层命名空间恒存在于 SPECS（由 all_specs 构造保证）")
}

/// 一次模型名切分的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Split<'a> {
    /// 命中的命名空间；`None` = 模型名不带前缀。
    pub spec: Option<&'static NamespaceSpec>,
    /// 剥离前缀后的模型名。无前缀时**原样等于**入参。
    pub bare: &'a str,
}

/// 按**第一个** `:` 切分模型名的命名空间前缀（**不校验是否启用/是否授权** —— 那是配置层的事）。
///
/// 规则：
/// - 取第一个 `:`；其前段**整段精确等于**某个命名空间 id 才认（[`parse`]）⇒ 剥离；
/// - 否则视为无前缀，模型名**原样保留**（例：`vendor:model` / `gpt-5.6-sol` / 裸名）；
/// - `wb-cn:`（空前缀后段）会返回 `spec=Some, bare=""` —— **空模型名由调用方拒绝**，
///   本函数不替调用方决定错误文案。
pub fn split(model: &str) -> Split<'_> {
    match model.split_once(NAMESPACE_SEPARATOR) {
        Some((head, tail)) => match parse(head) {
            Some(spec) => Split {
                spec: Some(spec),
                bare: tail,
            },
            None => Split {
                spec: None,
                bare: model,
            },
        },
        None => Split {
            spec: None,
            bare: model,
        },
    }
}

/// 拼出对外 id（`{命名空间}:{真实模型名}`）。
pub fn compose(namespace: &str, model: &str) -> String {
    format!("{namespace}{NAMESPACE_SEPARATOR}{model}")
}

/// 「像命名空间但不在册」的启发式判定 —— 供**独立端口**给出可诊断的 400。
///
/// ## 为什么需要它
///
/// 旧端口（57891）不解析命名空间。用户若把 `wb-cn:deepseek-v4.1-flash` 填进去，
/// 模型名会被**原样转发给上游** ⇒ 用户只看到「模型不存在」，联想不到是端口用错了。
/// 本函数让旧端口能识别「这看起来是统一入口的前缀」并给出出路。
///
/// ## 判据（**保守**：宁可漏判，不误判真实模型名）
///
/// 取第一个 `:` 之前的前段 `head`，命中下列任一形状即算：
/// ① 在册命名空间 id（整段相等）；
/// ② 平台短标识本身（`wb` / `trae`）；
/// ③ `<任意>-cn` / `<任意>-global`（**未来新增平台的命名空间就是这形状**，无需改本函数）。
pub fn looks_like_namespace(model: &str) -> bool {
    let Some((head, _)) = model.split_once(NAMESPACE_SEPARATOR) else {
        return false;
    };
    if parse(head).is_some() {
        return true;
    }
    let head = head.trim();
    if head.is_empty() {
        return false;
    }
    if Product::all().iter().any(|p| p.slug() == head) {
        return true;
    }
    let lowered = head.to_ascii_lowercase();
    lowered.ends_with("-cn") || lowered.ends_with("-global")
}

/// 该命名空间的**程序位**（WorkBuddy 无此轴 ⇒ `None`）。
///
/// 两段式 Trae 命名空间（`trae-cn`）取 [`MAIN_TRAE_PROGRAM`]。
pub fn program_of(spec: &NamespaceSpec) -> Option<TraeProgram> {
    match spec.target {
        NamespaceTarget::Scope(scope) => match scope.product() {
            // WorkBuddy 只有一个程序位（桌面端），不出这一维。
            Product::Workbuddy => None,
            Product::Trae => Some(MAIN_TRAE_PROGRAM),
            // Qoder 没有 Trae 程序位这一维（它的程序位是「桌面版 / CLI」，见 `modules::qoder`）。
            Product::Qoder => None,
        },
        NamespaceTarget::TraeProgram { program, .. } => Some(program),
    }
}

/// 该命名空间的 **WorkBuddy 区域**（非 WB 命名空间 ⇒ `None`）。
pub fn wb_region_of(spec: &NamespaceSpec) -> Option<Region> {
    match spec.target {
        NamespaceTarget::Scope(scope) => scope.wb_region(),
        NamespaceTarget::TraeProgram { .. } => None,
    }
}

pub fn trae_variant_of(spec: &NamespaceSpec) -> Option<TraeVariant> {
    match spec.target {
        NamespaceTarget::Scope(scope) => scope
            .trae_region()
            .map(|region| variant_for_program(region, MAIN_TRAE_PROGRAM)),
        NamespaceTarget::TraeProgram { region, program } => {
            Some(variant_for_program(region, program))
        }
    }
}

/// 该命名空间要落到哪个中继（统一网关的分派目标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayTarget {
    /// 交给 WorkBuddy 中继（按区域选池）。
    Wb(Region),
    /// 交给 Trae 中继（按变体选池 + 决定上游 `function`）。
    Trae(TraeVariant),
    /// 交给 Qoder 中继（按区域选池）。
    Qoder(QoderRegion),
}

pub fn relay_target_of(spec: &NamespaceSpec) -> RelayTarget {
    match spec.target {
        NamespaceTarget::Scope(scope) => match scope.product() {
            Product::Workbuddy => {
                RelayTarget::Wb(scope.wb_region().expect("WB 作用域恒有 WB 区域"))
            }
            Product::Trae => {
                RelayTarget::Trae(trae_variant_of(spec).expect("Trae 作用域恒能取到变体"))
            }
            Product::Qoder => {
                RelayTarget::Qoder(scope.qoder_region().expect("Qoder 作用域恒有 Qoder 区域"))
            }
        },
        NamespaceTarget::TraeProgram { .. } => {
            RelayTarget::Trae(trae_variant_of(spec).expect("扩展层恒是 Trae 程序线"))
        }
    }
}

/// 作用域的展示名文案键（派生层用）。
fn scope_label_key(scope: Scope) -> &'static str {
    match scope {
        Scope::WbCn => "gateway.namespace.wbCn",
        Scope::WbGlobal => "gateway.namespace.wbGlobal",
        Scope::TraeCn => "gateway.namespace.traeCn",
        Scope::TraeGlobal => "gateway.namespace.traeGlobal",
        Scope::QoderCn => "gateway.namespace.qoderCn",
        Scope::QoderGlobal => "gateway.namespace.qoderGlobal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 表规模：**6 派生 + 4 扩展 = 10**。**硬编码** —— 与数据源比较会两端同源，失去回归价值。
    #[test]
    fn table_is_six_derived_with_an_empty_extension_layer() {
        assert_eq!(
            all_specs().len(),
            6,
            "命名空间总数应为 6（3 平台 × 2 区域的派生层；扩展层已清空）"
        );
        assert_eq!(
            default_specs().count(),
            6,
            "默认启用集应恰好是派生层那 6 条（新增平台后自动多出 2 条）"
        );
        assert_eq!(
            all_specs().iter().map(|spec| spec.id).collect::<Vec<_>>(),
            vec![
                "wb-cn",
                "wb-global",
                "trae-cn",
                "trae-global",
                "qoder-cn",
                "qoder-global",
            ],
            "命名空间 id 序列变更需同步更新本断言"
        );
        for retired in [
            "traework-cn",
            "traework-global",
            "traecode-cn",
            "traecode-global",
        ] {
            assert!(parse(retired).is_none(), "退役命名空间 {retired} 仍在册");
        }
    }

    #[test]
    fn qoder_namespaces_target_the_qoder_relay() {
        for (id, region) in [
            ("qoder-cn", QoderRegion::Cn),
            ("qoder-global", QoderRegion::Global),
        ] {
            let spec = parse(id).unwrap_or_else(|| panic!("{id} 应在册"));
            assert_eq!(
                relay_target_of(spec),
                RelayTarget::Qoder(region),
                "{id} 中继目标不对"
            );
            assert_eq!(spec.product, Product::Qoder);
            assert!(spec.default_on, "派生层必须默认启用");
            // Qoder 没有 Trae 的程序位轴 / 变体 / WB 区域。
            assert_eq!(program_of(spec), None);
            assert_eq!(trae_variant_of(spec), None);
            assert_eq!(wb_region_of(spec), None);
        }
    }

    #[test]
    fn scope_all_has_a_namespace() {
        for scope in Scope::all() {
            let spec = parse(scope.as_str()).unwrap_or_else(|| {
                panic!(
                    "作用域 {} 没有对应命名空间 —— 派生层应由 Scope::all() 生成",
                    scope.as_str()
                )
            });
            assert_eq!(spec.target, NamespaceTarget::Scope(scope));
            assert_eq!(spec.product, scope.product());
            assert!(spec.default_on, "派生层必须进默认启用集");
            assert_eq!(spec_of_scope(scope).id, scope.as_str());
        }
    }

    #[test]
    fn trae_namespaces_target_the_merged_program() {
        assert_eq!(
            MAIN_TRAE_PROGRAM,
            TraeProgram::Trae,
            "Trae 主程序位变了要复核 function 与清单来源"
        );
        assert_eq!(
            program_of(parse("trae-cn").unwrap()),
            Some(TraeProgram::Trae)
        );
        assert_eq!(
            program_of(parse("trae-global").unwrap()),
            Some(TraeProgram::Trae)
        );
        // 派生层的变体必须经 variant_for_program 得到合并版那两个
        assert_eq!(
            trae_variant_of(parse("trae-cn").unwrap()),
            Some(TraeVariant::TraeMerged)
        );
        assert_eq!(
            trae_variant_of(parse("trae-global").unwrap()),
            Some(TraeVariant::GlobalTraeMerged)
        );
    }

    #[test]
    fn extension_layer_is_empty_after_convergence() {
        assert!(
            TRAE_PROGRAM_NAMESPACES.is_empty(),
            "扩展层应为空：退役程序位不得再开命名空间"
        );
        for spec in all_specs() {
            assert!(
                matches!(spec.target, NamespaceTarget::Scope(_)),
                "{} 不该再是扩展层目标",
                spec.id
            );
        }
    }

    /// WorkBuddy 那条：有区域、无程序位、无 Trae 变体。
    #[test]
    fn workbuddy_namespaces_have_region_but_no_program() {
        for (id, region) in [("wb-cn", Region::Cn), ("wb-global", Region::Global)] {
            let spec = parse(id).unwrap();
            assert_eq!(wb_region_of(spec), Some(region));
            assert_eq!(
                program_of(spec),
                None,
                "WorkBuddy 只有一个程序位，不该出这一维"
            );
            assert_eq!(trae_variant_of(spec), None);
        }
    }

    #[test]
    fn namespace_ids_are_isolated_from_the_tolerant_trae_parsers() {
        // ① 变体解析器：闭合白名单 ⇒ 不认任何命名空间 id（含连字符写法）
        for spec in all_specs() {
            assert!(
                TraeVariant::parse(spec.id).is_none(),
                "命名空间 {} 被 TraeVariant::parse 解析了 —— 两层标识必须彻底隔离",
                spec.id
            );
        }
        // 反向：变体的稳定标识不得被当命名空间
        for variant in [
            "trae_work",
            "trae_cn",
            "global",
            "global_trae_code",
            "trae_merged",
            "global_trae_merged",
        ] {
            assert!(
                parse(variant).is_none(),
                "变体标识 {variant} 不应被当命名空间"
            );
        }

        // ② 程序位解析器：**会**接受，且**丢掉区域**（它是「不带区域的程序位」）—— 危害留证
        assert_eq!(
            TraeProgram::parse("traework-cn"),
            Some(TraeProgram::TraeWork),
            "危害留证：程序位解析器把 traework-cn 认成 TraeWork（区域丢失）"
        );
        assert_eq!(
            TraeProgram::parse("trae-global"),
            Some(TraeProgram::TraeCode),
            "★ 危害留证：程序位解析器把 trae-global 认成 **TraeCode**（区域与程序位双错）\
             —— 若有人用它解命名空间，请求会打到另一套账号上且不报错"
        );
        assert_eq!(
            TraeProgram::parse("traecode-global"),
            Some(TraeProgram::TraeCode),
            "危害留证：traecode-global 的区域（国际）被丢掉"
        );
    }

    /// 命名空间 id **不得与**变体稳定标识 / 程序位稳定标识字面重合（`as_str()` 级隔离）。
    ///
    /// 与上一条互补：上一条测「解析器认不认」，本条测「两个词表有没有同名字面量」。
    /// 同名字面量会让「Key 归属里写的是哪一个」变成不可推理的事。
    #[test]
    fn namespace_ids_do_not_collide_with_variant_or_program_ids() {
        let namespaces: std::collections::HashSet<&str> =
            all_specs().iter().map(|spec| spec.id).collect();
        for variant in [
            TraeVariant::TraeWork,
            TraeVariant::Trae,
            TraeVariant::Global,
            TraeVariant::GlobalTraeCode,
            TraeVariant::TraeMerged,
            TraeVariant::GlobalTraeMerged,
        ] {
            assert!(
                !namespaces.contains(variant.as_str()),
                "命名空间与变体标识同名字面量：{}",
                variant.as_str()
            );
        }
        for program in [
            TraeProgram::TraeWork,
            TraeProgram::TraeCode,
            TraeProgram::Trae,
        ] {
            assert!(
                !namespaces.contains(program.as_str()),
                "命名空间与程序位标识同名字面量：{}",
                program.as_str()
            );
        }
        for region in [TraeRegion::Cn, TraeRegion::Global] {
            assert!(
                !namespaces.contains(region.as_str()),
                "命名空间与区域标识同名字面量：{}",
                region.as_str()
            );
        }
    }

    #[test]
    fn no_namespace_id_is_a_prefix_of_another() {
        let ids: Vec<&str> = all_specs().iter().map(|spec| spec.id).collect();
        for a in &ids {
            for b in &ids {
                if a != b {
                    assert!(
                        !b.starts_with(a),
                        "{b} 以 {a} 开头 —— 一旦有人用 starts_with 实现解析就会静默走错池"
                    );
                }
            }
        }
    }

    #[test]
    fn parse_is_exact_match_fail_closed() {
        for bad in [
            // 比 id 短 / 写法不同
            "WB-CN",
            "Wb-Cn",
            "wb_cn",
            "wb",
            "trae",
            "traework",
            "trae_work",
            "cn",
            "global",
            "",
            " vendor:model",
            "wb-cn-x",
            "wb-global2",
            "trae-cnX",
            "trae-cn2",
        ] {
            assert!(parse(bad).is_none(), "{bad:?} 不该被当作命名空间");
        }
        for good in ["wb-cn", "wb-global", "trae-cn", "trae-global", "qoder-cn"] {
            assert!(parse(good).is_some(), "{good:?} 应在册");
        }
    }

    /// 切分：只取**第一个** `:`，前段不在册则整串保留。
    #[test]
    fn split_takes_only_the_first_colon_and_keeps_unknown_heads() {
        assert_eq!(
            split("wb-cn:deepseek-v4.1-flash"),
            Split {
                spec: parse("wb-cn"),
                bare: "deepseek-v4.1-flash"
            }
        );
        // 后段里还有冒号：原样保留在模型名里
        assert_eq!(
            split("trae-cn:vendor:model"),
            Split {
                spec: parse("trae-cn"),
                bare: "vendor:model"
            }
        );
        // 前段不像命名空间 ⇒ 整串保留（含后面的冒号）
        for model in [
            "vendor:model",
            "gpt-5.6-sol",
            "deepseek-v4.1-flash",
            "vendor:cn:model",
        ] {
            assert_eq!(
                split(model),
                Split {
                    spec: None,
                    bare: model
                },
                "{model} 应原样保留"
            );
        }
        // 空模型名交给调用方拒绝（本层只如实切分）
        assert_eq!(
            split("wb-cn:"),
            Split {
                spec: parse("wb-cn"),
                bare: ""
            }
        );
    }

    #[test]
    fn extension_ids_win_exactly_not_by_prefix() {
        let hit = split("trae-cn:glm-5.3");
        assert_eq!(hit.spec.map(|spec| spec.id), Some("trae-cn"));
        assert_eq!(hit.bare, "glm-5.3");
        assert!(
            split("trae-cn-x:glm-5.3").spec.is_none(),
            "前缀匹配仍必须拒绝"
        );
    }

    /// `relay_target_of`：WB → 区域，Trae → 变体。
    #[test]
    fn relay_target_covers_both_products() {
        assert_eq!(
            relay_target_of(parse("wb-cn").unwrap()),
            RelayTarget::Wb(Region::Cn)
        );
        assert_eq!(
            relay_target_of(parse("wb-global").unwrap()),
            RelayTarget::Wb(Region::Global)
        );
        assert_eq!(
            relay_target_of(parse("trae-cn").unwrap()),
            RelayTarget::Trae(TraeVariant::TraeMerged)
        );
        assert_eq!(
            relay_target_of(parse("trae-global").unwrap()),
            RelayTarget::Trae(TraeVariant::GlobalTraeMerged),
            "国际 Trae 命名空间必须落国际合并版变体"
        );
    }

    /// 拼 id。
    #[test]
    fn compose_round_trips_with_split() {
        for spec in all_specs() {
            let id = compose(spec.id, "deepseek-v4.1-flash");
            assert_eq!(id, format!("{}:deepseek-v4.1-flash", spec.id));
            let back = split(&id);
            assert_eq!(back.spec.map(|hit| hit.id), Some(spec.id));
            assert_eq!(back.bare, "deepseek-v4.1-flash");
        }
    }

    /// 「看起来像命名空间」的启发式：认得出在册 / 未来形状，且**不误判真实模型名**。
    #[test]
    fn looks_like_namespace_is_conservative() {
        // 在册 + 未来新增平台的形状（<名>-cn / <名>-global）/ 平台短标识
        for yes in [
            "wb-cn:x",
            "traework-cn:x",
            "traecode-global:x",
            "qoderwork-cn:x", // ← 未来平台：无需改本函数
            "some-new-platform-global:y",
            "wb:x",
        ] {
            assert!(looks_like_namespace(yes), "{yes} 应被认出");
        }
        // 真实模型名 / 无冒号 / 空 head
        for no in [
            "deepseek-v4.1-flash",
            "vendor:model",
            ":x",
            "gpt-5.6-sol",
            "openrouter//stealth/ox-alpha",
        ] {
            assert!(!looks_like_namespace(no), "{no} 不该被误判为命名空间");
        }
    }

    /// 每条命名空间的文案键必须**两两不同**（否则两行会显示同一个名字）。
    #[test]
    fn label_keys_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for spec in all_specs() {
            assert!(
                seen.insert(spec.label_key),
                "文案键重复：{}（{})",
                spec.label_key,
                spec.id
            );
            assert!(
                spec.label_key.starts_with("gateway.namespace."),
                "{} 的文案键命名不符既有约定",
                spec.id
            );
        }
    }

    /// 派生层 id 与作用域字面量逐字一致（前端 `SCOPES` 同源）。
    #[test]
    fn derived_ids_equal_scope_literals() {
        for scope in Scope::all() {
            assert_eq!(
                spec_of_scope(scope).id,
                scope.as_str(),
                "派生层 id 必须与作用域字面量逐字一致（前端 SCOPES 同源）"
            );
        }
    }
}
