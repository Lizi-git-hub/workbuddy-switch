
use super::variant::{variant_spec, EndpointSet, TraeVariant};

/// 账号体系所在区域。
///
/// 它是**持久化轴**：账号库文件后缀、登录态快照目录、设备标识、冷却账本、
/// 以及全部联网端点都由它决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TraeRegion {
    /// 国内版（`api.trae.cn` / `api.trae.com.cn`，账号体系与国内主体一致）。
    Cn,
    /// 国际版（客户端 `packageType = SOLO_I18N`，发布者 SPRING (SG) PTE. LTD）。
    Global,
}

impl TraeRegion {
    /// 稳定标识（文件名后缀、序列化、前端传参）。
    pub fn as_str(self) -> &'static str {
        match self {
            TraeRegion::Cn => "cn",
            TraeRegion::Global => "global",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            TraeRegion::Cn => "Trae CN",
            TraeRegion::Global => "Trae",
        }
    }

    pub fn parse(s: &str) -> Option<TraeRegion> {
        match s.trim().to_ascii_lowercase().as_str() {
            "cn" | "china" | "domestic" | "trae_work" | "trae_cn" | "traework" | "trae" => {
                Some(TraeRegion::Cn)
            }
            "global" | "intl" | "international" | "sg" | "ai" => Some(TraeRegion::Global),
            _ => None,
        }
    }

    /// 全部区域（遍历用，顺序稳定）。
    pub fn all() -> [TraeRegion; 2] {
        [TraeRegion::Cn, TraeRegion::Global]
    }
}

impl Default for TraeRegion {
    fn default() -> Self {
        TraeRegion::Cn
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraeProgram {
    TraeWork,
    TraeCode,
    Trae,
}

impl TraeProgram {
    /// 稳定标识。
    pub fn as_str(self) -> &'static str {
        match self {
            TraeProgram::TraeWork => "trae_work",
            TraeProgram::TraeCode => "trae_code",
            TraeProgram::Trae => "trae",
        }
    }

    /// 从字符串解析程序线（宽容，接受客户端 exe / 目录名的常见写法）。
    pub fn parse(s: &str) -> Option<TraeProgram> {
        let lowered = s.trim().to_ascii_lowercase();
        let lowered = lowered.strip_suffix(".exe").unwrap_or(&lowered);
        if lowered.contains("solo") || lowered.contains("work") {
            return Some(TraeProgram::TraeWork);
        }
        if lowered.contains("code") {
            return Some(TraeProgram::TraeCode);
        }
        // 裸 `trae`（含 `trae cn` / `trae cn.exe`）＝ 合并后的客户端。
        // 客户端自己的目录名/ exe 名就是这个，故它是最常见的输入。
        if lowered == "trae" || lowered == "trae cn" {
            return Some(TraeProgram::Trae);
        }
        // 其余含 `trae` 的历史写法（`trae_cn` / `global_trae_code` 已在上面的
        // `code` 分支处理）一律落遗留 TraeCode，**不猜**成合并版。
        if lowered.contains("trae") {
            return Some(TraeProgram::TraeCode);
        }
        None
    }

    pub fn all() -> [TraeProgram; 1] {
        [TraeProgram::Trae]
    }
}

/// 一个**程序位**（区域 × 程序）的全部差异。
#[derive(Debug, Clone, Copy)]
pub struct ProgramSpec {
    /// 所属区域。
    pub region: TraeRegion,
    /// 所属程序线。
    pub program: TraeProgram,
    /// 界面展示名（**国内版带 ` CN` 后缀、国际版不带后缀**），见模块头「展示名」。
    pub display_name: &'static str,
    /// 客户端 `product.json` 的 `nameAlias`（官方自称，用于诊断与核对）。
    pub name_alias: &'static str,
    /// 客户端 `product.json` 的 `packageType`；未知时为 `None`（**不猜**）。
    pub package_type: Option<&'static str>,
    /// userData 目录名候选（`%APPDATA%\<名字>`）。**精确匹配，不做包含匹配**。
    pub data_dir_names: &'static [&'static str],
    /// 可执行文件名候选（精确匹配）。
    pub exe_names: &'static [&'static str],
    /// 进程名候选（Windows 精简名，不带 `.exe`）。
    pub proc_names: &'static [&'static str],
}

const CN_TRAE: ProgramSpec = ProgramSpec {
    region: TraeRegion::Cn,
    program: TraeProgram::Trae,
    display_name: "Trae CN",
    name_alias: "TraeCode CN",
    package_type: Some("TRAE_CN"),
    data_dir_names: &["Trae CN"],
    exe_names: &["Trae CN.exe"],
    proc_names: &["Trae CN"],
};

const GLOBAL_TRAE: ProgramSpec = ProgramSpec {
    region: TraeRegion::Global,
    program: TraeProgram::Trae,
    display_name: "Trae",
    name_alias: "TraeCode（待实测）",
    package_type: None,
    data_dir_names: &["Trae"],
    exe_names: &["Trae.exe"],
    proc_names: &["Trae"],
};

pub fn all_program_specs() -> [&'static ProgramSpec; 2] {
    [&CN_TRAE, &GLOBAL_TRAE]
}

pub fn program_spec(region: TraeRegion, program: TraeProgram) -> &'static ProgramSpec {
    let _ = program;
    match region {
        TraeRegion::Cn => &CN_TRAE,
        TraeRegion::Global => &GLOBAL_TRAE,
    }
}

pub fn programs_of(region: TraeRegion) -> [&'static ProgramSpec; 1] {
    match region {
        TraeRegion::Cn => [&CN_TRAE],
        TraeRegion::Global => [&GLOBAL_TRAE],
    }
}

pub fn region_endpoints(region: TraeRegion) -> &'static EndpointSet {
    let spec = variant_spec(TraeVariant::TraeMerged);
    match region {
        TraeRegion::Cn => &spec.cn_endpoints,
        TraeRegion::Global => spec
            .global_endpoints
            .as_ref()
            .expect("国际版端点必须在表里登记（见 variant 模块的国际化端点单测）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 区域标识与展示名稳定() {
        assert_eq!(TraeRegion::Cn.as_str(), "cn");
        assert_eq!(TraeRegion::Global.as_str(), "global");
        // ⚠️ 区域名 = **客户端自己的产品名**（用户 2026-10-13 定），
        // 与 `shared.region.version.*`（跨平台区域**词**）分工不同，见 `display_name` 的说明。
        // 反例（改坏会红）：退回「国内版 / 国际版」⇒ 前端 Trae 侧的区域名会与后端漂开。
        assert_eq!(TraeRegion::Cn.display_name(), "Trae CN");
        assert_eq!(TraeRegion::Global.display_name(), "Trae");
        assert_eq!(TraeRegion::default(), TraeRegion::Cn);
    }

    #[test]
    fn 历史产品线标识一律解析为国内版() {
        for s in ["trae_work", "trae_cn", "CN", "trae", "cn"] {
            assert_eq!(TraeRegion::parse(s), Some(TraeRegion::Cn), "解析失败: {s}");
        }
        for s in ["global", "intl", "international", "SG"] {
            assert_eq!(
                TraeRegion::parse(s),
                Some(TraeRegion::Global),
                "解析失败: {s}"
            );
        }
        assert_eq!(TraeRegion::parse("doubao"), None);
    }

    #[test]
    fn 程序线解析接受客户端命名() {
        assert_eq!(
            TraeProgram::parse("TRAE SOLO CN.exe"),
            Some(TraeProgram::TraeWork)
        );
        assert_eq!(TraeProgram::parse("solo"), Some(TraeProgram::TraeWork));
        assert_eq!(TraeProgram::parse("trae_work"), Some(TraeProgram::TraeWork));
        assert_eq!(TraeProgram::parse("Trae CN.exe"), Some(TraeProgram::Trae));
        assert_eq!(TraeProgram::parse("trae_code"), Some(TraeProgram::TraeCode));
        assert_eq!(TraeProgram::parse("doubao"), None);
    }

    #[test]
    fn 裸名trae解析为合并版而trae_code仍是遗留() {
        for s in ["trae", "Trae", "TRAE", "trae cn", "Trae CN", "Trae CN.exe"] {
            assert_eq!(
                TraeProgram::parse(s),
                Some(TraeProgram::Trae),
                "解析失败: {s}"
            );
        }
        for s in [
            "trae_code",
            "trae_code_global",
            "global_trae_code",
            "trae_cn",
            "traecode",
        ] {
            assert_eq!(
                TraeProgram::parse(s),
                Some(TraeProgram::TraeCode),
                "遗留标识必须落 TraeCode，不能被裸名规则抢走: {s}"
            );
        }
        // 退役标识仍能被 `parse` 认出（老数据解码）；**唯一可选**程序位的标识往返自洽。
        for program in TraeProgram::all() {
            assert_eq!(TraeProgram::parse(program.as_str()), Some(program));
        }
    }

    #[test]
    fn 程序位展示名符合约定() {
        use TraeProgram::{Trae, TraeCode, TraeWork};
        use TraeRegion::{Cn, Global};
        assert_eq!(program_spec(Cn, Trae).display_name, "Trae CN");
        assert_eq!(program_spec(Global, Trae).display_name, "Trae");
        assert_eq!(program_spec(Cn, TraeWork).display_name, "Trae CN");
        assert_eq!(program_spec(Cn, TraeCode).display_name, "Trae CN");
        assert_eq!(program_spec(Global, TraeWork).display_name, "Trae");
        assert_eq!(program_spec(Global, TraeCode).display_name, "Trae");
    }

    #[test]
    fn 合并版候选名与用户确认的写法逐字一致() {
        use TraeProgram::Trae;
        use TraeRegion::{Cn, Global};
        for (region, dir_name, exe_name) in
            [(Cn, "Trae CN", "Trae CN.exe"), (Global, "Trae", "Trae.exe")]
        {
            let spec = program_spec(region, Trae);
            assert_eq!(
                spec.data_dir_names.to_vec(),
                vec![dir_name],
                "{region:?} 合并版的 userData 名漂了（用户确认的是 `{dir_name}`）"
            );
            assert_eq!(
                spec.exe_names.to_vec(),
                vec![exe_name],
                "{region:?} 合并版的 exe 名漂了（用户确认的是 `{exe_name}`）"
            );
            assert_eq!(
                spec.proc_names.to_vec(),
                vec![dir_name],
                "{region:?} 合并版的进程名漂了"
            );
        }
    }

    #[test]
    fn 每区域恰好一个程序位且是合并版() {
        let specs = all_program_specs();
        assert_eq!(
            specs.len(),
            2,
            "前置：应恰有 2 条可选程序位（2 区域 × 1），否则本用例会恒真"
        );
        // 逐区域：恰好一条，且 `program` 是合并版、`region` 归属正确。
        for region in TraeRegion::all() {
            let of_region = programs_of(region);
            assert_eq!(
                of_region.len(),
                1,
                "{region:?} 应恰有 1 条程序位（收敛后遗留程序位已退役）"
            );
            assert_eq!(
                of_region[0].program,
                TraeProgram::Trae,
                "{region:?} 的唯一程序位必须是合并版"
            );
            assert_eq!(of_region[0].region, region, "{region:?} 的程序位归属漂了");
            assert!(
                specs
                    .iter()
                    .any(|s| s.region == region && s.program == TraeProgram::Trae),
                "{region:?} 的合并版程序位不在全量表里"
            );
        }
        // 两个区域**不能**共用候选名（差一个 ` CN` 后缀也算不同）。
        let cn = program_spec(TraeRegion::Cn, TraeProgram::Trae);
        let global = program_spec(TraeRegion::Global, TraeProgram::Trae);
        assert_ne!(cn.data_dir_names, global.data_dir_names);
        assert_ne!(cn.exe_names, global.exe_names);
        assert_ne!(cn.display_name, global.display_name);
    }

    #[test]
    fn 遗留程序位退役但仍可解码() {
        let selectable = TraeProgram::all();
        assert_eq!(selectable.len(), 1, "可选程序位应只剩合并版一条");
        assert_eq!(selectable[0], TraeProgram::Trae);
        for retired in [TraeProgram::TraeWork, TraeProgram::TraeCode] {
            assert!(
                !selectable.contains(&retired),
                "{retired:?} 是退役程序位，不得出现在可选列表里"
            );
            // 退役 ≠ 认不出来：历史写法仍要能解析（迁移来源 / 老日志解码）。
            assert_eq!(
                TraeProgram::parse(retired.as_str()),
                Some(retired),
                "{retired:?} 的落盘标识必须仍能往返（老数据要能解码）"
            );
        }
        // `as_str` 往返对**全部**取值成立（含退役值）。
        for program in [
            TraeProgram::Trae,
            TraeProgram::TraeWork,
            TraeProgram::TraeCode,
        ] {
            assert_eq!(TraeProgram::parse(program.as_str()), Some(program));
        }
    }

    #[test]
    fn 两个区域程序位候选名互不重叠() {
        let specs = all_program_specs();
        let mut overlaps: Vec<String> = Vec::new();
        for (i, a) in specs.iter().enumerate() {
            for b in specs.iter().skip(i + 1) {
                for (kind, left, right) in [
                    ("userData 目录名", a.data_dir_names, b.data_dir_names),
                    ("exe 名", a.exe_names, b.exe_names),
                    ("进程名", a.proc_names, b.proc_names),
                ] {
                    for name in left {
                        if right.contains(name) {
                            overlaps.push(format!(
                                "{kind}:{name}:{:?}/{:?}:{:?}/{:?}",
                                a.region, a.program, b.region, b.program
                            ));
                        }
                    }
                }
            }
        }
        assert!(
            overlaps.is_empty(),
            "两个区域的程序位候选名不得重叠（会互相抢）：{overlaps:?}"
        );
        // 前置：确实比对了对象，否则本用例恒真。
        assert_eq!(specs.len(), 2);
    }

    /// `programs_of` 必须给出该区域的**唯一**程序位（合并版），且它归属本区域。
    #[test]
    fn 按区域取程序位() {
        for region in TraeRegion::all() {
            let got = programs_of(region);
            assert_eq!(got.len(), 1, "每个区域应恰有 1 条程序位（合并版 Trae）");
            for spec in got {
                assert_eq!(spec.region, region, "程序位归属漂了: {:?}", spec.program);
            }
            assert_eq!(got[0].program, TraeProgram::Trae);
        }
    }

    #[test]
    fn 区域端点取自既有端点表() {
        let cn = region_endpoints(TraeRegion::Cn);
        assert_eq!(cn.account_base, "https://api.trae.cn");
        assert_eq!(cn.icube_base, "https://api.trae.com.cn");

        let global = region_endpoints(TraeRegion::Global);
        assert_eq!(global.account_base, "https://grow-normal.trae.ai");
        assert_eq!(global.icube_base, "https://icube-normal.trae.ai");
        assert_ne!(global.account_base, cn.account_base);

        // 授权页域（`bootConfig.consoleHost`）同样按区域分家 —— 它不是 API 域，
        // 但漏了分家的后果更隐蔽：国际版用户在**国内**授权页上登录，
        // 页面走完也不回调，症状与「回调端口没监听」几乎一样。
        assert_eq!(cn.console_base, "https://www.trae.cn");
        assert_eq!(global.console_base, "https://www.trae.ai");
        assert_ne!(global.console_base, cn.console_base);
    }
}
