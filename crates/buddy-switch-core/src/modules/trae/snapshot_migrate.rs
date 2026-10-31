
use serde_json::{json, Value};

use super::paths;
use super::profile;
use super::region::{TraeProgram, TraeRegion};
use super::store;

/// 槽位根下**不是账号快照**的保留名 —— 搬运时必须跳过。
///
/// - `current_account.txt`：本应用自己的记账（「当前登录的是谁」），**文件**不是目录；
/// - `last`：切换前的现场快照（回滚用），是**目录**，所以只靠 `is_dir()` 挡不住它。
const RESERVED_SLOT_NAMES: &[&str] = &["last", "current_account.txt"];

/// 一次「历史池 → 合并池」的搬运明细。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotCarry {
    /// 所属区域。
    pub region: TraeRegion,
    /// 来源历史池目录名（如 `profiles` / `profiles_trae_cn`）。
    pub from: String,
    /// 账号槽位名（userId）。
    pub slot: String,
    /// 本次复制的文件数。
    pub files: u64,
}

/// 搬运结果（报告形态，前端/日志直接可读）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotCarryReport {
    /// 实际搬运的记录（逐账号）。
    pub carries: Vec<SnapshotCarry>,
    /// 因目标槽位已有同 uid 而**跳过**（只增不改）的账号数。
    pub slots_kept: usize,
    /// 逐个槽位的失败原因（`"<槽位>（<原因>）"`）。非空即「有东西没搬成」。
    pub errors: Vec<String>,
    /// 诊断备注（搬了什么 / 为什么没搬）。同时是**升级引导**的文案来源。
    pub notes: Vec<String>,
    /// 本次是**首次**执行收敛迁移 —— 升级引导只该弹一次，判据就是它。
    pub first_run: bool,
}

impl SnapshotCarryReport {
    /// 本次是否真的搬了东西（`false` = 幂等空转）。
    ///
    /// ⚠️ **注意它不是「引导该不该弹」的判据**：首次运行即使一个快照都没有（全新安装），
    /// 用户也该看到「Trae 已合并、旧程序位已退役」这条说明。判据是 [`Self::first_run`]。
    pub fn changed(&self) -> bool {
        !self.carries.is_empty()
    }

    /// 复制的文件总数。
    pub fn files_copied(&self) -> u64 {
        self.carries.iter().map(|c| c.files).sum()
    }

    /// 线上形态（camelCase，与其余 Trae 报告同形）。
    pub fn to_json(&self) -> Value {
        json!({
            "slotsCopied": self.carries.len(),
            "slotsKept": self.slots_kept,
            "filesCopied": self.files_copied(),
            "carried": self
                .carries
                .iter()
                .map(|c| json!({
                    "region": c.region.as_str(),
                    "from": c.from,
                    "slot": c.slot,
                    "files": c.files,
                }))
                .collect::<Vec<_>>(),
            "errors": self.errors,
            "notes": self.notes,
            "changed": self.changed(),
            "firstRun": self.first_run,
        })
    }
}

/// 把**历史快照池**的账号槽位搬进对应区域的**合并池**（幂等、只增不改、只复制）。
///
/// 逐区域：目标取该区域的合并池（[`client_settings::variant_for_program`]），
/// 源取 [`paths::LEGACY_PROFILE_DIRS`] 里属于该区域的**全部**历史池名。
///
/// **不返回 `Result`**：本操作是尽力而为的附属迁移，单个槽位复制失败不该让整次
/// 「遗留迁移」（含账号库合并）报错 —— 但失败必须**可见**，落在
/// [`SnapshotCarryReport::errors`] 里（调用方回传给前端并写日志）。
pub fn carry_merged_snapshots() -> SnapshotCarryReport {
    let mut report = SnapshotCarryReport {
        first_run: claim_first_run(),
        ..Default::default()
    };

    for region in TraeRegion::all() {
        let target_program = TraeProgram::Trae;
        let target_root = paths::profiles_dir_for_program(region, target_program);
        let mut carried_here = 0usize;

        for (legacy_name, legacy_region) in paths::LEGACY_PROFILE_DIRS {
            if *legacy_region != region {
                continue;
            }
            let source_root = paths::trae_dir().join(legacy_name);
            // 「源池里有没有东西」由 `read_dir` 是否产出条目决定。⚠️ **不能**用
            // `is_dir()` 当「源池存在」的判据：`profiles_dir_for_program` 内部
            // `create_dir_all`，而本函数刻意**不**走它去造历史目录（那会让
            // 「已迁移」与「从未有过存量」在磁盘上长得一样）。
            let entries = match std::fs::read_dir(&source_root) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    report.errors.push(format!(
                        "读取历史池 {} 失败（{error}）",
                        source_root.display()
                    ));
                    continue;
                }
            };
            if entries.count() == 0 {
                continue;
            }
            let entries = match std::fs::read_dir(&source_root) {
                Ok(entries) => entries,
                Err(error) => {
                    report.errors.push(format!(
                        "读取历史池 {} 失败（{error}）",
                        source_root.display()
                    ));
                    continue;
                }
            };

            for entry in entries.flatten() {
                let slot = entry.file_name().to_string_lossy().to_string();
                // 跳过保留名与非法名（见 `RESERVED_SLOT_NAMES` / `paths::safe_slot_name`）。
                if RESERVED_SLOT_NAMES.contains(&slot.as_str()) || !paths::safe_slot_name(&slot) {
                    continue;
                }
                let from = entry.path();
                // 只搬**目录**：历史池根下除保留名外可能还有零散文件，
                // 它们不是快照，搬过去只会让目标池多出无法识别的条目。
                if !from.is_dir() {
                    continue;
                }
                let to = target_root.join(&slot);
                if to.exists() {
                    report.slots_kept += 1;
                    continue;
                }
                match profile::copy_dir_recursive(&from, &to) {
                    Ok(files) => {
                        carried_here += 1;
                        report.carries.push(SnapshotCarry {
                            region,
                            from: (*legacy_name).to_string(),
                            slot,
                            files,
                        });
                    }
                    Err(error) => report.errors.push(format!("{slot}（{error}）")),
                }
            }
        }

        if carried_here > 0 {
            report.notes.push(format!(
                "{}：已把 {carried_here} 个账号的登录态快照搬进合并版客户端的槽位",
                region.as_str()
            ));
            store::append_log(
                &paths::log_file_for_region(region, "switcher.log"),
                &format!(
                    "客户端合并收敛：{region:?} 的历史快照池 -> 合并池，\
                     复制 {carried_here} 个账号槽位"
                ),
            );
        }
    }

    report
}

/// 首次执行收敛迁移的**一次性标记**（引导只弹一次）。
///
/// ## 为什么必须落盘
///
/// 引导挂在「账号页挂载时调一次 `merge_legacy_regions`」这条链上，而那条链
/// **每次进账号页都会跑**。不落标记 ⇒ 用户每次进页面都被弹一遍升级引导。
///
/// 标记写在 `trae/` 目录下（与账号库同根），内容为空对象即可 —— 它是**幂等闸门**，
/// 不是数据。写失败按「未首次」处理（宁可少弹一次，也别反复打扰）。
fn claim_first_run() -> bool {
    let marker = paths::trae_dir().join("merge_adapted.json");
    if marker.exists() {
        return false;
    }
    match store::atomic_write_text(&marker, "{}") {
        Ok(()) => true,
        Err(_) => false,
    }
}

/// ## 为什么测试是 Windows-only
///
/// 与仓库既有约定一致：依赖「客户端 userData 目录」的用例一律 `#[cfg(windows)]`
/// （`test_support::TempEnv::empty()` 本身也只在 Windows 上提供）。
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 铺一个历史池里的账号快照。
    fn seed(pool: &str, slot: &str, file: &str) {
        let dir = paths::trae_dir().join(pool).join(slot);
        std::fs::create_dir_all(&dir).expect("历史快照目录应能创建");
        std::fs::write(dir.join(file), b"x").expect("快照文件应能写入");
    }

    fn merged_slot_exists(region: TraeRegion, slot: &str) -> bool {
        paths::profiles_dir_for_program(region, TraeProgram::Trae)
            .join(slot)
            .is_dir()
    }

    #[test]
    fn 四个历史池的快照都搬进合并池() {
        let _env = crate::modules::trae::test_support::TempEnv::empty();
        seed("profiles", "u-cn-work", "Preferences");
        seed("profiles_trae_cn", "u-cn-code", "Preferences");
        seed("profiles_global", "u-gl-work", "Preferences");
        seed("profiles_global_trae_code", "u-gl-code", "Preferences");

        let report = carry_merged_snapshots();

        assert!(report.errors.is_empty(), "不应有失败：{:?}", report.errors);
        assert_eq!(
            report.carries.len(),
            4,
            "四个历史池的快照都该被搬：{report:?}"
        );
        for slot in ["u-cn-work", "u-cn-code"] {
            assert!(
                merged_slot_exists(TraeRegion::Cn, slot),
                "CN 合并池里应出现 {slot}"
            );
        }
        for slot in ["u-gl-work", "u-gl-code"] {
            assert!(
                merged_slot_exists(TraeRegion::Global, slot),
                "国际合并池里应出现 {slot}"
            );
        }
        // 来源要在报告里**逐条标对**，否则日志与引导会说错来源。
        let mut froms: Vec<String> = report.carries.iter().map(|c| c.from.clone()).collect();
        froms.sort();
        assert_eq!(
            froms,
            vec![
                "profiles".to_string(),
                "profiles_global".to_string(),
                "profiles_global_trae_code".to_string(),
                "profiles_trae_cn".to_string(),
            ]
        );
    }

    #[test]
    fn 不依赖客户端合并记录也照搬() {
        let _env = crate::modules::trae::test_support::TempEnv::empty();
        // 连客户端 userData 目录都不建 —— 前任实现正是拿它当门控。
        seed("profiles", "u1", "Preferences");

        let report = carry_merged_snapshots();

        assert!(
            report.changed(),
            "不该再依赖 migration-job.json：{report:?}"
        );
        assert!(merged_slot_exists(TraeRegion::Cn, "u1"));
    }

    #[test]
    fn 只复制不动源() {
        let _env = crate::modules::trae::test_support::TempEnv::empty();
        seed("profiles", "u1", "Preferences");

        carry_merged_snapshots();

        assert!(
            paths::trae_dir().join("profiles").join("u1").is_dir(),
            "源槽位必须原样保留"
        );
    }

    #[test]
    fn 保留名不被当成账号搬走() {
        let _env = crate::modules::trae::test_support::TempEnv::empty();
        seed("profiles", "last", "Preferences");
        seed("profiles", "u1", "Preferences");

        let report = carry_merged_snapshots();

        assert!(
            !report.carries.iter().any(|c| c.slot == "last"),
            "`last` 是保留名，绝不能当成账号搬过去：{report:?}"
        );
        assert!(
            !merged_slot_exists(TraeRegion::Cn, "last"),
            "合并池里不该出现 `last`"
        );
    }

    #[test]
    fn 零散文件不搬() {
        let _env = crate::modules::trae::test_support::TempEnv::empty();
        std::fs::create_dir_all(paths::trae_dir().join("profiles")).expect("历史池应能创建");
        std::fs::write(paths::trae_dir().join("profiles").join("stray.txt"), b"x")
            .expect("零散文件应能写入");
        seed("profiles", "u1", "Preferences");

        let report = carry_merged_snapshots();

        assert_eq!(report.carries.len(), 1, "只该搬那一个账号目录：{report:?}");
    }

    #[test]
    fn 幂等且目标已有同uid时只增不改() {
        let _env = crate::modules::trae::test_support::TempEnv::empty();
        seed("profiles", "u1", "Preferences");
        // 合并池里**已经**有一份（内容不同）—— 必须原封不动。
        let existing = paths::profiles_dir_for_program(TraeRegion::Cn, TraeProgram::Trae)
            .join("u1")
            .join("Local State");
        std::fs::create_dir_all(existing.parent().expect("父目录应存在"))
            .expect("合并槽位应能创建");
        std::fs::write(&existing, b"x").expect("文件应能写入");

        let first = carry_merged_snapshots();
        assert!(!first.changed(), "目标已有同 uid ⇒ 本次不该搬任何东西");
        assert_eq!(first.slots_kept, 1, "应记一次「跳过」：{first:?}");
        assert!(
            existing.is_file()
                && !existing
                    .parent()
                    .expect("父目录应存在")
                    .join("Preferences")
                    .exists(),
            "合并池原有内容必须原样保留（只增不改）"
        );

        // 新增一个：第一次搬进去，之后必须完全空转。
        seed("profiles", "u2", "Preferences");
        let second = carry_merged_snapshots();
        assert_eq!(second.carries.len(), 1, "第二次应只搬新增那个：{second:?}");
        let third = carry_merged_snapshots();
        assert!(!third.changed(), "第三次必须完全空转：{third:?}");
    }

    #[test]
    fn 首次标记只报一次() {
        let _env = crate::modules::trae::test_support::TempEnv::empty();
        assert!(carry_merged_snapshots().first_run, "首次必须为真");
        assert!(!carry_merged_snapshots().first_run, "第二次必须为假");
    }

    /// 报告形态必须是 camelCase 且字段齐全（线上契约）。
    #[test]
    fn 报告形态字段齐全且不泄漏snake_case() {
        let _env = crate::modules::trae::test_support::TempEnv::empty();
        seed("profiles", "u1", "Preferences");

        let value = carry_merged_snapshots().to_json();
        for key in [
            "slotsCopied",
            "slotsKept",
            "filesCopied",
            "carried",
            "errors",
            "notes",
            "changed",
            "firstRun",
        ] {
            assert!(value.get(key).is_some(), "报告缺少字段 {key}");
        }
        assert!(value.get("slots_copied").is_none(), "不得泄漏 snake_case");
        assert_eq!(value.get("changed").and_then(Value::as_bool), Some(true));
        assert_eq!(value.get("slotsCopied").and_then(Value::as_u64), Some(1));
        let carried = value
            .get("carried")
            .and_then(Value::as_array)
            .expect("carried 应是数组");
        for key in ["region", "from", "slot", "files"] {
            assert!(carried[0].get(key).is_some(), "搬运条目缺少字段 {key}");
        }
        assert_eq!(
            carried[0].get("from").and_then(Value::as_str),
            Some("profiles")
        );
    }

    /// 历史池目录名表必须覆盖收敛前的**全部**目录形态（含那两条分叉）。
    #[test]
    fn 历史池目录名表覆盖全部区域() {
        let names: Vec<&str> = paths::LEGACY_PROFILE_DIRS
            .iter()
            .map(|(name, _)| *name)
            .collect();
        for expected in [
            "profiles",
            "profiles_trae_cn",
            "profiles_global",
            "profiles_global_trae_work",
            "profiles_global_trae_code",
        ] {
            assert!(
                names.contains(&expected),
                "历史池表漏了 `{expected}`：{names:?}"
            );
        }
        for region in TraeRegion::all() {
            assert!(
                paths::LEGACY_PROFILE_DIRS
                    .iter()
                    .any(|(_, owner)| *owner == region),
                "{region:?} 没有任何历史池可搬 —— 那要么是漏登记，要么是纯新建机器（都不该靠这张表推断）"
            );
        }
    }
}
