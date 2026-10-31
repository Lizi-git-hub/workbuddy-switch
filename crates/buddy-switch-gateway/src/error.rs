//! 网关错误类型与「上游类别 → HTTP 状态码 / 协议错误体」映射（P0-7）。

use serde_json::{json, Value};

use buddy_switch_core::modules::product::Scope;
use buddy_switch_core::modules::region::{self, Region, RegionMismatch};
use buddy_switch_core::modules::upstream::UpstreamErrorKind;

/// `pool_busy`（503）建议客户端等多久再试 —— 会写进 `Retry-After` 响应头。
///
/// 取值依据：在途额度在**当前那批请求结束**时归还（`InFlightLease` 的 `Drop`），
/// 本机量级是亚秒到几秒；2s 与 relay 排队等待的默认量级一致，足以避开
/// 「立刻重试 → 把刚空出来的额度又打满」的抖动。
const POOL_BUSY_RETRY_AFTER_SECS: u64 = 2;

/// 网关统一错误。
#[derive(Debug, Clone)]
pub enum GatewayError {
    /// 未携带/无效/已吊销 Key → 401
    Unauthorized(String),
    NoCredential {
        /// 归属域。
        region: Region,
        /// 具体原因。四类状态的**可行动指引完全不同**，见 [`NoCredentialCause`]。
        cause: NoCredentialCause,
    },
    /// 选中的账号只有加密信封凭据 → 401（可读指引；见 `account::envelope_token_error`）
    EncryptedCredential { region: Region },
    /// 凭据 region 不符 → 401（安全红线 F，含修复指引）
    RegionMismatch(RegionMismatch),
    /// 上游失败 → 按 kind 映射
    Upstream {
        kind: UpstreamErrorKind,
        status: u16,
        message: String,
        attempts: Vec<UpstreamAttempt>,
    },
    /// 请求参数不合法 → 400
    BadRequest(String),
    ModelDisabled { scope: Scope, model: String },
    PoolBusy {
        /// 归属域。
        region: Region,
        /// 池内该域的账号总数（含被排除的：它只影响「能不能选」，不影响「号是好的」）。
        total: usize,
    },
    ModelGatePaused {
        /// 被闸门暂停的模型名（必须点名：用户要知道该换哪个模型）。
        model: String,
        /// 距解冻的剩余秒数（向上取整，至少 1）。
        remain_secs: u64,
        failures: usize,
        cooled_accounts: usize,
        attempts: Vec<UpstreamAttempt>,
    },
    KeyQuotaExceeded {
        /// 用量（当前口径）。
        used: u64,
        /// 上限。
        limit: u64,
        /// 计量单位（token / 请求数）。
        unit: crate::apikey::QuotaUnit,
        /// 重置周期（不重置 ⇒ 文案说「累计」）。
        period: crate::apikey::QuotaPeriod,
    },
    /// 网关自身错误（端口占用/目录失败/内部）→ 502（不返回裸堆栈）
    Internal(String),
}

/// 一次上游尝试的摘要（失败响应的 `attempts` 字段）。
///
/// 只带**排查必需**的四项：哪个账号、什么账号 uid、上游状态码、一句原因。
/// 刻意不带宽高/权重等内部数据 —— 对外契约越小越稳。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UpstreamAttempt {
    /// 账号展示名。
    pub account: String,
    /// 账号 uid（`""` = 没选到账号，例如闸门短路）。
    pub uid: String,
    /// 上游 HTTP 状态（`0` = 传输层错误 / 未发出请求）。
    pub status: u16,
    /// 一句可读原因（分类结果或池的拒绝原因）。
    pub reason: String,
}

impl UpstreamAttempt {
    /// 转成对外 JSON（键名 camelCase，与其它响应一致）。
    pub fn to_value(&self) -> Value {
        json!({
            "account": self.account,
            "uid": self.uid,
            "status": self.status,
            "reason": self.reason,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoCredentialCause {
    /// `current` 策略：本机该 region 的认证文件缺失，或存在但读不出凭据。
    ///
    /// （`read_auth_file_for` 把「文件存在但不可解析」视为该位置的**权威**结果，
    /// 不回退下一候选；`imported_account_from_root` 取不到 `access_token` 也返回 `None`。
    /// 两者都落到这一档。）
    AuthFileMissing,
    /// 该 region 账号库为空（`max_credits` 策略，或 relay 同步后池内该区域 0 条）。
    StoreEmpty,
    /// `pinned` 策略：被指定的账号不在该 region 账号库中（多半已被删除）。
    PinnedMissing,
    /// relay 兜底：池里该 region **有**账号，但此刻一个都不可用。
    ///
    /// 计数来自池快照（`Pool::summary`），用于把「有 12 个号但 0 个可用」这类
    /// 事实**直接摆给用户**，而不是让他猜。
    PoolExhausted {
        /// 该区域池内账号总数。
        total: usize,
        /// 其中已禁用（三振终态）的数量。
        disabled: usize,
        /// 其中冷却中的数量。
        cooling: usize,
        /// 其中余额为 0 的数量。
        zero_credits: usize,
        /// 其中被**用户显式排除**的数量。
        ///
        /// 必须单独给出来：否则「5 个号、0 禁用、0 冷却、0 零积分」这句话会自相矛盾
        /// —— 用户看到池里有号、状态都正常，却被告知「0 个可用」。
        excluded: usize,
        /// 其中「状态可用、但在途已满」的数量（**计入** `available`，不是互斥态）。
        ///
        /// 与 `excluded` 是同一个坑的两面：缺了它，「5 个号、0 禁用、0 冷却、0 零积分、
        /// 0 被排除」与「0 个可用」就自相矛盾 —— 用户会以为网关在胡说。
        in_flight_full: usize,
        model_cooling: usize,
    },
    ScopeEmpty {
        /// 该区域池内账号总数（与 `allowed` 对照，说明名单覆盖面）。
        pool_total: usize,
        /// 名单覆盖、且在该区域池内的账号数（`0` = 名单里没有一个号属于本区域）。
        allowed: usize,
        disabled: usize,
        cooling: usize,
        zero_credits: usize,
        excluded: usize,
        in_flight_full: usize,
        model_cooling: usize,
    },
}

impl GatewayError {
    /// 上游类别 → HTTP 状态码（A-3.5）。
    pub fn status(&self) -> u16 {
        match self {
            GatewayError::Unauthorized(_)
            | GatewayError::NoCredential { .. }
            | GatewayError::EncryptedCredential { .. }
            | GatewayError::RegionMismatch(_) => 401,
            GatewayError::Upstream { kind, .. } => match kind {
                UpstreamErrorKind::HardCredit => 402,
                UpstreamErrorKind::SoftRate => 429,
                UpstreamErrorKind::SessionDead => 401,
                UpstreamErrorKind::NotFound => 502,
                UpstreamErrorKind::Server => 502,
                // 504 = 网关等待上游超时（语义最准；5xx 对客户端是「可重试」）。
                UpstreamErrorKind::Timeout => 504,
                UpstreamErrorKind::Client => 400,
            },
            GatewayError::BadRequest(_) => 400,
            // 403 = 明确拒绝（凭据有效、请求合法，但该模型被用户禁用）。
            GatewayError::ModelDisabled { .. } => 403,
            // 503 = 并发占满。凭据正常、几秒内自愈 ⇒ 让客户端退避重试，别去改登录态。
            GatewayError::PoolBusy { .. } => 503,
            GatewayError::ModelGatePaused { .. } => 503,
            // 配额用尽 ⇒ 429（Too Many Requests 的本义：这个调用方到此为止）。
            GatewayError::KeyQuotaExceeded { .. } => 429,
            GatewayError::Internal(_) => 502,
        }
    }

    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            GatewayError::PoolBusy { .. } => Some(POOL_BUSY_RETRY_AFTER_SECS),
            GatewayError::ModelGatePaused { remain_secs, .. } => Some((*remain_secs).max(1)),
            _ => None,
        }
    }

    /// 错误类别名（`type`/`code` 字段用）。
    pub fn type_name(&self) -> &'static str {
        match self {
            GatewayError::Unauthorized(_) => "unauthorized",
            GatewayError::NoCredential { .. } => "no_credential",
            GatewayError::EncryptedCredential { .. } => "encrypted_credential",
            GatewayError::RegionMismatch(_) => "region_mismatch",
            GatewayError::Upstream { kind, .. } => match kind {
                UpstreamErrorKind::HardCredit => "hard_credit",
                UpstreamErrorKind::SoftRate => "soft_rate",
                UpstreamErrorKind::SessionDead => "session_dead",
                UpstreamErrorKind::NotFound => "not_found",
                UpstreamErrorKind::Server => "server",
                UpstreamErrorKind::Timeout => "timeout",
                UpstreamErrorKind::Client => "client",
            },
            GatewayError::BadRequest(_) => "bad_request",
            GatewayError::ModelDisabled { .. } => "model_disabled",
            GatewayError::PoolBusy { .. } => "pool_busy",
            GatewayError::ModelGatePaused { .. } => "model_gate_paused",
            GatewayError::KeyQuotaExceeded { .. } => "key_quota_exceeded",
            GatewayError::Internal(_) => "internal",
        }
    }

    /// 可读消息（不含堆栈）。
    pub fn message(&self) -> String {
        match self {
            GatewayError::Unauthorized(message) => message.clone(),
            GatewayError::NoCredential { region, cause } => no_credential_message(*region, *cause),
            GatewayError::EncryptedCredential { region } => format!(
                "选中的{}账号凭据是 WorkBuddy 加密信封态，网关无法用它发起请求；\
                 请在 Buddy Switch 中对该账号重新登录（或 OAuth 扫码添加）以取得明文凭据",
                region_display(*region)
            ),
            GatewayError::RegionMismatch(mismatch) => mismatch.message(),
            GatewayError::Upstream { message, .. } => truncate_upstream_message(message),
            GatewayError::BadRequest(message) => message.clone(),
            // 与 Trae 侧共用同一句文案（`disabled_models::disabled_message`），避免两处漂移。
            GatewayError::ModelDisabled { scope, model } => {
                crate::disabled_models::disabled_message(*scope, model)
            }
            GatewayError::KeyQuotaExceeded { used, limit, unit, period } => {
                let unit_text = match unit {
                    crate::apikey::QuotaUnit::Token => "token",
                    crate::apikey::QuotaUnit::Request => "次请求",
                };
                let period_text = match period {
                    crate::apikey::QuotaPeriod::None => "累计".to_string(),
                    crate::apikey::QuotaPeriod::Daily => "每日".to_string(),
                    crate::apikey::QuotaPeriod::Weekly => "每周".to_string(),
                    crate::apikey::QuotaPeriod::Monthly => "自然月".to_string(),
                };
                format!(
                    "这把 API Key 的{period_text}用量已用尽（已用 {used} / 上限 {limit} {unit_text}）；                     换号与重试都不会好 —— 额度按密钥计。请调高上限、切换周期，或改用其它密钥"
                )
            }
            GatewayError::PoolBusy { region, total } => format!(
                "本机{}账号库有 {total} 个账号，可用的那些此刻全被在途请求占满（凭据与余额都正常）：\
                 稍等几秒重试即可；若长期如此，请在「网关 → 账号池」调高每账号在途上限或增加账号",
                region_display(*region)
            ),
            GatewayError::ModelGatePaused {
                model,
                remain_secs,
                failures,
                cooled_accounts,
                ..
            } => {
                if *cooled_accounts > 0 {
                    format!(
                        "模型「{model}」此刻在全部 {cooled_accounts} 个可用账号上都处于限流冷却：约 {remain_secs} 秒后自动重试。\
                         这是上游对该模型的限流，**与你的凭据无关** —— 换号、重新登录都不会解除。\
                         可以换个模型继续，或稍等再试"
                    )
                } else if *remain_secs == 0 {
                    format!(
                        "模型「{model}」正处于半开试探：另一个请求正在探路，请稍等片刻再试\
                         （凭据与余额都正常，无需换号或重新登录）"
                    )
                } else {
                    format!(
                        "模型「{model}」此刻被整体暂停：窗口内已失败 {failures} 次，约 {remain_secs} 秒后自动放行试探。\
                         这是上游对该模型的限流，**与你的凭据无关** —— 换号、重新登录都不会解除。\
                         可以换个模型继续，或稍等再试"
                    )
                }
            }
            GatewayError::Internal(message) => message.clone(),
        }
    }

    /// OpenAI 端点错误体：`{"error":{"message","type","code"}}`。
    pub fn openai_body(&self) -> Value {
        let kind = self.type_name();
        let mut body =
            json!({ "error": { "message": self.message(), "type": kind, "code": kind } });
        if let Some(attempts) = self.attempts_json() {
            body["error"]["attempts"] = attempts;
        }
        body
    }

    /// Anthropic 端点错误体：`{"type":"error","error":{"type","message"}}`。
    pub fn anthropic_body(&self) -> Value {
        let mut body = json!({ "type": "error", "error": { "type": self.type_name(), "message": self.message() } });
        if let Some(attempts) = self.attempts_json() {
            body["error"]["attempts"] = attempts;
        }
        body
    }

    fn attempts_json(&self) -> Option<Value> {
        match self {
            GatewayError::Upstream { attempts, .. } if !attempts.is_empty() => {
                Some(json!(attempts
                    .iter()
                    .map(UpstreamAttempt::to_value)
                    .collect::<Vec<_>>()))
            }
            GatewayError::ModelGatePaused { attempts, .. } if !attempts.is_empty() => {
                Some(json!(attempts
                    .iter()
                    .map(UpstreamAttempt::to_value)
                    .collect::<Vec<_>>()))
            }
            _ => None,
        }
    }
}

fn no_credential_message(region: Region, cause: NoCredentialCause) -> String {
    let name = region_display(region);
    match cause {
        NoCredentialCause::AuthFileMissing => format!(
            "未找到已登录的{name}账号，请在桌面端登录该版本后重试；\
             若本机没有该版本的桌面客户端（如 Docker / headless 部署），\
             请在「网关 → 账号池」用扫码方式添加账号"
        ),
        NoCredentialCause::StoreEmpty => format!(
            "本机{name}账号库为空，且认证文件也取不到凭据；\
             请先登录该版本桌面端并导入账号，或在本应用内扫码添加账号"
        ),
        NoCredentialCause::PinnedMissing => format!(
            "「指定账号」指向的账号不在本机{name}账号库中（可能已被删除）；\
             请在「网关 → 账号池」重新指定，或改为「不指定」由网关自动择优"
        ),
        NoCredentialCause::PoolExhausted {
            total,
            disabled,
            cooling,
            zero_credits,
            excluded,
            in_flight_full,
            model_cooling,
        } => {
            let excluded_clause = if excluded > 0 {
                format!("、{excluded} 个被你排除")
            } else {
                String::new()
            };
            let excluded_hint = if excluded > 0 {
                "；排除只需在账号池点「取消排除」，账号本身是好的"
            } else {
                ""
            };
            let in_flight_clause = if in_flight_full > 0 {
                format!("、{in_flight_full} 个在途已满（并发占用中）")
            } else {
                String::new()
            };
            let in_flight_hint = if in_flight_full > 0 {
                "；在途已满只是瞬时并发，几秒后自行恢复，无需操作"
            } else {
                ""
            };
            let model_cooling_clause = if model_cooling > 0 {
                format!("、{model_cooling} 个只因该模型被限流（换模型即可用）")
            } else {
                String::new()
            };
            let model_cooling_hint = if model_cooling > 0 {
                "；模型级限流只影响这一个模型，换一个模型就能继续，账号本身是好的"
            } else {
                ""
            };
            format!(
                "本机{name}账号库有 {total} 个账号，但此刻 0 个可用：\
                 {disabled} 个已禁用、{cooling} 个冷却中、{zero_credits} 个余额为 0\
                 {excluded_clause}{in_flight_clause}{model_cooling_clause}。\
                 重新登录 / 切换账号不会解除禁用、冷却与排除 —— \
                 请在「网关 → 账号池」查看逐账号原因（禁用是终态，需余额刷新成功或人工复活\
                 {excluded_hint}{in_flight_hint}{model_cooling_hint}）"
            )
        }
        NoCredentialCause::ScopeEmpty {
            pool_total,
            allowed,
            disabled,
            cooling,
            zero_credits,
            excluded,
            in_flight_full,
            model_cooling,
        } => {
            let key_hint =
                "请在「网关 → 密钥 → 权限」放宽这把 Key 的允许账号（或改成「全部账号」）";
            if allowed == 0 {
                format!(
                    "本机{name}账号库有 {pool_total} 个账号，但这把 API Key 的允许名单里\
                     没有一个属于{name}；{key_hint}"
                )
            } else {
                let excluded_clause = if excluded > 0 {
                    format!("、{excluded} 个被你排除")
                } else {
                    String::new()
                };
                let in_flight_clause = if in_flight_full > 0 {
                    format!("、{in_flight_full} 个在途已满（并发占用中）")
                } else {
                    String::new()
                };
                let in_flight_hint = if in_flight_full > 0 {
                    "；在途已满只是瞬时并发，几秒后自行恢复"
                } else {
                    ""
                };
                let model_cooling_clause = if model_cooling > 0 {
                    format!("、{model_cooling} 个只因该模型被限流（换模型即可用）")
                } else {
                    String::new()
                };
                let model_cooling_hint = if model_cooling > 0 {
                    "；模型级限流只影响这一个模型，换一个模型就能继续"
                } else {
                    ""
                };
                format!(
                    "本机{name}账号库有 {pool_total} 个账号，这把 API Key 的允许名单只覆盖其中 \
                     {allowed} 个，而这 {allowed} 个此刻都不可用：{disabled} 个已禁用、\
                     {cooling} 个冷却中、{zero_credits} 个余额为 0\
                     {excluded_clause}{in_flight_clause}{model_cooling_clause}。名单外的账号不会被使用 —— \
                     {key_hint}，或在「网关 → 账号池」恢复这几个账号{in_flight_hint}{model_cooling_hint}"
                )
            }
        }
    }
}

/// region 展示名（错误文案用）。
pub fn region_display(region: Region) -> &'static str {
    region::region_spec(region).display_name
}

/// 上游错误消息的字符上限（防止超长错误体拖垮客户端）。
const UPSTREAM_MESSAGE_LIMIT: usize = 400;

const TRUNCATION_MARKER: &str = "…[truncated]";

/// 超限才截断：保留 `LIMIT - 标记长度` 个字符并追加 [`TRUNCATION_MARKER`]，
/// 使总字符数仍等于 `UPSTREAM_MESSAGE_LIMIT`。
/// 通用截断：超限时保留 `limit - 标记长度` 个字符并追加 [`TRUNCATION_MARKER`]，
/// 使总字符数恰好等于 `limit`，且下游一定能看出「这是网关截的」。
///
/// `limit` 必须不小于标记长度（调用方都是 300/400 量级）。
pub fn truncate_with_marker(text: &str, limit: usize) -> String {
    let marker_len = TRUNCATION_MARKER.chars().count();
    debug_assert!(limit >= marker_len, "上限必须容得下截断标记");
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut head: String = text
        .chars()
        .take(limit.saturating_sub(marker_len))
        .collect();
    head.push_str(TRUNCATION_MARKER);
    head
}

/// 上游错误消息：超限即截断并补标记。
fn truncate_upstream_message(message: &str) -> String {
    truncate_with_marker(message, UPSTREAM_MESSAGE_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(kind: UpstreamErrorKind) -> GatewayError {
        GatewayError::Upstream {
            kind,
            status: 0,
            message: "boom".to_string(),
            attempts: Vec::new(),
        }
    }

    #[test]
    fn upstream_kind_status_mapping_matches_design() {
        assert_eq!(kind(UpstreamErrorKind::HardCredit).status(), 402);
        assert_eq!(kind(UpstreamErrorKind::SoftRate).status(), 429);
        assert_eq!(kind(UpstreamErrorKind::SessionDead).status(), 401);
        assert_eq!(kind(UpstreamErrorKind::NotFound).status(), 502);
        assert_eq!(kind(UpstreamErrorKind::Server).status(), 502);
        assert_eq!(kind(UpstreamErrorKind::Timeout).status(), 504);
        assert_eq!(kind(UpstreamErrorKind::Client).status(), 400);
    }

    #[test]
    fn local_error_status_mapping() {
        assert_eq!(GatewayError::Unauthorized("x".into()).status(), 401);
        assert_eq!(
            GatewayError::NoCredential {
                region: Region::Cn,
                cause: NoCredentialCause::StoreEmpty,
            }
            .status(),
            401
        );
        assert_eq!(GatewayError::BadRequest("x".into()).status(), 400);
        assert_eq!(GatewayError::Internal("x".into()).status(), 502);
    }

    /// 在途占满是 **503 / `pool_busy`**，不是 401 / `no_credential`。
    ///
    /// 阳性对照：把它并进 `NoCredential`（回 401）⇒ 本用例必红。这条错误码会直接
    /// 决定客户端是「退避重试」还是「弹登录态失效」。
    #[test]
    fn pool_busy_is_503_and_names_the_in_flight_quota() {
        let error = GatewayError::PoolBusy {
            region: Region::Cn,
            total: 3,
        };
        assert_eq!(error.status(), 503);
        assert_eq!(error.type_name(), "pool_busy");
        assert_ne!(
            error.type_name(),
            GatewayError::NoCredential {
                region: Region::Cn,
                cause: NoCredentialCause::StoreEmpty,
            }
            .type_name(),
            "并发饱和不是认证问题，类别名不得复用 no_credential"
        );

        let message = error.message();
        assert!(message.contains("在途"), "文案必须点名在途额度：{message}");
        assert!(message.contains("3 个"), "应摆出账号数：{message}");
        assert!(
            message.contains("重试"),
            "503 必须告诉客户端「稍后重试」，否则等于没给指引：{message}"
        );
    }

    /// 信封凭据必须与「未找到已登录账号」**分开**。
    ///
    /// 混用会把排查引向错的方向：这条的用户其实**已经登录了**，让他「去桌面端登录」
    /// 是无效指引；真正要做的是让该账号在本应用里重新取得**明文**凭据。
    #[test]
    fn encrypted_credential_is_a_distinct_readable_401() {
        let error = GatewayError::EncryptedCredential { region: Region::Cn };
        assert_eq!(error.status(), 401);
        assert_eq!(error.type_name(), "encrypted_credential");
        assert_ne!(
            error.type_name(),
            GatewayError::NoCredential {
                region: Region::Cn,
                cause: NoCredentialCause::StoreEmpty,
            }
            .type_name(),
            "不得与 no_credential 混为一谈"
        );

        let message = error.message();
        assert!(message.contains("加密信封"), "文案应可读：{message}");
        assert!(message.contains("WorkBuddy"), "应点名是哪个区域：{message}");
        assert!(
            message.contains("重新登录"),
            "应给出可行动的做法：{message}"
        );
    }

    #[test]
    fn no_credential_causes_are_distinct_and_named() {
        let region = Region::Cn;
        let causes = [
            NoCredentialCause::AuthFileMissing,
            NoCredentialCause::StoreEmpty,
            NoCredentialCause::PinnedMissing,
            NoCredentialCause::PoolExhausted {
                total: 12,
                disabled: 9,
                cooling: 3,
                excluded: 0,
                zero_credits: 0,
                in_flight_full: 0,
                model_cooling: 0,
            },
            NoCredentialCause::ScopeEmpty {
                pool_total: 12,
                allowed: 2,
                disabled: 1,
                cooling: 1,
                excluded: 0,
                zero_credits: 0,
                in_flight_full: 0,
                model_cooling: 0,
            },
            NoCredentialCause::ScopeEmpty {
                pool_total: 12,
                allowed: 0,
                disabled: 0,
                cooling: 0,
                excluded: 0,
                zero_credits: 0,
                in_flight_full: 0,
                model_cooling: 0,
            },
        ];
        let messages: Vec<String> = causes
            .iter()
            .map(|cause| {
                GatewayError::NoCredential {
                    region,
                    cause: *cause,
                }
                .message()
            })
            .collect();

        for (cause, message) in causes.iter().zip(&messages) {
            assert!(
                message.contains("WorkBuddy"),
                "{cause:?} 的文案必须点名区域：{message}"
            );
        }
        for i in 0..messages.len() {
            for j in (i + 1)..messages.len() {
                assert_ne!(
                    messages[i], messages[j],
                    "{:?} 与 {:?} 的文案逐字相同 —— 用户无法据此判断该做什么",
                    causes[i], causes[j]
                );
            }
        }
    }

    #[test]
    fn scope_empty_points_at_the_allowlist_not_the_pool() {
        let error = GatewayError::NoCredential {
            region: Region::Cn,
            cause: NoCredentialCause::ScopeEmpty {
                pool_total: 12,
                allowed: 2,
                disabled: 1,
                cooling: 1,
                excluded: 0,
                zero_credits: 0,
                in_flight_full: 0,
                model_cooling: 0,
            },
        };
        assert_eq!(error.type_name(), "no_credential");
        assert_eq!(error.status(), 401);

        let message = error.message();
        assert!(
            message.contains("允许名单"),
            "必须点出是名单导致的：{message}"
        );
        assert!(
            message.contains("允许名单只覆盖其中 2 个"),
            "必须说清名单覆盖面：{message}"
        );
        assert!(
            message.contains("名单外的账号不会被使用"),
            "必须消除「网关把号藏起来了」的误解：{message}"
        );
        assert!(
            message.contains("密钥 → 权限"),
            "必须指向真正能解的那一步（放宽名单）：{message}"
        );
        assert!(
            !message.contains("重新登录"),
            "名单问题是策略问题，让人去重新登录是无效指引：{message}"
        );

        // 名单一个都没覆盖到 ⇒ 不能说「2 个都不可用」，要说「名单里没有本区域的号」。
        let uncovered = GatewayError::NoCredential {
            region: Region::Cn,
            cause: NoCredentialCause::ScopeEmpty {
                pool_total: 12,
                allowed: 0,
                disabled: 0,
                cooling: 0,
                excluded: 0,
                zero_credits: 0,
                in_flight_full: 0,
                model_cooling: 0,
            },
        }
        .message();
        assert!(
            uncovered.contains("没有一个属于"),
            "名单没覆盖本区域要明说：{uncovered}"
        );
    }

    #[test]
    fn pool_exhausted_message_states_facts_and_drops_the_relogin_advice() {
        let message = GatewayError::NoCredential {
            region: Region::Cn,
            cause: NoCredentialCause::PoolExhausted {
                total: 12,
                disabled: 9,
                cooling: 3,
                excluded: 0,
                zero_credits: 0,
                in_flight_full: 0,
                model_cooling: 0,
            },
        }
        .message();

        assert!(message.contains("12 个账号"), "应给出账号总数：{message}");
        assert!(message.contains("9 个已禁用"), "应给出禁用计数：{message}");
        assert!(message.contains("3 个冷却中"), "应给出冷却计数：{message}");
        assert!(
            !message.contains("请在桌面端登录该版本"),
            "「池里有号但全不可用」时不得再让人去桌面端登录（无效指引）：{message}"
        );
    }

    /// 「确实没登录」那一档**必须保留**桌面端指引 —— 否则是把有效指引一起删掉。
    ///
    /// 这是上一条断言的**阳性对照**：没有它，把四类文案全改成「请联系客服」
    /// 也能让上一条变绿。
    #[test]
    fn auth_file_missing_message_keeps_the_desktop_advice() {
        let message = GatewayError::NoCredential {
            region: Region::Cn,
            cause: NoCredentialCause::AuthFileMissing,
        }
        .message();
        assert!(
            message.contains("请在桌面端登录该版本后重试"),
            "真·未登录时必须保留桌面端指引：{message}"
        );
    }

    /// Docker / headless 用户**没有桌面端** ⇒ 文案必须给替代做法。
    ///
    /// 反例：只有「请在桌面端登录该版本后重试」一句时，容器部署的用户
    /// 照着做**做不到**（容器里没有图形客户端）。
    #[test]
    fn headless_deployments_get_a_usable_alternative() {
        for cause in [
            NoCredentialCause::AuthFileMissing,
            NoCredentialCause::StoreEmpty,
        ] {
            let message = GatewayError::NoCredential {
                region: Region::Cn,
                cause,
            }
            .message();
            assert!(
                message.contains("扫码"),
                "{cause:?} 应给无桌面客户端场景的替代做法：{message}"
            );
        }
    }

    #[test]
    fn no_credential_type_name_stays_stable_across_causes() {
        for cause in [
            NoCredentialCause::AuthFileMissing,
            NoCredentialCause::StoreEmpty,
            NoCredentialCause::PinnedMissing,
            NoCredentialCause::PoolExhausted {
                total: 1,
                disabled: 1,
                cooling: 0,
                excluded: 0,
                zero_credits: 0,
                in_flight_full: 0,
                model_cooling: 0,
            },
        ] {
            let error = GatewayError::NoCredential {
                region: Region::Cn,
                cause,
            };
            assert_eq!(error.type_name(), "no_credential", "{cause:?} 不得改类别名");
            assert_eq!(error.status(), 401, "{cause:?} 必须是 401");
        }
    }

    #[test]
    fn region_mismatch_is_unauthorized_and_upstream_messages_are_bounded() {
        let mismatch = GatewayError::RegionMismatch(RegionMismatch {
            actual_domain: "www.workbuddy.ai".to_string(),
            expected_file: "workbuddy-desktop.info".to_string(),
            env_var: "WORKBUDDY_AUTH_FILE".to_string(),
            actual_region: Region::Global,
            expected_region: Region::Cn,
        });
        assert_eq!(mismatch.status(), 401);
        assert_eq!(mismatch.type_name(), "region_mismatch");
        let upstream = GatewayError::Upstream {
            kind: UpstreamErrorKind::Server,
            status: 500,
            message: "x".repeat(1000),
            attempts: Vec::new(),
        };
        assert_eq!(upstream.message().chars().count(), 400);
        assert!(
            upstream.message().ends_with(TRUNCATION_MARKER),
            "截断必须带标记，否则下游无法分辨上游原文与网关截断: {}",
            upstream.message()
        );

        // 未超限的消息必须逐字透传（标记只应出现在真的截断过的消息上）。
        let short = GatewayError::Upstream {
            kind: UpstreamErrorKind::Client,
            status: 400,
            message: "Illegal API invocation from an unapproved channel".to_string(),
            attempts: Vec::new(),
        };
        assert_eq!(
            short.message(),
            "Illegal API invocation from an unapproved channel"
        );
    }

    #[test]
    fn error_bodies_have_expected_shape() {
        let err = kind(UpstreamErrorKind::HardCredit);
        let openai = err.openai_body();
        assert_eq!(openai["error"]["type"], "hard_credit");
        assert_eq!(openai["error"]["code"], "hard_credit");
        assert!(openai["error"]["message"].is_string());

        let anthropic = err.anthropic_body();
        assert_eq!(anthropic["type"], "error");
        assert_eq!(anthropic["error"]["type"], "hard_credit");
        assert!(anthropic["error"]["message"].is_string());
    }

    #[test]
    fn model_gate_pause_is_503_with_retry_after_and_never_401() {
        let err = GatewayError::ModelGatePaused {
            model: "glm-5.2".to_string(),
            remain_secs: 8,
            failures: 2,
            cooled_accounts: 0,
            attempts: vec![UpstreamAttempt {
                account: String::new(),
                uid: String::new(),
                status: 0,
                reason: "glm-5.2 整体暂停".to_string(),
            }],
        };
        assert_eq!(err.status(), 503, "闸门暂停必须是可重试的 503，不能是 401");
        assert_eq!(err.type_name(), "model_gate_paused");
        assert_eq!(
            err.retry_after_secs(),
            Some(8),
            "闸门的 until_ms 是本进程算出的确定值，必须给 Retry-After"
        );

        let message = err.message();
        assert!(message.contains("glm-5.2"), "必须点名模型：{message}");
        assert!(message.contains('8'), "必须给剩余秒数：{message}");
        assert!(
            message.contains("与你的凭据无关"),
            "必须明确否定「凭据坏了」这个误判：{message}"
        );

        let body = err.openai_body();
        assert_eq!(body["error"]["attempts"][0]["reason"], "glm-5.2 整体暂停");

        // 半开票被别的请求领走（remain_ms == 0）⇒ 文案不能说「还剩 0 秒」。
        let taken = GatewayError::ModelGatePaused {
            model: "m".to_string(),
            remain_secs: 0,
            failures: 0,
            cooled_accounts: 0,
            attempts: Vec::new(),
        };
        assert_eq!(taken.status(), 503);
        assert_eq!(taken.retry_after_secs(), Some(1), "Retry-After 至少 1 秒");
        assert!(
            !taken.message().contains("0 秒后"),
            "不能说「0 秒后自动放行」：{}",
            taken.message()
        );
    }

    #[test]
    fn pool_exhausted_message_accounts_for_model_cooling() {
        let message = GatewayError::NoCredential {
            region: Region::Cn,
            cause: NoCredentialCause::PoolExhausted {
                total: 9,
                disabled: 0,
                cooling: 0,
                zero_credits: 0,
                excluded: 0,
                in_flight_full: 0,
                model_cooling: 9,
            },
        }
        .message();
        assert!(
            message.contains("只因该模型被限流"),
            "必须把正交的模型级冷却摆进事实句：{message}"
        );
        assert!(
            message.contains("换模型"),
            "必须给出真能解的动作（换模型）：{message}"
        );

        // 反向对照：没有模型级冷却时不得出现这句（否则是新的噪音）。
        let clean = GatewayError::NoCredential {
            region: Region::Cn,
            cause: NoCredentialCause::PoolExhausted {
                total: 2,
                disabled: 2,
                cooling: 0,
                zero_credits: 0,
                excluded: 0,
                in_flight_full: 0,
                model_cooling: 0,
            },
        }
        .message();
        assert!(!clean.contains("只因该模型被限流"), "{clean}");
    }
}
