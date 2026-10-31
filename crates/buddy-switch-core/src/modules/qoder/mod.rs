
pub mod account;
pub mod api;
pub mod campaign;
pub mod checkin;
pub mod cosy;
pub mod credits;
pub mod device;
pub mod export_import;
pub mod native;
pub mod oauth;
pub mod paths;
pub mod profile;
pub mod refresh;
pub mod region;
pub mod store;
pub mod switch;
pub mod token;
pub mod trash;
pub mod usage;
pub mod web_proxy;
pub mod web_session;
pub mod web_usage;

// ---------------------------------------------------------------------------
// 上游 API 路径（两个区域共用；端点基址在 `region::realm_spec` 里按区查表）
// ---------------------------------------------------------------------------

/// 设备授权：发起。
pub const PATH_DEVICE_AUTHORIZE: &str = "/api/v1/deviceToken/authorize";
/// 设备授权：轮询换取令牌。
pub const PATH_DEVICE_TOKEN_POLL: &str = "/api/v1/deviceToken/poll";
/// 设备流令牌刷新。
pub const PATH_DEVICE_TOKEN_REFRESH: &str = "/api/v1/deviceToken/refresh";
/// PAT → jobToken 交换。
pub const PATH_JOB_TOKEN_EXCHANGE: &str = "/api/v1/jobToken/exchange";
/// jobToken 刷新。
pub const PATH_JOB_TOKEN_REFRESH: &str = "/api/v1/jobToken/refresh";
/// 额度 / 用量。
pub const PATH_QUOTA_USAGE: &str = "/api/v2/quota/usage";
/// 套餐信息。
pub const PATH_USER_PLAN: &str = "/api/v2/user/plan";
/// 模型清单（动态源）。
pub const PATH_MODEL_LIST: &str = "/algo/api/v2/model/list";
pub const PATH_CAMPAIGNS: &str = "/sash/api/v1/me/campaigns";
/// 签到：状态查询（`/sash` 通道，与 `/api` 通道不同 —— 别拼错）。
pub const PATH_CHECKIN_STATUS: &str = "/sash/api/v1/me/daily-check-in/status";
/// 签到：领取。
pub const PATH_CHECKIN_CLAIM: &str = "/sash/api/v1/me/daily-check-in/claim";
/// Pro 升级奖励**资格查询**（`eligibility → claim` 两步走的第一步）。
pub const PATH_PRO_ELIGIBILITY: &str = "/sash/api/v1/me/pro-upgrade/eligibility";
/// Pro 升级奖励领取。
pub const PATH_PRO_CLAIM: &str = "/sash/api/v1/me/pro-upgrade/claim";
/// 单活动**奖励发放状态**查询（幂等、只读；`{id}` 位置替换 campaign id）。
pub const PATH_CAMPAIGN_REWARD_TEMPLATE: &str = "/sash/api/v1/me/campaigns/{id}/reward";
/// 单活动领取（`{id}` 位置替换 campaign id）。
pub const PATH_CAMPAIGN_CLAIM_TEMPLATE: &str = "/sash/api/v1/me/campaigns/{id}/claim";
/// 推理（SSE）：对话生成。
///
/// ⚠️ 请求体要过 [`cosy::qoder_encode`] 编码、整体走 COSY 签名头 —— 见 `cosy` 模块头。
///
/// ⚠️ **签名路径**（不带 query）；实际**发送**要用 [`PATH_CHAT_SSE_ENCODED`]。
/// 上游按 `?Encode=1` 决定「先解码再按 JSON 解析」还是「直接按 JSON 解析」：
/// 带编码体打这条**裸路径**，上游会把自定义 base64 当 JSON 读 ⇒ HTTP 200 +
/// `event:error` + Jackson `JsonParseException`（真机取证 2026-10-17，Qoder CN）。
/// 与模型清单 [`api::PATH_MODELS_ENCODED`] 同一个约定，别只给清单加、忘了推理。
pub const PATH_CHAT_SSE: &str = "/algo/api/v2/service/pro/sse/agent_chat_generation";
/// 推理（SSE）的**请求路径**：与 [`PATH_CHAT_SSE`] 同一端点，带 `Encode=1`。
///
/// 签名仍然只覆盖 [`PATH_CHAT_SSE`]（query 不参与签名 —— 见 `api` 模块头对
/// `PATH_MODELS_SIGN` 的同款说明）。
pub const PATH_CHAT_SSE_ENCODED: &str =
    "/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1";

/// 签到活动的奖励数值（「每日领取 100 Credits」）。
///
/// ⚠️ 这是**展示兜底**：真实数值以上游返回为准。写在这里是为了让 UI 在
/// 「尚未拉到活动详情」时也有一个**诚实**的占位，而不是显示 0 或空白。
pub const DAILY_CHECKIN_REWARD: u32 = 100;
