
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};

use buddy_switch_core::modules::config as core_config;
use buddy_switch_core::modules::region::Region;

use crate::protocol::usage_tap::{UsageReport, UsageSink};

/// 一次请求的元数据（不含 prompt/response 正文）。
#[derive(Debug, Clone)]
pub struct RequestMeta {
    pub endpoint: &'static str,
    pub method: &'static str,
    pub region: Region,
    /// 命中账号的**展示名**（可能重名 / 为空；仅供人读，不作身份）。
    pub account: String,
    /// 命中账号的 **uid**（写入时的**精确身份**，供 `token_daily` 精确 join）。
    pub account_uid: String,
    pub key_id: Option<String>,
    pub key_scope: Option<&'static str>,
    pub model: String,
    pub status: u16,
    /// **上游首字节延迟**（请求进入 → 上游响应头到达）。
    ///
    /// ⚠️ 这是 **TTFB，不是总耗时** —— 总耗时另见 [`Self::total_ms`]。两者混用会让
    /// 日志页的耗时列在流式场景下凭空放大（见模块头）。
    pub latency_ms: i64,
    /// **整次请求总耗时**（请求进入 → 流结束 / 响应体读完）。
    ///
    /// 流式路径由 [`StreamingLogSink`] 在流结束时补齐（`template` 里传 0 占位）；
    /// 非流式与失败路径就地填。
    pub total_ms: i64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub credit: f64,
    pub stream: bool,
    pub error: Option<String>,
}

impl RequestMeta {
    /// 序列化为日志条目。
    pub fn to_value(&self) -> Value {
        json!({
            "ts": core_config::now_ms(),
            "endpoint": self.endpoint,
            "method": self.method,
            "region": self.region,
            "account": self.account,
            "accountUid": self.account_uid,
            "model": self.model,
            "status": self.status,
            "latencyMs": self.latency_ms,
            "totalMs": self.total_ms,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "credit": self.credit,
            "stream": self.stream,
            "keyId": self.key_id,
            "keyScope": self.key_scope,
            "error": self.error,
        })
    }
}

/// 流式请求的**延迟日志写入器**（见模块头「写入时机」）。
///
/// ## 为什么需要它（2026-10-14 实测驱动）
///
/// 流式路径此前在**流开始前**就把日志写了，那时 `usage` 还没到达 ⇒
/// `promptTokens` / `completionTokens` **只能写死 0**。而出站管线强制上游流式、
/// 客户端（WorkBuddy 桌面 / CLI）默认也流式 ⇒ **实际流量 100% 命中该分支**：
/// 请求日志的 Token 列与「今日 Token」的网关列**恒为 0**（本机 200/200 条全 0）。
///
/// ## 语义
///
/// - **拿不到用量也要写**（填 0）：这次请求**发生过**（状态码 / 账号 / 模型 / 耗时
///   都是事实），不该因为拿不到用量就从日志里消失。
/// - `prompt_tokens` / `completion_tokens` / **`total_ms`** 由本 sink 在流结束时补齐；
///   **`latency_ms` 原样取自 `template`**（handler 在拿到上游响应头时已填实）
///   —— 本 sink **不碰**它，见模块头「两个耗时字段语义不同」。
pub struct StreamingLogSink {
    log: Arc<RequestLog>,
    /// 除 token 与**总**耗时外的全部字段（流开始时即已确定，含 `latency_ms`）。
    template: RequestMeta,
    started: Instant,
    /// ★ issue #129：流中途失败信号（`None` = 未接入 ⇒ 状态码恒取模板里的 200）。
    ///
    /// 必须在 `finish` 里读：`UsageTap` 在**上报之前**已把失败写进这个槽，
    /// 所以「流中途断流」的日志能写真实状态码，而不是硬编码的 200。
    failure: Option<Arc<crate::failover::StreamFailure>>,
}

impl StreamingLogSink {
    /// `template` 的 `prompt_tokens` / `completion_tokens` / `total_ms` 会被覆盖
    /// （传 0 占位即可）；**`latency_ms` 必须填实**（上游响应头到达时的耗时）。
    pub fn new(log: Arc<RequestLog>, template: RequestMeta, started: Instant) -> Self {
        Self {
            log,
            template,
            started,
            failure: None,
        }
    }

    /// ★ issue #129：接入失败信号 —— 流中途被判失败时把 `status` 改成真实状态码
    /// 并附错误摘要，而不是把这次请求记成「200 成功」。
    pub fn with_failure(mut self, failure: Option<Arc<crate::failover::StreamFailure>>) -> Self {
        self.failure = failure;
        self
    }
}

impl UsageSink for StreamingLogSink {
    fn finish(&self, usage: Option<UsageReport>) {
        // 与 `PoolUsageSink` 相反：**没有用量也要落日志**（用量填 0）。
        let (prompt_tokens, completion_tokens, credit) = match usage {
            Some(usage) => (
                u64::try_from(usage.prompt_tokens).unwrap_or(0),
                u64::try_from(usage.completion_tokens).unwrap_or(0),
                usage.credit,
            ),
            None => (0, 0, 0.0),
        };
        // ★ issue #129：流中途失败 ⇒ 日志写**真实**状态码 + 摘要。
        //   不这么做的话，一次「账号在流中途挂掉」在日志页会显示成成功的 200 请求
        //   —— 对外静默的代价绝不能是「对内也静默」。
        let failure = self.failure.as_ref().and_then(|signal| signal.peek());
        let (status, error) = match &failure {
            Some(failure) => (failure.status, Some(failure.detail.clone())),
            None => (self.template.status, None),
        };
        self.log.record(
            RequestMeta {
                prompt_tokens,
                completion_tokens,
                credit,
                status,
                error,
                // ★ 只补总耗时；`latency_ms` 保留 `template` 里的 TTFB —— 覆盖它正是
                //   2026-10-15 那次「日志数字放大 10~100 倍」的事故来源。
                total_ms: self.started.elapsed().as_millis() as i64,
                ..self.template.clone()
            }
            .to_value(),
        );
    }
}

/// 请求日志：内存 + 落盘，保留最近 N 条。
pub struct RequestLog {
    path: PathBuf,
    keep: Mutex<usize>,
    log_bodies: AtomicBool,
    entries: Mutex<Vec<Value>>,
}

impl RequestLog {
    /// 新建日志（读取既有落盘条目）。
    pub fn new(path: PathBuf, keep: usize, log_bodies: bool) -> Self {
        let entries = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<Vec<Value>>(&text).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        Self {
            path,
            keep: Mutex::new(keep.max(1)),
            log_bodies: AtomicBool::new(log_bodies),
            entries: Mutex::new(entries),
        }
    }

    /// 是否记录正文。
    pub fn log_bodies(&self) -> bool {
        self.log_bodies.load(Ordering::SeqCst)
    }

    /// 更新保留条数并裁剪。
    pub fn set_keep(&self, keep: usize) {
        *self.keep.lock().unwrap() = keep.max(1);
        self.trim_and_save();
    }

    /// 更新正文开关。
    pub fn set_log_bodies(&self, enabled: bool) {
        self.log_bodies.store(enabled, Ordering::SeqCst);
    }

    /// 追加一条日志（元数据），并裁剪到保留上限。
    pub fn record(&self, entry: Value) {
        {
            let mut entries = self.entries.lock().unwrap();
            entries.push(entry);
        }
        self.trim_and_save();
    }

    /// 返回最近 N 条（按时间升序）。
    pub fn list(&self) -> Vec<Value> {
        self.entries.lock().unwrap().clone()
    }

    /// 清空日志（内存 + 落盘）。
    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
        self.save(&[]);
    }

    fn trim_and_save(&self) {
        let keep = *self.keep.lock().unwrap();
        let snapshot = {
            let mut entries = self.entries.lock().unwrap();
            if entries.len() > keep {
                let drop_count = entries.len() - keep;
                entries.drain(..drop_count);
            }
            entries.clone()
        };
        self.save(&snapshot);
    }

    fn save(&self, entries: &[Value]) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let content = serde_json::to_string_pretty(entries).unwrap_or_else(|_| "[]".to_string());
        let _ = core_config::atomic_write(&self.path, &content);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_meta_carries_account_uid_alongside_display_name() {
        let meta = RequestMeta {
            endpoint: "/v1/chat/completions",
            method: "POST",
            region: Region::Cn,
            account: "重名展示名".to_string(),
            account_uid: "uid-b".to_string(),
            key_id: None,
            key_scope: None,
            model: "hy4".to_string(),
            status: 200,
            latency_ms: 12,
            total_ms: 3456,
            prompt_tokens: 10,
            completion_tokens: 2,
            credit: 0.0,
            stream: false,
            error: None,
        };

        let value = meta.to_value();
        assert_eq!(value["accountUid"], "uid-b", "必须写入选中账号的精确 uid");
        assert_eq!(
            value["account"], "重名展示名",
            "account 仍是展示名，语义不变"
        );
        assert_eq!(value["latencyMs"], 12, "latencyMs = 首字节延迟（TTFB）");
        assert_eq!(value["totalMs"], 3456, "totalMs = 总耗时");
    }

    /// 日志条目的**键集合钉死** —— 防止字段被悄悄增删（前端按名读，`token_daily` 也读）。
    #[test]
    fn log_entry_key_set_is_pinned() {
        let value = streaming_template().to_value();
        let keys: std::collections::BTreeSet<&str> = value
            .as_object()
            .expect("日志条目是对象")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            std::collections::BTreeSet::from([
                "ts",
                "endpoint",
                "method",
                "region",
                "account",
                "accountUid",
                "model",
                "status",
                "latencyMs",
                "totalMs",
                "promptTokens",
                "completionTokens",
                "credit",
                "stream",
                "keyId",
                "keyScope",
                "error",
            ]),
            "键集合变了就要同步前端 GatewayLogEntry 与 token_daily 的读法"
        );
    }

    /// 造一个「流式请求」的日志模板。
    ///
    /// `latency_ms` 刻意填 **37**（一个不可能由 `elapsed()` 真实产生的哨兵值）：
    /// sink **必须原样保留**它 —— 这是「TTFB 不被总耗时覆盖」的直接证据。
    /// `total_ms` 与 token 字段是占位，由 sink 在流结束时补齐。
    fn streaming_template() -> RequestMeta {
        RequestMeta {
            endpoint: "/v1/chat/completions",
            method: "POST",
            region: Region::Cn,
            account: "一号".to_string(),
            account_uid: "uid-1".to_string(),
            key_id: None,
            key_scope: None,
            model: "hy4".to_string(),
            status: 200,
            latency_ms: 37,
            total_ms: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            credit: 0.0,
            stream: true,
            error: None,
        }
    }

    /// 独立临时日志文件（各测各的路径，避免并跑互相踩）。
    fn temp_log(tag: &str) -> (Arc<RequestLog>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("bs-log-sink-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建隔离目录");
        let path = dir.join("gateway_logs.json");
        let _ = std::fs::remove_file(&path);
        (Arc::new(RequestLog::new(path, 50, false)), dir)
    }

    #[tokio::test]
    async fn streaming_log_sink_writes_real_tokens_at_stream_end() {
        use crate::protocol::usage_tap::UsageTap;
        use futures_util::StreamExt;

        let (log, dir) = temp_log("tokens");
        let sink: Arc<dyn UsageSink> = Arc::new(StreamingLogSink::new(
            log.clone(),
            streaming_template(),
            Instant::now(),
        ));
        let frames = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"credit\":1.5,\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n",
            "data: [DONE]\n\n",
        );
        let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
            axum::body::Bytes::from_static(frames.as_bytes()),
        )]);
        let _ = UsageTap::new(stream, vec![sink]).collect::<Vec<_>>().await;

        let entries = log.list();
        assert_eq!(entries.len(), 1, "流结束应恰好写一条日志（幂等，不多不少）");
        assert_eq!(
            entries[0]["promptTokens"], 10,
            "流式路径必须写**真实** prompt token —— 写死 0 正是本次修的缺陷"
        );
        assert_eq!(entries[0]["completionTokens"], 5);
        assert_eq!(
            entries[0]["credit"], 1.5,
            "流式路径必须写**上游上报的** credit —— 积分视图按来源拆消耗就靠它"
        );
        assert_eq!(entries[0]["accountUid"], "uid-1", "静态字段不得丢");
        assert_eq!(entries[0]["stream"], true);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn streaming_log_sink_keeps_ttfb_and_adds_total_separately() {
        use crate::protocol::usage_tap::UsageTap;
        use futures_util::StreamExt;

        let (log, dir) = temp_log("ttfb");
        // `started` 刻意早于「现在」一点点，好让 totalMs 有真实的非零值。
        let started = Instant::now();
        let sink: Arc<dyn UsageSink> = Arc::new(StreamingLogSink::new(
            log.clone(),
            streaming_template(),
            started,
        ));
        let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
            axum::body::Bytes::from_static(
                "data: {\"choices\":[],\"usage\":{\"credit\":1.0,\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n"
                    .as_bytes(),
            ),
        )]);
        let _ = UsageTap::new(stream, vec![sink]).collect::<Vec<_>>().await;

        let entries = log.list();
        assert_eq!(entries.len(), 1, "应恰好写一条日志");
        assert_eq!(
            entries[0]["latencyMs"], 37,
            "latencyMs 必须**原样保留** handler 填入的 TTFB —— sink 覆盖它正是「数字放大」\
             事故的根因（日志页的耗时列会从数百 ms 跳到数百 s）"
        );
        assert!(
            entries[0]["totalMs"]
                .as_i64()
                .is_some_and(|value| value >= 0),
            "totalMs 必须由 sink 在流结束时补齐，实际：{}",
            entries[0]["totalMs"]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn streaming_log_sink_still_writes_when_the_stream_is_dropped_early() {
        use crate::protocol::usage_tap::UsageTap;

        let (log, dir) = temp_log("dropped");
        let sink: Arc<dyn UsageSink> = Arc::new(StreamingLogSink::new(
            log.clone(),
            streaming_template(),
            Instant::now(),
        ));
        {
            // 空流且从未被 poll ⇒ 只能靠 Drop 兜底。
            let _tap = UsageTap::new(
                futures_util::stream::iter(Vec::<Result<axum::body::Bytes, std::io::Error>>::new()),
                vec![sink],
            );
        }

        let entries = log.list();
        assert_eq!(entries.len(), 1, "被丢弃的流也必须留下一条日志");
        assert_eq!(
            entries[0]["promptTokens"], 0,
            "用量未知 ⇒ 记 0（而不是丢日志）"
        );
        assert_eq!(entries[0]["accountUid"], "uid-1");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
