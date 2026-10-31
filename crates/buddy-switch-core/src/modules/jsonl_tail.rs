//! **追加型 jsonl 的尾部窗口读取** —— 两个调用方共用的唯一实现。
//!
//! ## 适用前提（两个调用方都成立，且都是各自方案的基石）
//!
//! 会话 jsonl 是**只追加**的：记录按时间顺序落盘 ⇒ **窗口内的记录必然在文件尾部**。
//! 于是「从尾部按块往前扩张，直到读到早于窗口下界的记录」就能覆盖整个窗口，
//! 不必读完整份文件。
//!
//! 实测规模（2026-10-13，Global）：`projects` 下 **26,825 个 jsonl / 72.49 GB**，
//! 而「近 7 天」/「今日」真正需要读的字节只占其中一小部分。
//!
//! 调用方：
//! - [`crate::modules::token_daily`] —— 今日 Token（窗口 = 本地日 00:00）
//! - [`crate::modules::client_limits`] —— 限流台账（窗口 = 近 N 天）
//!
//! ## 为什么合并成一个模块
//!
//! 两边的**窗口边界语义完全相同**（同一个 `since_ms`、同一个「读到更早就停」判据），
//! 差别只在拿到字节之后怎么解析。合成唯一事实来源后，边界用例只需覆盖一次。
//!
//! ⚠️ 对比：两边的**扫描缓存**刻意**不**合并 —— 那边缓存载荷与失效条件都不同
//! （见 `client_limits` 模块头）。
//!
//! ## 停止判据（唯一容易写错的地方）
//!
//! 「**完整行**里最早的时间戳早于窗口下界 ⇒ 停」：追加写 ⇒ 再往前只会更旧。
//! ⚠️ 三条实测踩出来的约束（都有用例固定，别改回去）：
//!
//! 1. **半行不参与判据** —— 缓冲区首行可能是上一块切出来的半行，内容任意；
//!    实测某个半行里第一个 `"timestamp":` 是**工具输出里嵌套的秒级值**，
//!    导致窗口提前截断、该文件开头 2.9MB 的窗口内记录全丢（444 条）。
//! 2. **只认顶层（深度 1）的 `"timestamp":`** —— 见 [`line_timestamp_bytes`]。
//! 3. **只认毫秒级数值** —— 秒级值小 1000 倍，会把边界判成 1970 年。
//!
//! ⚠️ 判据只看**裸** `"timestamp":`：`content` 里出现的 `\"timestamp\":` 是被转义过的，
//! 字节序列对不上（`5C 22 3A` ≠ `22 3A`）⇒ 不会误停。

use std::io::{Read, Seek, SeekFrom};

pub(crate) const TAIL_CHUNK_BYTES: u64 = 32 * 1024;

/// 从 `start` 起读 `len` 字节。
pub(crate) fn read_range(
    file: &mut std::fs::File,
    start: u64,
    len: u64,
) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = vec![0u8; len as usize];
    file.read_exact(&mut buffer)?;
    Ok(buffer)
}

/// 从**已打开的**文件读窗口，返回 `(覆盖窗口的字节, 窗口起始偏移)`。
///
/// I/O 经 `read_range` 落到 `file` 上；扩张逻辑见 [`tail_window_bytes`]。
pub(crate) fn read_window_from(
    file: &mut std::fs::File,
    size: u64,
    since_ms: i64,
) -> Option<(Vec<u8>, u64)> {
    tail_window_bytes(size, since_ms, |from, len| read_range(file, from, len).ok())
}

/// 从尾部往前扩张，返回 `(覆盖窗口的字节, 窗口起始偏移)`。
///
/// I/O 通过 `read(from, len)` 注入，是为了让单测能用**内存里的同一份字节**驱动它 ——
/// 否则「尾部窗口 vs 全量读」的等价性只能拿真实语料比对，而那会被**正在写入的会话**
/// 干扰（同一份语料两次读到的内容本来就不同，差值无法归因）。
///
/// 每次只读**新增的那一段**（已读部分不重读），所以总读取量 ≈ 最终窗口大小，
/// 而不是「每轮重读整段」的 2 倍。
pub(crate) fn tail_window_bytes(
    size: u64,
    since_ms: i64,
    mut read: impl FnMut(u64, u64) -> Option<Vec<u8>>,
) -> Option<(Vec<u8>, u64)> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = TAIL_CHUNK_BYTES;
    loop {
        let end = size - buffer.len() as u64;
        let from = end.saturating_sub(chunk);
        let mut part = read(from, end - from)?;
        part.extend_from_slice(&buffer);
        buffer = part;
        if from == 0 {
            return Some((buffer, 0));
        }
        // 读到早于窗口的记录 ⇒ 再往前只会更旧，停。
        if complete_lines_reach_before(&buffer, since_ms) {
            return Some((buffer, from));
        }
        chunk = chunk.saturating_mul(2);
    }
}

pub(crate) fn complete_lines_reach_before(buffer: &[u8], since_ms: i64) -> bool {
    let Some(cut) = buffer.iter().position(|byte| *byte == b'\n') else {
        // 连一条完整行都没有 ⇒ 无从判断，继续读（宁可多读，不可漏读）。
        return false;
    };
    buffer[cut + 1..]
        .split(|byte| *byte == b'\n')
        .filter_map(line_timestamp_bytes)
        .min()
        .is_some_and(|oldest| oldest < since_ms)
}

pub(crate) fn line_timestamp_bytes(line: &[u8]) -> Option<i64> {
    const KEY: &[u8] = b"\"timestamp\":";
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0;
    while index < line.len() {
        let byte = line[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' => {
                if depth == 1 && line[index..].starts_with(KEY) {
                    let rest = &line[index + KEY.len()..];
                    let end = rest
                        .iter()
                        .position(|byte| !byte.is_ascii_digit() && *byte != b'-')
                        .unwrap_or(rest.len());
                    return std::str::from_utf8(&rest[..end])
                        .ok()?
                        .parse::<i64>()
                        .ok()
                        .filter(|value| *value >= MIN_PLAUSIBLE_MS);
                }
                in_string = true;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            _ => {}
        }
        index += 1;
    }
    None
}

/// 毫秒级时间戳的下限（≈ 2001-09-09）。低于它的多半是**秒级**值（1970 年）。
const MIN_PLAUSIBLE_MS: i64 = 1_000_000_000_000;

#[cfg(test)]
mod tests {
    use super::*;

    /// 用内存字节驱动窗口读取（不碰磁盘）。
    fn window_of(bytes: &[u8], since_ms: i64) -> (Vec<u8>, u64) {
        tail_window_bytes(bytes.len() as u64, since_ms, |from, len| {
            Some(bytes[from as usize..(from + len) as usize].to_vec())
        })
        .expect("窗口读得到")
    }

    /// 记录一行（`pad` 用来把记录推到 chunk 之外）。
    fn line(ts: i64, pad: usize) -> String {
        format!(
            "{{\"timestamp\":{ts},\"filler\":\"{}\"}}\n",
            "x".repeat(pad)
        )
    }

    #[test]
    fn window_covers_every_in_window_record_and_stays_shorter_than_the_file() {
        let since = 1_790_000_000_000i64; // 真实毫秒量级
                                          // 2000 条窗口外的旧记录（约 2MB）+ 300 条窗口内的记录（约 300KB，超过一个 chunk）——
                                          // 老记录必须**远多于**一个 chunk，否则窗口一路扩到文件开头，就证明不了「只读尾部」。
        let mut text = String::new();
        for index in 0..2000 {
            text.push_str(&line(since - 10_000_000 + index, 1024));
        }
        let in_window_start = text.len();
        for index in 0..300 {
            text.push_str(&line(since + index, 1024));
        }
        let bytes = text.into_bytes();

        let (window, start) = window_of(&bytes, since);
        assert!(
            (window.len() as u64) < bytes.len() as u64,
            "窗口必须短于整份文件（{} vs {}）",
            window.len(),
            bytes.len()
        );
        assert!(
            start as usize <= in_window_start,
            "窗口起点必须不晚于**首条窗口内记录**的起点（{start} vs {in_window_start}）"
        );
        let text = String::from_utf8_lossy(&window);
        let kept = text
            .lines()
            .filter(|line| line_timestamp_bytes(line.as_bytes()).is_some_and(|ts| ts >= since))
            .count();
        assert_eq!(kept, 300, "窗口内的记录一条都不能少");
    }

    /// 停止判据：**完整行**里最早的时间戳早于窗口 ⇒ 停。
    ///
    /// `probe` 前置一段「被切断的半行」，与生产一致（首行永远不参与判据）。
    fn probe(complete: &str, since: i64) -> bool {
        let mut buffer = b"\"stderrBytesTruncated\":0}\n".to_vec();
        buffer.extend_from_slice(complete.as_bytes());
        complete_lines_reach_before(&buffer, since)
    }

    #[test]
    fn stop_rule_uses_the_oldest_complete_line() {
        let since = 1_790_000_000_000i64; // 真实毫秒量级
        assert!(probe(
            "{\"timestamp\":1789999999999}\n{\"timestamp\":1790000000001}\n",
            since
        ));
        assert!(!probe(
            "{\"timestamp\":1790000000001}\n{\"timestamp\":1790000000002}\n",
            since
        ));
        // 没有 timestamp 的完整行（内务记录）⇒ 看其余完整行。
        assert!(probe(
            "{\"type\":\"session-meta\"}\n{\"timestamp\":1789999999999}\n",
            since
        ));
        assert!(!probe(
            "{\"type\":\"session-meta\"}\n{\"timestamp\":1790000000001}\n",
            since
        ));
        assert!(probe(
            "{\"timestamp\":1790000000001}\n{\"timestamp\":1789999999999}\n",
            since
        ));
        // 末行没有换行符（客户端最后一次写）也照样算 —— 被截断的数值会被
        // `MIN_PLAUSIBLE_MS` 挡掉（少一位就掉到 1e11 量级），所以不会误判。
        assert!(probe("{\"timestamp\":1789999999999}", since));
        // 缓冲区里**连一个换行都没有** ⇒ 无从判断，继续读。
        assert!(!complete_lines_reach_before(
            b"{\"timestamp\":1789999999999}",
            since
        ));
        assert!(!complete_lines_reach_before(b"", since));
        // 转义形态的 `\"timestamp\":` **不得**被当成顶层键。
        assert!(!probe(
            "{\"a\":\"x \\\"timestamp\\\": 1789999999999\"}\n{\"timestamp\":1790000000001}\n",
            since
        ));
    }

    #[test]
    fn partial_first_line_never_decides_the_window_boundary() {
        let since = 1_790_000_000_000i64;
        // 半行（被切断的记录尾巴，含嵌套秒级时间戳）+ 一条窗口内的完整行。
        let buffer = b"\"timestamp\":1791816285}],\"stderrBytesTruncated\":0}\n\
{\"timestamp\":1790000000001,\"type\":\"message\"}\n";
        assert!(
            !complete_lines_reach_before(buffer, since),
            "半行里的嵌套秒级时间戳不得让窗口提前截断"
        );
        // 完整行里嵌着秒级时间戳（顶层毫秒在前）⇒ 用顶层的毫秒值判，不停。
        let buffer = b"{\"timestamp\":1790000000002,\"content\":[{\"timestamp\":1791816285}]}\n";
        assert!(!probe(std::str::from_utf8(buffer).expect("utf8"), since));
        let buffer = b"\"timestamp\":1700000000000}],\"stderrBytesTruncated\":0}\n\
{\"timestamp\":1790000000001}\n";
        assert!(
            !complete_lines_reach_before(buffer, since),
            "半行里的嵌套毫秒时间戳同样不得决定窗口边界"
        );
        let buffer = b"{\"timestamp\":1700000000000}],\"stderrBytesTruncated\":0}\n\
{\"timestamp\":1790000000001}\n";
        assert!(
            !complete_lines_reach_before(buffer, since),
            "半行即使是「看起来像顶层」的旧记录，也不得参与判据"
        );
        // 顶层毫秒值确实早于窗口 ⇒ 停（阳性对照：不是「恒不停」）。
        assert!(probe(
            "{\"timestamp\":1789999999999,\"content\":[]}\n",
            since
        ));
    }

    /// 顶层时间戳的识别：**只认深度 1**，嵌套的一律不认（哪怕它是毫秒值）。
    #[test]
    fn line_timestamp_recognises_only_top_level_keys() {
        // 顶层键在消息**之后**（`serde_json` 排序键的形态）也必须能找到 ——
        // 早先「只看行首 256 字节」的写法在这里会返回 None，窗口只能一路扩到文件开头。
        let mut line = b"{\"cwd\":\"c\",\"message\":\"".to_vec();
        line.extend(std::iter::repeat_n(b'y', 4096));
        line.extend_from_slice(b"\",\"timestamp\":1790000000001,\"type\":\"message\"}");
        assert_eq!(line_timestamp_bytes(&line), Some(1790000000001));

        // 嵌套的**毫秒**值不认（深度 > 1），取的是顶层那个。
        let nested_first =
            b"{\"content\":[{\"timestamp\":1700000000000}],\"timestamp\":1790000000001}";
        assert_eq!(line_timestamp_bytes(nested_first), Some(1790000000001));
        // 只有嵌套值 ⇒ 不认。
        assert_eq!(
            line_timestamp_bytes(b"{\"content\":[{\"timestamp\":1700000000000}]}"),
            None
        );
        // 字符串里的转义形态不认（在字符串状态里）。
        assert_eq!(
            line_timestamp_bytes(b"{\"a\":\"x \\\"timestamp\\\": 1700000000000\"}"),
            None
        );
        // 秒级 / 零值不认（`MIN_PLAUSIBLE_MS` 兜底）。
        assert_eq!(line_timestamp_bytes(b"{\"timestamp\":1791816285}"), None);
        assert_eq!(line_timestamp_bytes(b"{\"timestamp\":0}"), None);
        // 空行 / 无该键。
        assert_eq!(line_timestamp_bytes(b""), None);
        assert_eq!(line_timestamp_bytes(b"{\"type\":\"session-meta\"}"), None);
    }

    /// 窗口覆盖整份文件（记录全部在窗口内）⇒ 必须一路扩到文件开头。
    #[test]
    fn window_expands_to_the_file_start_when_everything_is_in_window() {
        let since = 1_790_000_000_000i64;
        let mut text = String::new();
        for index in 0..5 {
            text.push_str(&line(since + index, 64));
        }
        let bytes = text.into_bytes();
        let (window, start) = window_of(&bytes, since);
        assert_eq!(start, 0);
        assert_eq!(window.len(), bytes.len());
    }

    #[test]
    fn tail_chunk_is_small_enough_to_not_waste_io() {
        const _: () = assert!(
            TAIL_CHUNK_BYTES <= 64 * 1024,
            "起始块过大：窗口小的文件会白读一整块，实测差 4 倍"
        );
        const _: () = assert!(
            TAIL_CHUNK_BYTES >= 8 * 1024,
            "起始块过小：翻倍轮数增加，收益也早已减半"
        );
    }

    /// 读失败 ⇒ `None`（调用方按「无记录」处理，不得 panic）。
    #[test]
    fn read_failure_yields_none() {
        let got = tail_window_bytes(1024, 1_790_000_000_000, |_, _| None);
        assert!(got.is_none());
    }
}
