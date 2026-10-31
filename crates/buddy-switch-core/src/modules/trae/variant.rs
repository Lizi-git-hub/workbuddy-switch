
use std::path::PathBuf;

/// Trae 产品线变体。
///
/// 命名依据是客户端 `product.json` 的 `nameAlias`：`TRAE SOLO CN` 自称 `TraeWork CN`，
/// `Trae CN` 自称 `TraeCode CN`。对外展示用 [`TraeVariant::display_name`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TraeVariant {
    /// Trae Work 产品线（对应客户端的 `TRAE SOLO` / `TRAE SOLO CN`）。
    ///
    /// ⚠️ 持久化轴翻到区域之后（2026-09-21），本取值在**读写数据**时表示「**国内区域**」
    /// （见 [`TraeVariant::region`]）：`TraeWork` 与 `Trae` 共用国内库，
    /// 差别只在**程序**维度（启动哪个客户端、快照落哪个目录）。
    TraeWork,
    /// Trae IDE 产品线（客户端 `product.json`：`nameShort = Trae CN`、`nameAlias = TraeCode CN`）。
    ///
    /// 语义同 `TraeWork`：**数据层面＝国内区域**，差别只在程序维度。
    Trae,
    /// **国际版区域**（客户端 `packageType = SOLO_I18N`，发布者 SPRING (SG) PTE. LTD）。
    ///
    /// 在持久化轴翻到区域之后新增：它让「区域之间互不污染」这条**真契约**继续可表达
    /// （此前那批断言用的是两个国内产品线，而它们现在共用一本库，断言前提已消失）。
    ///
    /// **刻意暂不列入 [`TraeVariant::all`]**：`all()` 是「两条国内程序位」的旧入口
    /// （见该函数的说明），而本取值属于国际区域。
    Global,
    #[serde(rename = "global_trae_code")]
    GlobalTraeCode,
    TraeMerged,
    #[serde(rename = "global_trae_merged")]
    GlobalTraeMerged,
}

impl TraeVariant {
    /// 稳定标识（用于文件名、序列化与前端传参）。
    ///
    /// ## `Trae` 的字符串**仍是 `trae_cn`**（刻意不改，别"顺手修"）
    ///
    /// 它已经写进用户的磁盘与既有集成：
    ///
    /// - `api_gateway_keys.json` 里每条 Key 的归属；
    /// - 网关请求日志的 `variant` 字段（Token 统计按它分档）；
    /// - 快照目录名 `profiles_trae_cn`（见 `paths::profiles_dir_for`）。
    ///
    /// 改这个字符串等于**断老数据**，而它本身只是个键名。所以本次只把**标识符**
    /// 正名为 `Trae`（与官方 `nameShort` 一致），字符串保持原样；`parse` 同时接受
    /// `trae_cn` 与 `trae`，两侧都可读。
    pub fn as_str(self) -> &'static str {
        match self {
            TraeVariant::TraeWork => "trae_work",
            TraeVariant::Trae => "trae_cn",
            TraeVariant::Global => "global",
            // 与 [`paths::profiles_dir_for`] 的 `profiles_<as_str>` 规则合成
            // `profiles_global_trae_code` —— 与 `paths::profiles_dir_for_program`
            // 给 `(Global, TraeCode)` 的名字**逐字相同**（有单测钉住）。
            TraeVariant::GlobalTraeCode => "global_trae_code",
            TraeVariant::TraeMerged => "trae_merged",
            TraeVariant::GlobalTraeMerged => "global_trae_merged",
        }
    }

    /// 本取值对应的**持久化区域**（账号库/签到/积分/冷却/日志按它分家）。
    ///
    /// `TraeWork` 与 `Trae` **都是国内区域** —— 持久化轴翻到区域后，
    /// 二者的差别只剩**程序**维度（启动哪个客户端、快照落哪个目录）。
    pub fn region(self) -> super::region::TraeRegion {
        match self {
            TraeVariant::TraeWork | TraeVariant::Trae => super::region::TraeRegion::Cn,
            TraeVariant::Global | TraeVariant::GlobalTraeCode => super::region::TraeRegion::Global,
            // 合并版与它取代的那条遗留线同区域：CN 合并版落国内，国际合并版落国际。
            TraeVariant::TraeMerged => super::region::TraeRegion::Cn,
            TraeVariant::GlobalTraeMerged => super::region::TraeRegion::Global,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            TraeVariant::TraeWork => "TraeWork CN",
            // 本取值代表**遗留** TraeCode 程序位（`TraeMerged` 才是合并版）。
            TraeVariant::Trae => "TraeCode CN",
            TraeVariant::Global => "TraeWork",
            TraeVariant::GlobalTraeCode => "TraeCode",
            TraeVariant::TraeMerged => "Trae CN",
            TraeVariant::GlobalTraeMerged => "Trae",
        }
    }

    /// 从字符串解析变体。大小写不敏感，接受若干常见别名。
    ///
    /// 接受 `TRAE SOLO CN` / `TRAE SOLO` 这类**目录名**，因为用户可能直接从
    /// 探测结果（`TraeEnvStatus.dataDir` 的末段）把产品名传回来。
    pub fn parse(s: &str) -> Option<TraeVariant> {
        match s.trim().to_ascii_lowercase().as_str() {
            "trae_work" | "traework" | "trae work" | "work" | "solo" | "trae solo"
            | "trae solo cn" => Some(TraeVariant::TraeWork),
            // `cn` 是**区域标识**（国内版）⇒ 必须落到该区域的**主程序**（TraeWork）。
            // 它曾作为 Trae 的宽容别名；但区域标识指向主程序才安全 ——
            // 否则「保存登录态」这类**程序级**操作会去读 TraeCode 客户端的 userData。
            "cn" => Some(TraeVariant::TraeWork),
            // `trae_code` 是前端的**程序位**标识（`TraeProgramId`），不带区域。
            // 收它并落**国内** TraeCode：这是唯一「不猜区域」的方向 ——
            // 国内 TraeCode 是既有程序位，而国际版 TraeCode 另有专属标识
            // `global_trae_code`（见下）。落成国际版才会把国内用户的登录态写错客户端。
            "trae_cn" | "traecn" | "trae cn" | "ide" | "trae" | "trae_code" | "traecode" => {
                Some(TraeVariant::Trae)
            }
            // 国际版区域。**不放宽成 `global`/`intl` 之外的词**：区域标识是要落到
            // 文件名与落盘数据上的，认得太宽会让一个拼错的参数静默读到另一套账号库
            // （症状是"账号凭空消失"，极难定位）。
            "global" | "trae_global" | "intl" | "international" => Some(TraeVariant::Global),
            "global_trae_code" | "global_traecode" | "trae_code_global" | "traecodeglobal"
            | "trae global" => Some(TraeVariant::GlobalTraeCode),
            "trae_merged" | "traemerged" | "trae merged" | "trae_app" => {
                Some(TraeVariant::TraeMerged)
            }
            "global_trae_merged" | "globaltraemerged" | "trae_merged_global"
            | "trae app global" => Some(TraeVariant::GlobalTraeMerged),
            _ => None,
        }
    }

    pub fn all() -> [TraeVariant; 2] {
        [TraeVariant::TraeMerged, TraeVariant::GlobalTraeMerged]
    }

    pub fn oauth_line(self) -> OAuthLine {
        OAuthLine::from_package_type(variant_spec(self).package_type)
    }
}

/// 授权页的**产品线**（客户端 `iCubeApp.authConfig` 的两把钥匙）。
///
/// 它与 [`TraeRegion`](super::region::TraeRegion) **正交**，也与 [`TraeProgram`]
/// 同构但不是同一个东西：`TraeProgram` 是**本项目的执行轴**（写哪个目录、启动哪个 exe），
/// 本枚举是**上游授权页的入参选择器**。二者当前取值一一对应，但依据不同
/// （前者来自 userData/exe 名，后者来自客户端 `packageType` 的分派），
/// 所以**刻意不互相转换** —— 合并会让「授权页参数该按什么分」这个事实被藏起来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OAuthLine {
    /// SOLO 产品线（`packageType` ∈ {`SOLO_CN`, `SOLO_I18N`, `SOLO_CN_ENTERPRISE`}）。
    Solo,
    /// TRAE / IDE 产品线（其余 `packageType`）。
    Trae,
}

impl OAuthLine {
    /// 客户端的 `packageType → 产品线` 分派（**逐字照抄**，含企业版取值）。
    ///
    /// 未登记的取值一律落 [`OAuthLine::Trae`] —— 与客户端 `? :` 的 `else` 分支同向。
    /// 本项目三条变体的 `packageType` 都已登记，故这只是一条与上游对齐的兜底。
    ///
    /// ⚠️ **不是 `const fn`**：`match` 一个 `&str` 在 const 上下文里尚未稳定
    /// （`cannot match on str in constant functions`）。本函数不需要 const，
    /// 真正需要 const 的是 [`OAuthLine::default_client_id`]（`mod.rs` 的常量引用它）。
    pub fn from_package_type(package_type: &str) -> OAuthLine {
        match package_type {
            "SOLO_CN" | "SOLO_I18N" | "SOLO_CN_ENTERPRISE" => OAuthLine::Solo,
            _ => OAuthLine::Trae,
        }
    }

    /// 授权页 `auth_from` 参数（客户端同名字符串）。
    pub const fn auth_from(self) -> &'static str {
        match self {
            OAuthLine::Solo => "solo",
            OAuthLine::Trae => "trae",
        }
    }

    pub const fn default_client_id(self) -> &'static str {
        match self {
            OAuthLine::Solo => "en1oxy7wnw8j9n",
            OAuthLine::Trae => "ono9krqynydwx5",
        }
    }

    /// 是否追加 `hide_saas_login=true`。
    ///
    /// 客户端原文：`auth_from === "solo" && (url += "&hide_saas_login=true")`
    /// —— 它是 `auth_from` 的**从属**参数，不是独立开关，因此不单独配置。
    pub const fn hide_saas_login(self) -> bool {
        matches!(self, OAuthLine::Solo)
    }

    /// `DeviceInfo.PlatformCode` —— 同样是**产品线级**的取值。
    ///
    /// 客户端原文（本机 2026-09-24 读 `out/main.js`，逐字）：
    /// ```js
    /// k(){ return gr(this.d) ? "SOLO_PC" : "IDE_PC" }   // gr = 是否 SOLO_Lite
    /// ```
    /// 与 `auth_from` / `client_id` 用的是**同一个**判定（`Su(t) === "SOLO_Lite"`），
    /// 因此必须与它们同源派生 —— 分成两个常量必然漂移。
    ///
    /// ## 为什么这条值得单独写一段注释（真机现场）
    ///
    /// 2026-09-24 用户报「TraeWork（SOLO 线）OAuth 登录失败，上游回
    /// `20403/040036 Token device not match`」。抓真机对照发现：本实现把
    /// `PlatformCode` 写死成 `IDE_PC`（从参考实现 `oauth.rs` 逐字抄来，而参考
    /// 固化的是 **TraeCode/IDE 线**），而真机客户端在 SOLO 线上报的是 **`SOLO_PC`**。
    /// 这正是「移植参考实现前先问这段抓自哪条产品线」那条教训的漏网之鱼。
    pub const fn platform_code(self) -> &'static str {
        match self {
            OAuthLine::Solo => "SOLO_PC",
            OAuthLine::Trae => "IDE_PC",
        }
    }
}

impl Default for TraeVariant {
    fn default() -> Self {
        TraeVariant::TraeMerged
    }
}

/// 一套端点取值（对应 `product.json` 里某个 region 键下的全部主机）。
///
/// 字段名对齐 [`super`] 里既有的常量语义，便于逐字对拍。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndpointSet {
    /// 账号中心 / 签到 / 积分基址（`bootConfig.account.trae.*` / `ug.trae.*`）。
    pub account_base: &'static str,
    /// iCube / 市场 / ASR 基址（`bootConfig.iCube.*` / `market.trae.*` / `asr.domain.*`）。
    pub icube_base: &'static str,
    /// 对话（agent）网关基址（`bootConfig.agent.trae.*`，与 `icube_base` **不同主机**）。
    pub agent_host: &'static str,
    pub ws_base: Option<&'static str>,
    /// 网页控制台 / **授权页**基址（`bootConfig.consoleHost`）。
    ///
    /// ⚠️ 这是**网页域，不是 API 域**：它与 `account_base` / `icube_base` 不同主机，
    /// 只用于「浏览器里打开的那一页」。授权页完整地址 = `${console_base}/authorization`，
    /// 拼法照抄客户端自身（`loginHost = bootConfig.consoleHost`，
    /// 再拼 `/authorization?login_version=1&…`，见 `out/main.js` 的 OAuth 构造段）。
    ///
    /// ⚠️ **必须按区域分家**：CN 是 `https://www.trae.cn`，国际版是 `https://www.trae.ai`。
    /// 拿 CN 域给国际版发登录 ⇒ 用户在**错的账号体系**的授权页上登录，
    /// 页面即使走完也不会把凭据回调回本机（域与客户端不匹配），
    /// 症状与「回调端口没人监听」几乎一样（停在「认证中」），极易误判成端口问题。
    pub console_base: &'static str,
}

/// 一个变体的全部差异。
#[derive(Debug, Clone, Copy)]
pub struct VariantSpec {
    /// 所属变体。
    pub variant: TraeVariant,
    /// 稳定的展示名（界面分区标题）。
    pub display_name: &'static str,
    /// 客户端 `product.json` 的 `nameAlias`（官方自称，用于诊断文案与核对）。
    pub name_alias: &'static str,
    /// 客户端 `product.json` 的 `packageType`。
    pub package_type: &'static str,
    /// userData 目录名候选（`%APPDATA%\<名字>`，按优先级）。
    ///
    /// 同一变体可能有多个名字：客户端 `dataFolderName` 都是 `.trae-cn`，
    /// 但 userData 用的是 `nameShort`。
    pub data_dir_names: &'static [&'static str],
    /// 可执行文件名候选（按优先级，与 [`VariantSpec::data_dir_names`] 一一对应）。
    pub exe_names: &'static [&'static str],
    /// 进程名（Windows 精简名，不带 `.exe`）候选。
    pub proc_names: &'static [&'static str],
    pub cn_endpoints: EndpointSet,
    /// 国际版端点集。
    ///
    /// **从未对真实上游跑通过**（本机未装国际版客户端、无可用凭据），
    /// 值取自 CN 客户端 `product.json` 里的 `SG`/`US` 键 —— 那是**客户端自己声明的**，
    /// 比我们的任何推断都可信，但仍不等于「服务端接受」。
    pub global_endpoints: Option<EndpointSet>,
}

impl VariantSpec {
    pub fn endpoints(&self, international: bool) -> Option<&EndpointSet> {
        if international {
            self.global_endpoints.as_ref()
        } else {
            Some(&self.cn_endpoints)
        }
    }

    /// 该变体在 userData 根目录下的候选路径（未做存在性过滤）。
    pub fn data_dir_candidates(&self, base: &std::path::Path) -> Vec<PathBuf> {
        self.data_dir_names
            .iter()
            .map(|name| base.join(name))
            .collect()
    }
}

const TRAE_WORK_SPEC: VariantSpec = VariantSpec {
    variant: TraeVariant::TraeWork,
    display_name: "TraeWork CN",
    name_alias: "TraeWork CN",
    package_type: "SOLO_CN",
    data_dir_names: &["TRAE SOLO CN", "TRAE SOLO"],
    exe_names: &["TRAE SOLO CN.exe", "TRAE SOLO.exe"],
    proc_names: &["TRAE SOLO CN", "TRAE SOLO"],
    cn_endpoints: EndpointSet {
        account_base: "https://api.trae.cn",
        icube_base: "https://api.trae.com.cn",
        agent_host: "https://trae-api-cn.mchost.guru",
        ws_base: Some("wss://trae-ws-cn.mchost.guru/custom_model"),
        console_base: "https://www.trae.cn",
    },
    // 国际化取值来自**国际版客户端自己声明的** `bootConfig.<能力>.trae.normal`
    // （本机装在 `%LOCALAPPDATA%\Programs\TRAE SOLO`，`packageType = SOLO_I18N`）。
    // 主机名是权威值；接口路径与鉴权**从未对上游跑通**，见模块头「仍未验证的部分」。
    global_endpoints: Some(GLOBAL_ENDPOINTS),
};

const TRAE_CN_SPEC: VariantSpec = VariantSpec {
    variant: TraeVariant::Trae,
    display_name: "TraeCode CN",
    name_alias: "TraeCode CN",
    package_type: "TRAE_CN",
    data_dir_names: &["Trae CN"],
    exe_names: &["Trae CN.exe"],
    proc_names: &["Trae CN"],
    cn_endpoints: EndpointSet {
        account_base: "https://api.trae.cn",
        icube_base: "https://api.trae.com.cn",
        agent_host: "https://trae-api-cn.mchost.guru",
        ws_base: Some("wss://trae-ws-cn.mchost.guru/custom_model"),
        console_base: "https://www.trae.cn",
    },
    // 同上：国际版客户端自述值。**产品线不改变端点，region 才改变端点** ——
    // 所以本变体的国际化端点与 `TRAE_WORK_SPEC` 逐字相同（有单测钉住）。
    global_endpoints: Some(GLOBAL_ENDPOINTS),
};

/// 国际版端点（**国际版客户端自述值**）—— 本文件的唯一来源，三处 spec 都引用它。
///
/// 取值来自国际版客户端 `<安装根>\resources\app\product.json` 的
/// `bootConfig.<能力>.trae.normal`（本机 `%LOCALAPPDATA%\Programs\TRAE SOLO`）。
const GLOBAL_ENDPOINTS: EndpointSet = EndpointSet {
    account_base: "https://grow-normal.trae.ai",
    icube_base: "https://icube-normal.trae.ai",
    agent_host: "https://core-normal.trae.ai",
    ws_base: Some("wss://wss-normal.trae.ai/custom_model"),
    console_base: "https://www.trae.ai",
};

/// **国际版区域**（`TraeWork` 国际构建，`packageType = SOLO_I18N`）。
///
/// 与两条 CN 产品线的区别：
/// - 候选名是**国际版客户端自己的**名字（`TRAE SOLO` / `TRAE SOLO.exe`），
///   不是 CN 那条的（`TRAE SOLO CN`）—— 混在一起用"按序取第一个存在的"会在
///   同机装两条线时永远命中 CN 那个，国际版被静默吞掉；
/// - 端点用国际版那套（本表里 `cn_endpoints` 这一格放的就是**它实际使用的端点**：
///   `EndpointSet` 的字段名是历史包袱，`Global` 没有"另一套"可切）。
const GLOBAL_SPEC: VariantSpec = VariantSpec {
    variant: TraeVariant::Global,
    display_name: "TraeWork",
    name_alias: "TraeWork",
    package_type: "SOLO_I18N",
    data_dir_names: &["TRAE SOLO"],
    exe_names: &["TRAE SOLO.exe"],
    proc_names: &["TRAE SOLO"],
    cn_endpoints: GLOBAL_ENDPOINTS,
    global_endpoints: None,
};

const GLOBAL_TRAE_CODE_SPEC: VariantSpec = VariantSpec {
    variant: TraeVariant::GlobalTraeCode,
    // 国际版**不带后缀**（用户 2026-10-13 更正的规则）；保留家族名 `TraeCode`，
    // 否则会与国际合并版（`Trae`）撞名。理由见 [`TraeVariant::display_name`]。
    display_name: "TraeCode",
    name_alias: "TraeCode（待实测）",
    package_type: "TRAE_I18N",
    data_dir_names: &["Trae"],
    exe_names: &["Trae.exe"],
    proc_names: &["Trae"],
    // 国际版变体**没有「另一套」可切**：端点直接放在 `cn_endpoints` 槽
    // （字段名是历史包袱），与 [`GLOBAL_SPEC`] 同款处理。
    cn_endpoints: GLOBAL_ENDPOINTS,
    global_endpoints: None,
};

const CN_TRAE_MERGED_SPEC: VariantSpec = VariantSpec {
    variant: TraeVariant::TraeMerged,
    display_name: "Trae CN",
    name_alias: "TraeCode CN",
    package_type: "TRAE_CN",
    data_dir_names: &["Trae CN"],
    exe_names: &["Trae CN.exe"],
    proc_names: &["Trae CN"],
    // ⚠️ **刻意逐字重写、不引用共享常量**：`两条产品线的cn端点逐字相同` 那条护栏
    // 断的是「三份**各自独立写出**的取值恰好相同」；改成一个共享常量后那条断言会
    // 恒真（同义反复），再也挡不住「有人给某条产品线单独改了端点」。
    cn_endpoints: EndpointSet {
        account_base: "https://api.trae.cn",
        icube_base: "https://api.trae.com.cn",
        agent_host: "https://trae-api-cn.mchost.guru",
        ws_base: Some("wss://trae-ws-cn.mchost.guru/custom_model"),
        console_base: "https://www.trae.cn",
    },
    // 同其余 CN 变体：产品线不改变端点、region 才改变端点。
    global_endpoints: Some(GLOBAL_ENDPOINTS),
};

const GLOBAL_TRAE_MERGED_SPEC: VariantSpec = VariantSpec {
    variant: TraeVariant::GlobalTraeMerged,
    display_name: "Trae",
    name_alias: "TraeCode（待实测）",
    package_type: "TRAE_I18N",
    data_dir_names: &["Trae"],
    exe_names: &["Trae.exe"],
    proc_names: &["Trae"],
    // 国际版变体**没有「另一套」可切**：端点直接放在 `cn_endpoints` 槽
    // （字段名是历史包袱），与 [`GLOBAL_SPEC`] / [`GLOBAL_TRAE_CODE_SPEC`] 同款处理。
    cn_endpoints: GLOBAL_ENDPOINTS,
    global_endpoints: None,
};

/// 取变体的描述符。
pub fn variant_spec(variant: TraeVariant) -> &'static VariantSpec {
    match variant {
        TraeVariant::TraeWork => &TRAE_WORK_SPEC,
        TraeVariant::Trae => &TRAE_CN_SPEC,
        TraeVariant::Global => &GLOBAL_SPEC,
        TraeVariant::GlobalTraeCode => &GLOBAL_TRAE_CODE_SPEC,
        TraeVariant::TraeMerged => &CN_TRAE_MERGED_SPEC,
        TraeVariant::GlobalTraeMerged => &GLOBAL_TRAE_MERGED_SPEC,
    }
}

pub fn all_specs() -> [&'static VariantSpec; 2] {
    [&CN_TRAE_MERGED_SPEC, &GLOBAL_TRAE_MERGED_SPEC]
}

pub fn all_known_specs() -> [&'static VariantSpec; 6] {
    [
        &TRAE_WORK_SPEC,
        &CN_TRAE_MERGED_SPEC,
        &TRAE_CN_SPEC,
        &GLOBAL_SPEC,
        &GLOBAL_TRAE_MERGED_SPEC,
        &GLOBAL_TRAE_CODE_SPEC,
    ]
}

/// 从 userData 目录名 / 安装目录名 / exe 名反查变体。
///
/// 这是「探测到的是哪条产品线」的唯一判定入口：先用目录名精确匹配，
/// 再退化到「包含关系」（容忍 `TRAE SOLO CN` 之类的完整名与 `solo` 之类的片段）。
///
/// 返回 `None` 表示**不认识**这个名字 —— 调用方应保持"跨变体"的宽容行为
/// （例如仍然把它当候选目录），而不是硬判成某一个变体。
pub fn variant_of_name(name: &str) -> Option<TraeVariant> {
    let lowered = name.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return None;
    }
    // 去 `.exe` 后缀：调用方可能传 exe 文件名。
    let lowered = lowered.strip_suffix(".exe").unwrap_or(&lowered).to_string();

    for spec in all_known_specs() {
        for candidate in spec.data_dir_names.iter().chain(spec.exe_names.iter()) {
            if candidate.eq_ignore_ascii_case(&lowered) {
                return Some(spec.variant);
            }
        }
    }

    // 再退化到包含关系。`solo` 是 Trae Work 的独有词根（`TRAE SOLO`），
    // 放在 `trae` 之前判定，否则 `TRAE SOLO CN` 会被 `trae` 抢先命中。
    //
    // ⚠️ 两条**已修**的重叠不再靠这里兜底：`Trae` / `Trae.exe` 现在精确命中
    //   [`GLOBAL_TRAE_CODE_SPEC`]（国际版 TraeCode），不会再落回 `Trae`（国内）。
    //
    // ⚠️ 剩余的一处（与 `TRAE_WORK_SPEC` 的候选名重叠同源）：`TRAE SOLO` 会落到
    //   `TraeWork`（国内），而它其实是**国际版**客户端的 userData 名。修它等于摘掉
    //   那条重叠，见 `TRAE_WORK_SPEC` 的说明 —— 必须与那 20 条护栏一起单独一轮处理。
    if lowered.contains("solo") {
        return Some(TraeVariant::TraeWork);
    }
    if lowered.contains("trae") {
        return Some(TraeVariant::Trae);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 变体标识与展示名稳定() {
        assert_eq!(TraeVariant::TraeWork.as_str(), "trae_work");
        assert_eq!(TraeVariant::Trae.as_str(), "trae_cn");
        assert_eq!(TraeVariant::Global.as_str(), "global");
        assert_eq!(TraeVariant::GlobalTraeCode.as_str(), "global_trae_code");
        assert_eq!(TraeVariant::TraeWork.display_name(), "TraeWork CN");
        // 本取值代表**遗留** TraeCode 程序位（`TraeMerged` 才是合并版）
        // ⇒ 展示名取它的 `nameAlias` 写法 `TraeCode CN`（国内带 ` CN` 后缀）。
        assert_eq!(TraeVariant::Trae.display_name(), "TraeCode CN");
        assert_eq!(TraeVariant::Global.display_name(), "TraeWork");
        // 与 `region::GLOBAL_TRAE_CODE.display_name` / 前端国际化程序名同源。
        // 国际版不带后缀，但**保留家族名** ⇒ `TraeCode`（若简称 `Trae` 会与合并版撞名）。
        assert_eq!(TraeVariant::GlobalTraeCode.display_name(), "TraeCode");
        assert_eq!(TraeVariant::default(), TraeVariant::TraeMerged);
        // 标识符已正名为 `Trae`，但历史字符串仍可解析（两侧都可读）。
        assert_eq!(TraeVariant::parse("trae"), Some(TraeVariant::Trae));
        assert_eq!(TraeVariant::parse("trae_cn"), Some(TraeVariant::Trae));

        assert_eq!(TraeVariant::TraeMerged.as_str(), "trae_merged");
        assert_eq!(TraeVariant::GlobalTraeMerged.as_str(), "global_trae_merged");
        assert_ne!(
            TraeVariant::TraeMerged.as_str(),
            TraeVariant::Trae.as_str(),
            "合并版与遗留 TraeCode 的标识必须不同"
        );
        assert_ne!(
            TraeVariant::GlobalTraeMerged.as_str(),
            TraeVariant::GlobalTraeCode.as_str(),
            "国际版合并版与遗留国际版 TraeCode 的标识必须不同"
        );
        // 展示名：国内带 ` CN`、国际不带后缀（用户 2026-10-13 更正的规则）。
        assert_eq!(TraeVariant::TraeMerged.display_name(), "Trae CN");
        assert_eq!(TraeVariant::GlobalTraeMerged.display_name(), "Trae");
        {
            let mut seen: Vec<&str> = Vec::new();
            for variant in [
                TraeVariant::TraeWork,
                TraeVariant::Trae,
                TraeVariant::TraeMerged,
                TraeVariant::Global,
                TraeVariant::GlobalTraeCode,
                TraeVariant::GlobalTraeMerged,
            ] {
                let name = variant.display_name();
                assert!(
                    !seen.contains(&name),
                    "展示名 `{name}` 被两个变体共用（{variant:?}）—— 用户分不清是哪条程序位"
                );
                seen.push(name);
            }
            assert_eq!(seen.len(), 6, "前置：应恰有 6 个变体，否则本用例会恒真");
        }
        // 三个 CN 取值两两不同（否则「按变体分档」等于没分）。
        assert_ne!(TraeVariant::TraeMerged, TraeVariant::Trae);
        assert_ne!(TraeVariant::TraeMerged, TraeVariant::TraeWork);
        // `parse` 接受自己的落盘标识（`as_str` 往返）。
        for variant in [TraeVariant::TraeMerged, TraeVariant::GlobalTraeMerged] {
            assert_eq!(
                TraeVariant::parse(variant.as_str()),
                Some(variant),
                "{:?} 的 as_str 无法往返",
                variant
            );
        }
    }

    #[test]
    fn 四个程序位映射到正确的区域() {
        use super::super::region::TraeRegion;
        assert_eq!(TraeVariant::TraeWork.region(), TraeRegion::Cn);
        assert_eq!(TraeVariant::Trae.region(), TraeRegion::Cn);
        assert_eq!(TraeVariant::Global.region(), TraeRegion::Global);
        assert_eq!(TraeVariant::GlobalTraeCode.region(), TraeRegion::Global);
        assert_eq!(TraeVariant::TraeMerged.region(), TraeRegion::Cn);
        assert_eq!(TraeVariant::GlobalTraeMerged.region(), TraeRegion::Global);
        // `all_specs()` 的口径必须与 `region()` 自洽（每条 spec 的 `variant` 字段
        // 与它自己的 region 对得上），否则「表里写着 A、跑起来落 B」。
        for spec in all_known_specs() {
            assert_eq!(
                variant_spec(spec.variant).variant.region(),
                spec.variant.region(),
                "{} 的 region 与表不自洽",
                spec.name_alias
            );
        }
    }

    #[test]
    fn 国际版traecode与区域标识分家() {
        for s in [
            "global_trae_code",
            "global_traecode",
            "trae_code_global",
            "traecodeglobal",
            "trae global",
            "GLOBAL_TRAE_CODE",
        ] {
            assert_eq!(
                TraeVariant::parse(s),
                Some(TraeVariant::GlobalTraeCode),
                "解析失败: {s}"
            );
        }
        // `global` 仍是**区域标识**，落该区域的主程序（TraeWork）。
        for s in ["global", "intl", "international", "trae_global"] {
            assert_eq!(
                TraeVariant::parse(s),
                Some(TraeVariant::Global),
                "解析失败: {s}"
            );
        }
        // `trae_code`（无区域前缀）是**国内** TraeCode —— 不能顺手改成国际版。
        assert_eq!(TraeVariant::parse("trae_code"), Some(TraeVariant::Trae));
    }

    #[test]
    fn 裸名反查落到合并版国际客户端且不落国内() {
        assert_eq!(variant_of_name("Trae"), Some(TraeVariant::GlobalTraeMerged));
        assert_eq!(
            variant_of_name("Trae.exe"),
            Some(TraeVariant::GlobalTraeMerged)
        );
        assert_eq!(variant_of_name("trae"), Some(TraeVariant::GlobalTraeMerged));
        assert_ne!(variant_of_name("Trae"), Some(TraeVariant::TraeWork));
        assert_ne!(variant_of_name("Trae"), Some(TraeVariant::Trae));
        // 带 CN 后缀的落**合并版国内**客户端（不是国际版）。
        assert_eq!(variant_of_name("Trae CN"), Some(TraeVariant::TraeMerged));
        assert_eq!(
            variant_of_name("Trae CN.exe"),
            Some(TraeVariant::TraeMerged)
        );
        // 两个程序位的目录名互不包含（`Trae` 是 `Trae CN` 的子串）—— 靠**精确匹配**分开。
        assert_ne!(
            variant_of_name("Trae CN"),
            variant_of_name("Trae"),
            "包含关系必须靠精确匹配拆开，不能靠包含匹配"
        );
    }

    #[test]
    fn 解析接受目录名与常见别名() {
        for s in ["trae_work", "TraeWork", "Trae Work", "solo", "TRAE SOLO CN"] {
            assert_eq!(
                TraeVariant::parse(s),
                Some(TraeVariant::TraeWork),
                "解析失败: {s}"
            );
        }
        for s in ["trae_cn", "Trae", "Trae CN", "ide", "trae"] {
            assert_eq!(
                TraeVariant::parse(s),
                Some(TraeVariant::Trae),
                "解析失败: {s}"
            );
        }
        assert_eq!(TraeVariant::parse("doubao"), None);
        assert_eq!(TraeVariant::parse(""), None);
    }

    /// 反查的核心判别式：`solo` 必须先于 `trae` 判定。
    /// 若顺序写反，`TRAE SOLO CN` 会命中 `trae` 分支被误判成 Trae CN。
    #[test]
    fn 反查时solo优先于trae() {
        assert_eq!(variant_of_name("TRAE SOLO CN"), Some(TraeVariant::TraeWork));
        assert_eq!(variant_of_name("TRAE SOLO"), Some(TraeVariant::TraeWork));
        assert_eq!(
            variant_of_name("TRAE SOLO CN.exe"),
            Some(TraeVariant::TraeWork)
        );
        assert_eq!(variant_of_name("Trae CN"), Some(TraeVariant::TraeMerged));
        assert_eq!(
            variant_of_name("Trae CN.exe"),
            Some(TraeVariant::TraeMerged)
        );
        // 目录名不区分大小写。
        assert_eq!(variant_of_name("trae solo cn"), Some(TraeVariant::TraeWork));
        // 不认识的平台（豆包）不能被硬判成某个 Trae 变体。
        assert_eq!(variant_of_name("Doubao"), None);
    }

    #[test]
    fn 四个程序位的候选名互不重叠() {
        let specs = all_known_specs();
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
                            overlaps.push(format!("{kind}:{name}:{:?}/{:?}", a.variant, b.variant));
                        }
                    }
                }
            }
        }
        overlaps.sort();
        assert_eq!(
            overlaps,
            vec![
                "exe 名:TRAE SOLO.exe:TraeWork/Global".to_string(),
                "exe 名:Trae CN.exe:TraeMerged/Trae".to_string(),
                "exe 名:Trae.exe:GlobalTraeMerged/GlobalTraeCode".to_string(),
                "userData 目录名:TRAE SOLO:TraeWork/Global".to_string(),
                "userData 目录名:Trae CN:TraeMerged/Trae".to_string(),
                "userData 目录名:Trae:GlobalTraeMerged/GlobalTraeCode".to_string(),
                "进程名:TRAE SOLO:TraeWork/Global".to_string(),
                "进程名:Trae CN:TraeMerged/Trae".to_string(),
                "进程名:Trae:GlobalTraeMerged/GlobalTraeCode".to_string(),
            ],
            "候选名重叠集合变了 —— 白名单外的新重叠必须先修掉（或显式登记理由）"
        );

        for (code, merged) in [
            (variant_spec(TraeVariant::Trae), TraeVariant::TraeMerged),
            (
                variant_spec(TraeVariant::GlobalTraeCode),
                TraeVariant::GlobalTraeMerged,
            ),
        ] {
            for other in all_known_specs() {
                if other.variant == code.variant || other.variant == merged {
                    continue;
                }
                for (kind, mine, theirs) in [
                    ("userData 目录名", code.data_dir_names, other.data_dir_names),
                    ("exe 名", code.exe_names, other.exe_names),
                    ("进程名", code.proc_names, other.proc_names),
                ] {
                    for name in mine {
                        assert!(
                            !theirs.contains(name),
                            "TraeCode 的 {kind} `{name}` 与 {:?} 重叠（跨区误判来源）",
                            other.variant
                        );
                    }
                }
            }
        }

        for (legacy, merged) in [
            (
                variant_spec(TraeVariant::Trae),
                variant_spec(TraeVariant::TraeMerged),
            ),
            (
                variant_spec(TraeVariant::GlobalTraeCode),
                variant_spec(TraeVariant::GlobalTraeMerged),
            ),
        ] {
            assert_eq!(legacy.data_dir_names, merged.data_dir_names);
            assert_eq!(legacy.exe_names, merged.exe_names);
            assert_eq!(legacy.proc_names, merged.proc_names);
            assert_ne!(
                legacy.variant.as_str(),
                merged.variant.as_str(),
                "合并版必须有**自己的**变体标识，否则快照目录会与遗留槽位共用"
            );
        }
    }

    #[test]
    fn 授权页产品线由package_type派生且不按区域分() {
        // 三条变体各自的产品线。
        assert_eq!(
            variant_spec(TraeVariant::TraeWork).variant.oauth_line(),
            OAuthLine::Solo,
            "TraeWork（SOLO_CN）必须落 SOLO 线"
        );
        assert_eq!(
            variant_spec(TraeVariant::Global).variant.oauth_line(),
            OAuthLine::Solo,
            "国际版 TraeWork（SOLO_I18N）必须落 SOLO 线 —— 它与 CN 是同一条产品线"
        );
        assert_eq!(
            variant_spec(TraeVariant::Trae).variant.oauth_line(),
            OAuthLine::Trae,
            "Trae（TRAE_CN）必须落 TRAE 线"
        );
        assert_eq!(
            variant_spec(TraeVariant::TraeMerged).variant.oauth_line(),
            OAuthLine::Trae,
            "合并版 CN（TRAE_CN）必须落 TRAE 线"
        );
        assert_eq!(
            variant_spec(TraeVariant::GlobalTraeMerged)
                .variant
                .oauth_line(),
            OAuthLine::Trae,
            "合并版国际（TRAE_I18N）必须落 TRAE 线"
        );

        // 分派是 `packageType` 的函数，与区域无关：同一 `packageType` 必然同一产品线。
        for spec in all_specs() {
            assert_eq!(
                OAuthLine::from_package_type(spec.package_type),
                spec.variant.oauth_line(),
                "{} 的产品线没有从 package_type 派生",
                spec.name_alias
            );
        }
        // 企业版取值按客户端原样识别（本项目暂无该变体，但规则必须完整）。
        assert_eq!(
            OAuthLine::from_package_type("SOLO_CN_ENTERPRISE"),
            OAuthLine::Solo
        );
        assert_eq!(
            OAuthLine::from_package_type("TRAE_CN_ENTERPRISE"),
            OAuthLine::Trae
        );

        // 两条线的三件取值必须**两两不同**（否则「按线分家」等于没分）。
        assert_ne!(OAuthLine::Solo.auth_from(), OAuthLine::Trae.auth_from());
        assert_ne!(
            OAuthLine::Solo.default_client_id(),
            OAuthLine::Trae.default_client_id()
        );
        assert_ne!(
            OAuthLine::Solo.hide_saas_login(),
            OAuthLine::Trae.hide_saas_login()
        );
        assert_ne!(
            OAuthLine::Solo.platform_code(),
            OAuthLine::Trae.platform_code()
        );
        // 逐字值（与客户端 `authConfig` / `auth_from` / `k()` 分派对拍）。
        assert_eq!(OAuthLine::Solo.auth_from(), "solo");
        assert_eq!(OAuthLine::Trae.auth_from(), "trae");
        assert_eq!(OAuthLine::Solo.default_client_id(), "en1oxy7wnw8j9n");
        assert_eq!(OAuthLine::Trae.default_client_id(), "ono9krqynydwx5");
        assert!(OAuthLine::Solo.hide_saas_login());
        assert!(!OAuthLine::Trae.hide_saas_login());
        // `PlatformCode` 与 `auth_from` **同源判定**：SOLO 线是 SOLO_PC。
        // 反例就是 2026-09-24 那个真实缺陷（写死 IDE_PC ⇒ 上游 20403）。
        assert_eq!(OAuthLine::Solo.platform_code(), "SOLO_PC");
        assert_eq!(OAuthLine::Trae.platform_code(), "IDE_PC");
        for spec in all_specs() {
            assert_eq!(
                OAuthLine::from_package_type(spec.package_type).platform_code(),
                spec.variant.oauth_line().platform_code(),
                "{} 的 PlatformCode 没有从 package_type 派生",
                spec.name_alias
            );
        }
    }

    #[test]
    fn 两条产品线的cn端点逐字相同() {
        let work = variant_spec(TraeVariant::TraeWork).cn_endpoints;
        let cn = variant_spec(TraeVariant::Trae).cn_endpoints;
        assert_eq!(work, cn);
        assert_eq!(work.account_base, "https://api.trae.cn");
        assert_eq!(work.icube_base, "https://api.trae.com.cn");
        assert_eq!(work.agent_host, "https://trae-api-cn.mchost.guru");

        assert_eq!(
            variant_spec(TraeVariant::TraeMerged).cn_endpoints,
            work,
            "合并版 CN 的端点与 TraeWork / TraeCode 不一致 —— 产品线不改变端点"
        );
    }

    #[test]
    fn 国际化端点取自国际版客户端自述值() {
        let expected = EndpointSet {
            account_base: "https://grow-normal.trae.ai",
            icube_base: "https://icube-normal.trae.ai",
            agent_host: "https://core-normal.trae.ai",
            ws_base: Some("wss://wss-normal.trae.ai/custom_model"),
            console_base: "https://www.trae.ai",
        };
        let (declared, global_only): (Vec<&'static VariantSpec>, Vec<&'static VariantSpec>) =
            all_known_specs()
                .into_iter()
                .partition(|s| s.global_endpoints.is_some());
        assert_eq!(declared.len(), 3, "应恰有三条 CN 变体声明了国际版端点");
        assert_eq!(global_only.len(), 3, "应恰有三个国际区域变体");
        for spec in declared {
            assert_eq!(
                spec.global_endpoints.expect("刚 partition 过，必然有"),
                expected,
                "{} 的国际化端点漂了",
                spec.name_alias
            );
        }
        // 国际区域变体：它的 `cn_endpoints` 槽里放的就是**它实际使用的端点**。
        for spec in global_only {
            assert_eq!(
                spec.cn_endpoints, expected,
                "{} 的端点不是国际版客户端自述值",
                spec.name_alias
            );
            assert_eq!(
                spec.variant.region(),
                super::super::region::TraeRegion::Global,
                "{} 必须是国际区域变体",
                spec.name_alias
            );
        }
    }

    /// 国际化端点在**每个主机**上都必须与 CN 不同：混用会把请求打到错的域，
    /// 而且这种错误在日志里只表现为「401 / 超时」，极难定位。
    ///
    /// 另钉住 `ws_base` **必须已登记**：它此前是 `None`（"未验证"占位），
    /// 这条断言在本次更正前是**红的** —— 正因如此它才值得留在这里。
    ///
    /// 只对**同时有两套端点**的变体（两条 CN 线）成立：国际区域变体只有一套，
    /// 「与 CN 不同」对它们无意义（见上一条的分拨说明）。
    #[test]
    fn 国际化端点与cn端点主机全不同() {
        let mut checked = 0usize;
        for spec in all_known_specs() {
            let Some(global) = spec.global_endpoints else {
                continue;
            };
            checked += 1;
            assert_ne!(
                global.account_base, spec.cn_endpoints.account_base,
                "account 撞了"
            );
            assert_ne!(
                global.icube_base, spec.cn_endpoints.icube_base,
                "iCube 撞了"
            );
            assert_ne!(
                global.agent_host, spec.cn_endpoints.agent_host,
                "agent 撞了"
            );
            assert_ne!(global.ws_base, spec.cn_endpoints.ws_base, "ws 撞了");
            // 授权页域同样必须分家：共用 CN 域 = 国际版用户在错的账号体系上登录。
            assert_ne!(
                global.console_base, spec.cn_endpoints.console_base,
                "授权页域（consoleHost）撞了"
            );
            assert!(
                global.ws_base.is_some(),
                "{} 的国际版 ws 端点缺失（应为国际版客户端自述的 wss 值）",
                spec.name_alias
            );
        }
        // 前置：必须有对象被校验过，否则本用例会**恒真**。
        // 3 = 三条 CN 区域变体（TraeWork / TraeCode / 合并版）各持有两套端点。
        assert_eq!(checked, 3, "应恰有三条变体同时持有 CN 与国际两套端点");
    }

    #[test]
    fn cn端点等于改造前的常量原值() {
        let spec = variant_spec(TraeVariant::TraeWork);
        assert_eq!(
            spec.cn_endpoints.account_base,
            super::super::TRAE_API_BASE_CN
        );
        assert_eq!(
            spec.cn_endpoints.icube_base,
            super::super::TRAE_OAUTH_BASE_CN
        );
    }

    /// `international = true` 而国际版端点缺失时必须返回 `None`，
    /// **绝不能**回落到 CN 值 —— 那会把国际化请求打到国内域。
    #[test]
    fn 国际版端点缺失时不回落cn() {
        let spec = variant_spec(TraeVariant::TraeWork);
        assert!(spec.endpoints(false).is_some());
        let global = spec.endpoints(true).expect("国际版端点应已登记");
        assert_ne!(global.account_base, spec.cn_endpoints.account_base);
        // 用一个刻意缺国际版端点的 spec 验证 None 语义。
        let mut stripped = *spec;
        stripped.global_endpoints = None;
        assert!(stripped.endpoints(true).is_none());
    }
}
