
use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::region::gateway_config_file;

/// 台账文件（与 gateway 侧 `proxy_kpi::stats_file()` **同一份** —— 路径必须一致，
/// 否则界面会永远显示「—」而网关在老实写数）。
fn stats_file() -> PathBuf {
    gateway_config_file().with_file_name("proxy-kpi.json")
}

#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
struct DayCounters {
    #[serde(default)]
    requests: u64,
    #[serde(default)]
    switches: u64,
}

pub fn kpi_view() -> Value {
    let today = super::cst::cst_date_str(super::cst::cst_datetime(now_ms()).timestamp_millis());
    let ledger: Option<BTreeMap<String, DayCounters>> = std::fs::read_to_string(stats_file())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());

    match ledger.and_then(|map| map.get(&today).copied()) {
        Some(day) => json!({
            "todayRequests": day.requests,
            "switches": day.switches,
            "persistedBodies": 0,
            "known": true,
        }),
        None => json!({
            "todayRequests": Value::Null,
            "switches": Value::Null,
            "persistedBodies": 0,
            "known": false,
        }),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated_home(tag: &str) -> (PathBuf, crate::modules::config::HomeOverrideGuard) {
        let home = std::env::temp_dir().join(format!(
            "proxy-kpi-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let guard = crate::modules::config::HomeOverrideGuard::set(&home);
        (home, guard)
    }

    /// 读不到台账 ⇒ `known: false` + 计数为 `null`（**不许**回落 0）。
    #[test]
    fn missing_ledger_reads_as_unknown_not_zero() {
        let (home, _guard) = isolated_home("missing");

        let view = kpi_view();
        assert_eq!(view["known"], json!(false), "无台账必须说「不知道」");
        assert_eq!(
            view["todayRequests"],
            json!(null),
            "未知时必须是 null（前端显示「—」），不得回落 0"
        );
        assert_eq!(view["switches"], json!(null));
        // 「落盘正文」是**承诺**，无论有没有数据都是 0。
        assert_eq!(view["persistedBodies"], json!(0));

        let _ = std::fs::remove_dir_all(&home);
    }

    /// 台账里**没有今天**（例如只剩昨天）⇒ 同样是「不知道」，不是 0。
    #[test]
    fn stale_day_is_unknown_not_zero() {
        let (home, _guard) = isolated_home("stale");

        let path = stats_file();
        std::fs::create_dir_all(path.parent().expect("台账必有父目录")).unwrap();
        std::fs::write(&path, r#"{"2000-01-01":{"requests":999,"switches":9}}"#).unwrap();

        let view = kpi_view();
        assert_eq!(
            view["known"],
            json!(false),
            "只有旧日期的台账 ⇒ 今天「不知道」，不得把昨天的数当今天"
        );

        let _ = std::fs::remove_dir_all(&home);
    }
}
