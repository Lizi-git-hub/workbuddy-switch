
/// 允许转发的**业务路径前缀**（**顺序即 UI 展示顺序**）。
///
/// ⚠️ 加新前缀 = 在**本表**加一行 + 在面板白名单表里同步（面板从后端读，故只改这里）。
pub const BIZ_PATH_PREFIXES: &[&str] = &[
    // 签到 / 积分计量（`config.rs` 的 `CHECKIN_API_PREFIX`）。
    "/v2/billing/",
    // 业务插件接口（`config.rs` 的 `WORKBUDDY_API_PREFIX`）。
    "/v2/plugin/",
    // 自动旅行（`config.rs` 的 `TRAVEL_API_PREFIX` 的域内前缀）。
    "/activity/",
];

/// 该路径是否在**业务白名单**内（**fail-closed**：不在册即 `false`）。
///
/// ⚠️ 判据是**前缀匹配**且**要求路径以 `/` 开头** —— 空串、相对路径、
/// 带 `..` 的穿越尝试一律 `false`（**不解析、不归一化**，避免把自己绕进去）。
pub fn is_allowed_path(path: &str) -> bool {
    if !path.starts_with('/') {
        return false;
    }
    // 拒绝任何穿越尝试（`..` / `//`）—— 白名单是"确知安全"的清单，不该靠归一化兜底。
    if path.contains("..") || path.contains("//") {
        return false;
    }
    BIZ_PATH_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_known_business_paths() {
        assert!(is_allowed_path("/v2/billing/meter/daily-checkin"));
        assert!(is_allowed_path("/v2/plugin/user/credits"));
        assert!(is_allowed_path("/activity/growth/buddy/travel/status"));
    }

    #[test]
    fn rejects_unknown_paths_fail_closed() {
        assert!(
            !is_allowed_path("/v2/chat/completions"),
            "LLM 路径不走业务白名单"
        );
        assert!(!is_allowed_path("/admin/secret"));
        assert!(!is_allowed_path(""), "空路径必须拒绝");
        assert!(!is_allowed_path("v2/billing/meter"), "相对路径必须拒绝");
    }

    #[test]
    fn rejects_traversal_attempts() {
        assert!(!is_allowed_path("/v2/billing/../../etc/passwd"));
        assert!(
            !is_allowed_path("/v2//billing/meter"),
            "双斜杠必须拒绝（不靠归一化兜底）"
        );
    }
}
