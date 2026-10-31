
use std::sync::OnceLock;

use crate::modules::trae::paths;
use crate::modules::trae::variant::OAuthLine;
use crate::modules::trae::TRAE_EXCHANGE_TOKEN_PATH;

/// OAuth 客户端凭证（`client_id` / `client_secret` / 交换路径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthClientConfig {
    /// **全局** ClientID 覆盖（两条产品线共用；`None` ⇒ 各线用自己的内置默认）。
    ///
    /// ⚠️ 正常**不要设**：两条产品线的 `client_id` 本来就不同
    /// （见 [`OAuthClientConfig::client_id_for`]），设了它等于把两条线强行统一 ——
    /// 那只在「上游把两把钥匙都换了、要临时整体替换」时才用。
    /// 只想改一条线请用 [`OAuthClientConfig::client_id_solo`] /
    /// [`OAuthClientConfig::client_id_trae`]。
    pub client_id: Option<String>,
    /// SOLO 产品线（TraeWork）的 ClientID 覆盖；`None` ⇒ 用内置默认。
    pub client_id_solo: Option<String>,
    /// TRAE 产品线（TraeCode / IDE）的 ClientID 覆盖；`None` ⇒ 用内置默认。
    pub client_id_trae: Option<String>,
    /// 旧协议的 `ClientSecret`（默认 `"-"`，仅兜底链末位用到）。
    pub client_secret: String,
    /// 交换端点 **path**（默认 [`TRAE_EXCHANGE_TOKEN_PATH`]；host 由回调回传）。
    pub exchange_path: String,
}

impl OAuthClientConfig {
    pub fn client_id_for(&self, line: OAuthLine) -> &str {
        let per_line = match line {
            OAuthLine::Solo => self.client_id_solo.as_deref(),
            OAuthLine::Trae => self.client_id_trae.as_deref(),
        };
        per_line
            .or(self.client_id.as_deref())
            .unwrap_or_else(|| line.default_client_id())
    }
}

impl Default for OAuthClientConfig {
    fn default() -> Self {
        Self {
            client_id: None,
            client_id_solo: None,
            client_id_trae: None,
            client_secret: DEFAULT_CLIENT_SECRET.to_string(),
            exchange_path: TRAE_EXCHANGE_TOKEN_PATH.to_string(),
        }
    }
}

/// 旧协议兜底链使用的默认 `ClientSecret`（与参考 `oauth.rs:23` 逐字一致）。
pub const DEFAULT_CLIENT_SECRET: &str = "-";

/// 外置文件的 JSON 形状（字段全部可缺省 ⇒ 回落默认值）。
#[derive(serde::Deserialize)]
struct OAuthClientFile {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_id_solo: Option<String>,
    #[serde(default)]
    client_id_trae: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    exchange_path: Option<String>,
}

/// 取非空字符串，否则回落默认值。
fn pick(value: Option<String>, fallback: &str) -> String {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// 取非空字符串；缺省 / 空串 / 纯空白一律视为「没配」。
fn pick_opt(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// 解析外置配置文本；字段缺省 / 空串 / 整份损坏一律回落默认值。
///
/// **不报错**：这是「上游凭证的兜底来源」，读不到就应该用内置默认值继续工作，
/// 而不是让整个 OAuth 登录因为一个配置文件写坏了而不可用。
fn from_json_text(text: &str) -> OAuthClientConfig {
    let default = OAuthClientConfig::default();
    let Ok(parsed) = serde_json::from_str::<OAuthClientFile>(text) else {
        return default;
    };
    OAuthClientConfig {
        client_id: pick_opt(parsed.client_id),
        client_id_solo: pick_opt(parsed.client_id_solo),
        client_id_trae: pick_opt(parsed.client_id_trae),
        client_secret: pick(parsed.client_secret, &default.client_secret),
        exchange_path: pick(parsed.exchange_path, &default.exchange_path),
    }
}

/// 从指定路径读配置（文件缺失 / 不可读 ⇒ 默认值）。
fn from_file(path: &std::path::Path) -> OAuthClientConfig {
    match std::fs::read_to_string(path) {
        Ok(text) => from_json_text(&text),
        Err(_) => OAuthClientConfig::default(),
    }
}

/// 读取外置 OAuth 客户端配置（全局一次；缺失/损坏回退内置默认）。
pub fn oauth_client() -> &'static OAuthClientConfig {
    static CONFIG: OnceLock<OAuthClientConfig> = OnceLock::new();
    CONFIG.get_or_init(|| from_file(&paths::oauth_client_config_file()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_client_config_falls_back_when_file_missing() {
        let missing = std::env::temp_dir().join("definitely-not-here-oauth-client.json");
        assert_eq!(from_file(&missing), OAuthClientConfig::default());

        // 默认值必须与抓包固化常量逐字一致。
        let default = OAuthClientConfig::default();
        assert_eq!(
            default.client_id, None,
            "全局覆盖必须缺省，否则会盖掉 SOLO 线"
        );
        assert_eq!(default.client_secret, "-");
        assert_eq!(default.exchange_path, "/trae/api/v3/oauth/ExchangeToken");
    }

    #[test]
    fn client_id_is_split_by_oauth_line() {
        let default = OAuthClientConfig::default();
        assert_eq!(default.client_id_for(OAuthLine::Solo), "en1oxy7wnw8j9n");
        assert_eq!(default.client_id_for(OAuthLine::Trae), "ono9krqynydwx5");
        assert_ne!(
            default.client_id_for(OAuthLine::Solo),
            default.client_id_for(OAuthLine::Trae),
            "两条产品线的 client_id 必须不同（客户端 authConfig 里就是两把钥匙）"
        );
        // TRAE 线的默认值 = 既有契约常量（回归护栏：不能把别名改漂）。
        assert_eq!(
            default.client_id_for(OAuthLine::Trae),
            crate::modules::trae::TRAE_OAUTH_CLIENT_ID
        );
    }

    /// 覆盖优先级：**该线专属** > **全局** > **内置默认**。
    #[test]
    fn client_id_override_precedence_is_per_line_then_global() {
        // 只设该线专属：另一条线不受影响。
        let solo_only = from_json_text(r#"{"client_id_solo":"solo-x"}"#);
        assert_eq!(solo_only.client_id_for(OAuthLine::Solo), "solo-x");
        assert_eq!(solo_only.client_id_for(OAuthLine::Trae), "ono9krqynydwx5");

        let trae_only = from_json_text(r#"{"client_id_trae":"trae-x"}"#);
        assert_eq!(trae_only.client_id_for(OAuthLine::Trae), "trae-x");
        assert_eq!(trae_only.client_id_for(OAuthLine::Solo), "en1oxy7wnw8j9n");

        // 只设全局：两条线都跟着走（这是「上游整体换钥匙」的用法）。
        let global = from_json_text(r#"{"client_id":"both-x"}"#);
        assert_eq!(global.client_id_for(OAuthLine::Solo), "both-x");
        assert_eq!(global.client_id_for(OAuthLine::Trae), "both-x");

        // 全局 + 该线专属：专属赢。
        let both = from_json_text(r#"{"client_id":"both-x","client_id_solo":"solo-y"}"#);
        assert_eq!(both.client_id_for(OAuthLine::Solo), "solo-y");
        assert_eq!(both.client_id_for(OAuthLine::Trae), "both-x");

        // 空串 / 纯空白不算有效覆盖 ⇒ 回落内置默认（不是回落成空 client_id）。
        let blank = from_json_text(r#"{"client_id":"   ","client_id_solo":""}"#);
        assert_eq!(blank.client_id_for(OAuthLine::Solo), "en1oxy7wnw8j9n");
        assert_eq!(blank.client_id_for(OAuthLine::Trae), "ono9krqynydwx5");
    }

    #[test]
    fn oauth_client_config_reads_overrides() {
        let full = from_json_text(
            r#"{"client_id":"custom-id","client_secret":"s3cret","exchange_path":"/custom/Exchange"}"#,
        );
        assert_eq!(full.client_id.as_deref(), Some("custom-id"));
        assert_eq!(full.client_secret, "s3cret");
        assert_eq!(full.exchange_path, "/custom/Exchange");

        // 只写 client_secret：其余回落默认。
        let partial = from_json_text(r#"{"client_secret":"only-secret"}"#);
        assert_eq!(partial.client_id, None);
        assert_eq!(partial.client_secret, "only-secret");
        assert_eq!(partial.exchange_path, "/trae/api/v3/oauth/ExchangeToken");

        // 空串与纯空白不算有效覆盖。
        let blank = from_json_text(r#"{"client_secret":""}"#);
        assert_eq!(blank.client_secret, "-");

        // 整份损坏 ⇒ 全部回落默认，绝不 panic。
        assert_eq!(
            from_json_text("{ this is not json"),
            OAuthClientConfig::default()
        );
        assert_eq!(from_json_text("[]"), OAuthClientConfig::default());
    }

    /// 默认交换路径必须与 `mod.rs` 的契约常量同源（避免两处漂移）。
    #[test]
    fn default_exchange_path_matches_contract_constant() {
        assert_eq!(
            OAuthClientConfig::default().exchange_path,
            crate::modules::trae::TRAE_EXCHANGE_TOKEN_PATH
        );
        // `TRAE_OAUTH_CLIENT_ID` 是 `OAuthLine::Trae` 的别名 —— 单一来源在
        // `OAuthLine::default_client_id`，这里钉住别名没有漂。
        assert_eq!(
            crate::modules::trae::TRAE_OAUTH_CLIENT_ID,
            OAuthLine::Trae.default_client_id()
        );
    }
}
