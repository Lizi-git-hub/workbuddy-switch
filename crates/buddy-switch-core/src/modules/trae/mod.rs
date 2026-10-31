
pub mod account;
pub mod checkin;
/// 客户端账本：读**用户自己导出的明文库**（不内置解密，见模块头）。
pub mod client_import;
pub mod credits;
pub mod device;
pub mod export_import;
pub mod handlers;
pub mod icube;
pub mod jwt;
pub mod logs;
/// 客户端模型清单（读 `state.vscdb` 里上游下发的 `model_list_map`，见模块头）。
pub mod model_list;
pub mod oauth;
pub mod oauth_client;
/// OAuth 回调结果页（浏览器里那一页的 HTML 渲染，见模块头）。
pub mod oauth_result_page;
pub mod paths;
pub mod platform;
pub mod profile;
/// 区域 × 程序两根正交轴（区域=持久化轴、程序=执行轴）。
///
/// 见模块头说明；这是把「产品线」单轴升级为双轴的落地层。
pub mod region;
/// 旧「产品线」账号库 → 新「区域」账号库的一次性合并迁移（幂等、带备份、不动旧文件）。
pub mod region_migrate;
pub mod settings;
pub mod snapshot_migrate;
pub mod store;
/// 测试专用的环境隔离与 fixture 构造（`cfg(test)` 下才编译，生产代码零引用）。
#[cfg(test)]
pub(crate) mod test_support;
pub mod token_stats;
pub mod variant;

/// Trae 上游：签到与积分接口基址（**CN 默认值**）。
///
/// ⚠️ **不要在新代码里直接用它** —— 按变体分家的正确取法是
/// [`variant::variant_spec`]`(v).endpoints(international).account_base`。
/// 保留此常量有两处用途：
/// 1. [`variant`] 的 CN 端点表以它为基准做逐字对拍（回归测试钉死）；
/// 2. 老调用点尚未迁移完时的兼容默认。
pub const TRAE_API_BASE_CN: &str = "https://api.trae.cn";

/// Trae 上游：OAuth / 令牌交换基址（**CN 默认值**，iCube 族）。
///
/// ⚠️ 同 [`TRAE_API_BASE_CN`]：新代码请走 [`variant`] 查表。
pub const TRAE_OAUTH_BASE_CN: &str = "https://api.trae.com.cn";

/// 取某变体的端点集（CN）。等价于
/// `variant::variant_spec(variant).endpoints(false)`，但直接返回而非 `Option`
/// —— CN 端点永远已登记，调用方不需要处理 `None`。
pub fn endpoints_for(variant: variant::TraeVariant) -> &'static variant::EndpointSet {
    &variant::variant_spec(variant).cn_endpoints
}

/// 签到接口路径。
pub const TRAE_CHECKIN_PATH: &str = "/trae/api/v2/ug/checkin_credits/claim";

/// 签到状态预检接口路径。
pub const TRAE_CHECKIN_STATUS_PATH: &str = "/trae/api/v2/ug/checkin_credits/status";

/// 剩余积分查询接口路径。
pub const TRAE_ENTITLEMENT_PATH: &str = "/trae/api/v2/pay/ide_user_ent_usage";

/// 令牌交换（ExchangeToken）接口路径 —— **主路径**（抓包固化 2026-09-16）。
///
/// 完整 URL 由**回调回传的 `host`** 拼接：`${host}/trae/api/v3/oauth/ExchangeToken`。
/// 旧的 cloudide 端点是另一条路径，见 [`TRAE_EXCHANGE_TOKEN_LEGACY_PATH`]。
pub const TRAE_EXCHANGE_TOKEN_PATH: &str = "/trae/api/v3/oauth/ExchangeToken";

/// 令牌交换的**旧端点**路径（保留作兜底链末位）。
///
/// 参考实现把它标注为「保留至固化协议验证期结束」；本项目按架构裁决保留为
/// 兜底链的最后一环（见 `account::exchange_token_for` 的四步变体链），
/// 但**不再作为主路径**。完整 URL = `${icube_base}${本常量}`。
pub const TRAE_EXCHANGE_TOKEN_LEGACY_PATH: &str = "/cloudide/api/v3/trae/oauth/ExchangeToken";

/// **TRAE / IDE 产品线**的公开 ClientID（抓包固化 2026-09-16，非机密）。
///
/// ⚠️ **这不是"唯一的 client_id"**：它只是 [`variant::OAuthLine::Trae`] 那条线的值。
/// 另一条线（SOLO / TraeWork）用的是 `en1oxy7wnw8j9n` —— 客户端 `product.json` 的
/// `iCubeApp.authConfig` 里两条线各有独立的一把钥匙，`auth_from` 也随线而变
/// （`trae` / `solo`）。**按线取值的正确入口是
/// [`oauth_client::OAuthClientConfig::client_id_for`]`(variant.oauth_line())`**。
///
/// 本常量是 [`variant::OAuthLine::default_client_id`] 的**具名别名**（单点定义在那边，
/// 这里不再写第二份字面量）。参考实现把它标为「真实 Trae **IDE** 登录 URL 实证值」，
/// 并记着「旧值 `en1oxy7wnw8j9n` 会让授权页停在 billing status 后不回跳」——
/// 那条观察是在 **IDE** 语境下的，**不能**推广成「SOLO 线也不能用 SOLO 的值」。
/// 出处：上游项目 `TraeWorkAssistant` 的 `src-tauri/src/commands/oauth.rs:20-23`（不在本仓库）。
pub const TRAE_OAUTH_CLIENT_ID: &str = variant::OAuthLine::Trae.default_client_id();

/// 授权页 `plugin_version` 参数（抓包固化 2026-09-16）。
///
/// 出处：参考 `oauth.rs:28`（`OAUTH_PAGE_PLUGIN_VERSION`）。**逐字对齐，勿按语义改写**。
pub const TRAE_PAGE_PLUGIN_VERSION: &str = "2.3.83560";

/// 授权页 `x_app_version` 参数（抓包固化 2026-09-16）。
///
/// 出处：参考 `oauth.rs:29`（`OAUTH_PAGE_APP_VERSION`）。
pub const TRAE_PAGE_APP_VERSION: &str = "3.3.100";

/// 交换请求的 `PlatformCode`（请求头与 `DeviceInfo` 共用）。
///
/// 出处：参考 `oauth.rs:30`（`OAUTH_PAGE_PLATFORM_CODE`）。
pub const TRAE_PAGE_PLATFORM_CODE: &str = "IDE_PC";

pub const TRAE_OAUTH_APP_ID: &str = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";

/// 签到与状态接口共用的客户端身份版本号。
pub const TRAE_APP_VERSION: &str = "0.1.45";

/// 历史记录保留天数（签到明细 / 每日快照）。
pub const TRAE_HISTORY_KEEP_DAYS: i64 = 90;

/// JWT 剩余有效期低于该值时告警（小时）。
pub const TRAE_JWT_WARN_HOURS: f64 = 24.0;

pub const TRAE_DEFAULT_API_PORT: u16 = 57894;

/// 本地代理默认端口（与 WorkBuddy 侧无冲突；参考实现用 8899）。
pub const TRAE_DEFAULT_PROXY_PORT: u16 = 8899;

pub const TRAE_OAUTH_LOGIN_TIMEOUT_SECONDS: u64 = 300;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_constants_match_captured_snapshot() {
        // client_id：旧值 en1oxy7wnw8j9n 会让授权页停在 billing status 后不回跳。
        assert_eq!(TRAE_OAUTH_CLIENT_ID, "ono9krqynydwx5");

        // 交换端点：主路径是 `/trae/api/v3/oauth/ExchangeToken`（host 由回调回传），
        // 旧 cloudide 端点降级为兜底链末位，两者必须都在。
        assert_eq!(TRAE_EXCHANGE_TOKEN_PATH, "/trae/api/v3/oauth/ExchangeToken");
        assert_eq!(
            TRAE_EXCHANGE_TOKEN_LEGACY_PATH,
            "/cloudide/api/v3/trae/oauth/ExchangeToken"
        );

        // 三个页面参数：逐字对齐参考 `OAUTH_PAGE_*`。
        assert_eq!(TRAE_PAGE_PLUGIN_VERSION, "2.3.83560");
        assert_eq!(TRAE_PAGE_APP_VERSION, "3.3.100");
        assert_eq!(TRAE_PAGE_PLATFORM_CODE, "IDE_PC");

        assert_eq!(TRAE_OAUTH_APP_ID, "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8");

        // 交换端点不得再是旧值（回归护栏：改回旧路径会让 W6 悄悄失效）。
        assert_ne!(
            TRAE_EXCHANGE_TOKEN_PATH, TRAE_EXCHANGE_TOKEN_LEGACY_PATH,
            "主路径与兜底路径必须是两条不同的路径"
        );
    }

    #[test]
    fn checkin_constants_stay_aligned_with_variant_table() {
        for variant in variant::TraeVariant::all()
            .into_iter()
            .filter(|v| v.region() == region::TraeRegion::Cn)
        {
            assert_eq!(
                endpoints_for(variant).account_base,
                TRAE_API_BASE_CN,
                "{} 的 account_base 漂了",
                variant.display_name()
            );
            assert_eq!(
                endpoints_for(variant).icube_base,
                TRAE_OAUTH_BASE_CN,
                "{} 的 icube_base 漂了",
                variant.display_name()
            );
        }
        assert_eq!(TRAE_CHECKIN_PATH, "/trae/api/v2/ug/checkin_credits/claim");
        assert_eq!(
            TRAE_CHECKIN_STATUS_PATH,
            "/trae/api/v2/ug/checkin_credits/status"
        );
    }
}
