
use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::modules::backup_sections::{backup_sections, SectionCounts};
use crate::modules::config;
use crate::modules::export_import::ConflictPolicy;
use crate::modules::product::Scope;
use crate::modules::update;

/// 备份文件类型标识；导入前先校验（防误导入任意 JSON）。
pub const BACKUP_KIND: &str = "buddy-switch-backup";

/// 当前 envelope 契约版本（**唯一兼容依据**，单调递增）。
pub const SUPPORTED_FORMAT_VERSION: u32 = 1;

pub const CREDENTIAL_KEYS: &[&str] = &[
    "access_token",
    "refresh_token",
    "accessToken",
    "refreshToken",
    "$wbEncrypted",
    "jwt",
];

/// 导出勾选：每个 scope 的每个分区（三态），外加是否含凭据。
///
/// 字段名用 **camelCase**（前端约定），`scopes` 的键是 scope 字符串（`wb-cn` 等）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSelection {
    /// 逐 scope 的分区勾选；缺省（空表 / 缺某 scope）⇒ 该 scope **默认全选**（D14）。
    #[serde(default)]
    pub scopes: BTreeMap<String, ScopeSelection>,
    /// 是否包含明文凭据（D15：默认关）。
    #[serde(default)]
    pub includes_credentials: bool,
    #[serde(default)]
    pub app_settings: Option<Value>,
}

/// 单个 scope 的分区勾选（账号 / 配置 / 网关）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ScopeSelection {
    /// 账号分区。
    #[serde(default)]
    pub accounts: bool,
    /// 配置分区。
    #[serde(default)]
    pub config: bool,
    /// 网关分区。
    #[serde(default)]
    pub gateway: bool,
}

impl ScopeSelection {
    /// 该分区 id 是否被勾选（未知 id ⇒ `false`）。
    pub fn wants(&self, section_id: &str) -> bool {
        match section_id {
            "accounts" => self.accounts,
            "config" => self.config,
            "gateway" => self.gateway,
            _ => false,
        }
    }
}

pub fn contains_credential_key(text: &str) -> Option<&'static str> {
    CREDENTIAL_KEYS
        .iter()
        .copied()
        .find(|key| text.contains(key))
}

pub fn parse_envelope(text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err("文件内容为空".to_string());
    }
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("文件不是合法的 JSON：{error}"))?;
    let Some(object) = value.as_object() else {
        return Err("备份文件应为 JSON 对象（含 kind / formatVersion / scopes）".to_string());
    };

    match object.get("kind").and_then(Value::as_str) {
        Some(kind) if kind == BACKUP_KIND => {}
        Some(other) => {
            return Err(format!(
                "不是本应用的备份文件（kind = {other}），已拒绝导入。"
            ))
        }
        None => return Err("备份文件缺少 kind 字段，无法确认来源，已拒绝导入。".to_string()),
    }

    let version = object
        .get("formatVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "备份文件缺少 formatVersion 字段".to_string())? as u32;
    if version > SUPPORTED_FORMAT_VERSION {
        return Err(format!(
            "备份文件版本为 {version}，高于本应用支持的 {SUPPORTED_FORMAT_VERSION}；\
             请先升级应用再导入（不会尽力解析未知版本）。"
        ));
    }

    let value = if version < SUPPORTED_FORMAT_VERSION {
        migrate_envelope(value, version)?
    } else {
        value
    };

    if let Some(scopes) = value.get("scopes") {
        if !scopes.is_object() {
            return Err("备份文件的 scopes 字段应为对象".to_string());
        }
    }

    Ok(value)
}

pub fn migrate_envelope(value: Value, from: u32) -> Result<Value, String> {
    match from {
        v if v == SUPPORTED_FORMAT_VERSION => Ok(value),
        _ => Err(format!(
            "暂不支持从版本 {from} 迁移备份文件（当前契约版本 {SUPPORTED_FORMAT_VERSION}）。"
        )),
    }
}

/// 解析单个 scope 键（fail-closed）；未知 ⇒ 可读 `Err`（导入编排逐分区判定用）。
pub fn resolve_scope_key(key: &str) -> Result<Scope, String> {
    Scope::parse(key).map_err(|error| error.message())
}

/// 列出 envelope 里**无法解析**的 scope 键（导入编排据此「该分区整体拒绝」）。
pub fn unknown_scope_keys(envelope: &Value) -> Vec<String> {
    let Some(scopes) = envelope.get("scopes").and_then(Value::as_object) else {
        return vec![];
    };
    scopes
        .keys()
        .filter(|key| Scope::parse(key).is_err())
        .cloned()
        .collect()
}

pub fn export_backup(selection: &BackupSelection) -> Result<Value, String> {
    let mut envelope = build_envelope(selection, selection.includes_credentials)?;

    strip_credentials(&mut envelope, selection.includes_credentials);

    Ok(envelope)
}

fn build_envelope(
    selection: &BackupSelection,
    includes_credentials: bool,
) -> Result<Value, String> {
    let mut scopes = serde_json::Map::new();
    for scope in Scope::all() {
        let scope_selection = selection.scopes.get(scope.as_str());
        let mut scope_object = serde_json::Map::new();
        for spec in backup_sections() {
            // 未提供该作用域的选择 ⇒ 默认全选（D14）；提供了则按分区勾选。
            let wanted = match scope_selection {
                Some(sel) => sel.wants(spec.id),
                None => true,
            };
            if !wanted {
                continue;
            }
            let value = (spec.read)(scope)?;
            scope_object.insert(spec.id.to_string(), value);
        }
        scopes.insert(scope.as_str().to_string(), Value::Object(scope_object));
    }

    let app_settings = build_app_settings(selection.app_settings.as_ref());

    Ok(json!({
        "kind": BACKUP_KIND,
        "formatVersion": SUPPORTED_FORMAT_VERSION,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "exportedAt": now_rfc3339(),
        "includesCredentials": includes_credentials,
        "scopes": Value::Object(scopes),
        "appSettings": app_settings,
    }))
}

fn build_app_settings(frontend_segment: Option<&Value>) -> Value {
    let mut settings = match frontend_segment {
        Some(Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    };

    // 后端来源：更新代理。后端是**权威来源**（前端段即便带同名键也会被覆盖）。
    let github = update::load_github_config();
    if let Some(proxy) = github.get("proxy").and_then(Value::as_str) {
        if !proxy.trim().is_empty() {
            settings.insert("updateProxy".to_string(), json!(proxy));
        }
    }

    let mut value = Value::Object(settings);
    redact_url_userinfo_in(&mut value);
    value
}

// ---------------------------------------------------------------------------
// 导入：预览（安全阀）→ 快照（D18）→ 合并 → 汇总（部分失败态）
// ---------------------------------------------------------------------------

/// 全选 selection（4 作用域 × 3 分区 + 含凭据）：本地快照 / 定时备份用。
///
/// ⚠️ `includes_credentials = true`：本地快照必须**全量保真**（撤销导入要还原 token）。
fn full_selection() -> BackupSelection {
    BackupSelection {
        includes_credentials: true,
        ..Default::default()
    }
}

pub fn preview_import_backup(text: &str, policy: ConflictPolicy) -> Result<Value, String> {
    let envelope = parse_envelope(text)?;
    let format_version = envelope
        .get("formatVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let exported_at = envelope
        .get("exportedAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let includes_credentials = envelope
        .get("includesCredentials")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut rows: Vec<Value> = Vec::new();
    let mut need_relogin = 0usize;
    let mut config_overwrites: Vec<String> = Vec::new();

    for (scope_key, scope_value) in envelope_scopes(&envelope) {
        let scope = match resolve_scope_key(&scope_key) {
            Ok(scope) => scope,
            Err(error) => {
                rows.push(json!({
                    "scope": scope_key,
                    "added": 0, "overwritten": 0, "skipped": 0, "conflicts": 0,
                    "rejected": true,
                    "error": error,
                }));
                continue;
            }
        };
        let mut counts = SectionCounts::default();
        for spec in backup_sections() {
            let Some(incoming) = scope_value.get(spec.id) else {
                continue;
            };
            // 只读本地（**不写盘**）；在副本上 dry-run 合并。
            let mut local = (spec.read)(scope)?;
            if spec.id == "config" {
                config_overwrites.extend(overwritten_config_keys(&local, incoming, policy));
            }
            if spec.id == "accounts" {
                need_relogin += count_needs_relogin(incoming);
            }
            let section = (spec.merge)(&mut local, incoming, policy);
            counts.added += section.added;
            counts.overwritten += section.overwritten;
            counts.skipped += section.skipped;
            counts.conflicts += section.conflicts;
        }
        rows.push(json!({
            "scope": scope_key,
            "added": counts.added,
            "overwritten": counts.overwritten,
            "skipped": counts.skipped,
            "conflicts": counts.conflicts,
            "rejected": false,
        }));
    }

    config_overwrites.sort();
    config_overwrites.dedup();

    Ok(json!({
        "formatVersion": format_version,
        "exportedAt": exported_at,
        "includesCredentials": includes_credentials,
        "scopes": rows,
        "configOverwrites": config_overwrites,
        "needRelogin": need_relogin,
    }))
}

pub fn import_backup(
    text: &str,
    policy: ConflictPolicy,
    selection: &BackupSelection,
    only_scopes: &[String],
) -> Result<Value, String> {
    let envelope = parse_envelope(text)?;

    let snapshot_path = snapshot_before_import()?;

    restore_update_proxy(&envelope);

    let mut per_scope: Vec<Value> = Vec::new();
    let mut retryable_scopes: Vec<String> = Vec::new();
    let mut failed = 0usize;

    for (scope_key, scope_value) in envelope_scopes(&envelope) {
        // 「只重试失败项」：不在名单里的 scope **整段跳过**（含未知 scope —— 重试
        // 一个键名非法的分区没有意义，它不是「暂时失败」而是「永远无法导入」）。
        if !only_scopes.is_empty() && !only_scopes.iter().any(|key| key == &scope_key) {
            continue;
        }

        let scope = match resolve_scope_key(&scope_key) {
            Ok(scope) => scope,
            Err(error) => {
                failed += 1;
                // ⚠️ **不可重试**：键名非法是来件的结构性缺陷，重试同一个文件必然
                // 再失败一次。此前这里与合并失败一样 `retryable += 1`，导致前端把
                // 「重试必然失败」的分区也塞进重试名单（假出口）。
                per_scope.push(json!({
                    "scope": scope_key,
                    "added": 0, "overwritten": 0, "skipped": 0, "conflicts": 0,
                    "error": error,
                    "retryable": false,
                }));
                continue;
            }
        };

        // 逐 scope 事务：读 → 合并 → 写。任一步失败 ⇒ 该 scope 计入失败，不影响其余 scope。
        let merged: Result<SectionCounts, String> = (|| {
            let mut counts = SectionCounts::default();
            for spec in backup_sections() {
                let Some(incoming) = scope_value.get(spec.id) else {
                    continue;
                };
                if !wanted_section(selection, &scope_key, spec.id) {
                    continue;
                }
                let mut local = (spec.read)(scope)?;
                let section = (spec.merge)(&mut local, incoming, policy);
                (spec.write)(scope, &local)?;
                counts.added += section.added;
                counts.overwritten += section.overwritten;
                counts.skipped += section.skipped;
                counts.conflicts += section.conflicts;
            }
            Ok(counts)
        })();

        match merged {
            Ok(counts) => per_scope.push(json!({
                "scope": scope_key,
                "added": counts.added,
                "overwritten": counts.overwritten,
                "skipped": counts.skipped,
                "conflicts": counts.conflicts,
                "retryable": false,
            })),
            Err(error) => {
                failed += 1;
                retryable_scopes.push(scope_key.clone());
                per_scope.push(json!({
                    "scope": scope_key,
                    "added": 0, "overwritten": 0, "skipped": 0, "conflicts": 0,
                    "error": error,
                    "retryable": true,
                }));
            }
        }
    }

    Ok(json!({
        "perScope": per_scope,
        "failed": failed,
        // 与 `retryableScopes` 同义（前端读后者即可拿到要回传的具体 id）。
        "retryable": retryable_scopes.len(),
        "retryableScopes": retryable_scopes,
        "snapshotPath": snapshot_path,
    }))
}

// ---------------------------------------------------------------------------
// 快照 / 定时备份 / 恢复（D17 / D18）
// ---------------------------------------------------------------------------

pub fn snapshot_before_import() -> Result<String, String> {
    let envelope = build_envelope(&full_selection(), true)?;
    let name = config::pre_import_snapshot_file_name(&now_compact_stamp());
    let path = config::backup_dir().join(&name);
    write_envelope_file(&path, &envelope)?;
    config::prune_managed_backups(config::AUTO_BACKUP_KEEP);
    Ok(path.to_string_lossy().into_owned())
}

pub fn auto_backup() -> Result<String, String> {
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let path = config::backup_dir().join(config::auto_backup_file_name(&date));
    if path.exists() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let envelope = build_envelope(&full_selection(), true)?;
    write_envelope_file(&path, &envelope)?;
    config::prune_managed_backups(config::AUTO_BACKUP_KEEP);
    Ok(path.to_string_lossy().into_owned())
}

/// 列出保留集里的自动备份 / 导入前快照（**最新在前**）。
pub fn list_auto_backups() -> Result<Value, String> {
    let items: Vec<Value> = config::managed_backup_files()
        .into_iter()
        .rev()
        .map(|path| backup_file_entry(&path))
        .collect();
    Ok(json!({ "backups": items }))
}

/// 从自动备份 / 导入前快照**恢复**（冲突策略 = 覆盖）。
///
/// 恢复本身也**先快照**（由 [`import_backup`] 保证）⇒ 恢复动作可撤销；且只有**受管**备份
/// （自动备份 / 导入前快照，且是裸文件名）可被恢复 —— 恢复入口不得被用来读任意文件。
pub fn restore_auto_backup(file_name: &str) -> Result<Value, String> {
    let path = resolve_managed_backup_path(file_name)?;
    let text =
        std::fs::read_to_string(&path).map_err(|error| format!("读取备份文件失败：{error}"))?;
    // 恢复是**整份**恢复（不是重试）⇒ 传空名单 = 全量导入。
    import_backup(&text, ConflictPolicy::Overwrite, &full_selection(), &[])
}

// ---------------------------------------------------------------------------
// 导入 / 快照辅助
// ---------------------------------------------------------------------------

/// envelope 的 `scopes` 段（缺 / 非对象 ⇒ 空）。
fn envelope_scopes(envelope: &Value) -> Vec<(String, Value)> {
    envelope
        .get("scopes")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// 该分区在本次导入里是否被选中（缺省 ⇒ 全选，D14）。
fn wanted_section(selection: &BackupSelection, scope_key: &str, section_id: &str) -> bool {
    match selection.scopes.get(scope_key) {
        Some(selected) => selected.wants(section_id),
        None => true,
    }
}

fn restore_update_proxy(envelope: &Value) {
    let Some(proxy) = envelope
        .get("appSettings")
        .and_then(|settings| settings.get("updateProxy"))
        .and_then(Value::as_str)
    else {
        return;
    };
    if proxy.trim().is_empty() {
        return;
    }
    let mut config = update::load_github_config();
    if let Some(object) = config.as_object_mut() {
        object.insert("proxy".to_string(), json!(proxy));
    }
    let _ = update::save_github_config(&config);
}

/// 按策略列出「将被覆盖」的配置项（来件与本地都有的顶层键）。
///
/// 只在**覆盖类**策略下非空：`KeepLocal`（默认）下不覆盖任何配置项，列出来反而误导。
fn overwritten_config_keys(local: &Value, incoming: &Value, policy: ConflictPolicy) -> Vec<String> {
    if !matches!(policy, ConflictPolicy::Overwrite | ConflictPolicy::KeepBoth) {
        return Vec::new();
    }
    let (Some(local_map), Some(incoming_map)) = (local.as_object(), incoming.as_object()) else {
        return Vec::new();
    };
    incoming_map
        .keys()
        .filter(|key| local_map.contains_key(*key))
        .cloned()
        .collect()
}

/// 统计来件里「无明文凭据、导入后需重新登录」的账号数。
fn count_needs_relogin(incoming: &Value) -> usize {
    incoming
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| record_needs_relogin(item))
                .count()
        })
        .unwrap_or(0)
}

/// 该账号记录是否**缺明文凭据**（WorkBuddy `access_token` / `refresh_token`，Trae `jwt`）。
///
/// 与 [`CREDENTIAL_KEYS`] 同源（取其中**承载实际令牌**的三个键）：命中任一非空串即视为
/// 「自带凭据」，否则导入后需重新登录。
fn record_needs_relogin(item: &Value) -> bool {
    !["access_token", "refresh_token", "jwt"].iter().any(|key| {
        item.get(*key)
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    })
}

/// 组装一条备份文件条目（文件名 / 路径 / 大小 / 修改时间 / 类别）。
fn backup_file_entry(path: &std::path::Path) -> Value {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let meta = std::fs::metadata(path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified_at = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let kind = if name.starts_with(config::AUTO_BACKUP_PREFIX) {
        "auto"
    } else if name.starts_with(config::PRE_IMPORT_SNAPSHOT_PREFIX) {
        "preImport"
    } else {
        "other"
    };
    json!({
        "fileName": name,
        "path": path.to_string_lossy(),
        "sizeBytes": size,
        "modifiedAt": modified_at,
        "kind": kind,
    })
}

/// 把「文件名」解析成 `backup_dir()` 里的**受管**备份路径（**防目录穿越**）。
///
/// 只接受**裸文件名**（不含 `/`、`\`、`..`）且必须属于保留集（自动备份 / 导入前快照）。
/// 拒绝一切绝对路径 / 相对路径 / 越权文件名 —— 恢复入口不得被用来读任意文件。
fn resolve_managed_backup_path(file_name: &str) -> Result<std::path::PathBuf, String> {
    let name = file_name.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !config::is_managed_backup_name(name)
    {
        return Err("备份文件名不合法".to_string());
    }
    let path = config::backup_dir().join(name);
    if !path.is_file() {
        return Err(format!("备份文件不存在：{name}"));
    }
    Ok(path)
}

/// 原子写一份 envelope 到指定文件（自动建目录）。
fn write_envelope_file(path: &std::path::Path, envelope: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        config::ensure_private_dir(parent).map_err(|error| format!("创建备份目录失败：{error}"))?;
    }
    let text = serde_json::to_string_pretty(envelope).map_err(|error| error.to_string())?;
    config::atomic_write(path, &text).map_err(|error| format!("写入备份文件失败：{error}"))
}

/// 紧凑时间戳（UTC，秒精度，文件名安全）：`20261004T120000Z`。
fn now_compact_stamp() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

/// 当前时间的 RFC 3339（UTC，秒精度）：`2026-10-01T14:00:00Z`。
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn strip_credentials(value: &mut Value, include_credentials: bool) {
    match value {
        Value::Object(map) => {
            if map.contains_key("$wbEncrypted") {
                // 信封整体剥离（含密文 `envelope`）。
                *value = Value::Null;
                return;
            }
            if include_credentials {
                // 明文凭据保留；信封标记（保险）剔除。
                map.remove("$wbEncrypted");
            } else {
                for key in CREDENTIAL_KEYS {
                    map.remove(*key);
                }
            }
            for (_, child) in map.iter_mut() {
                strip_credentials(child, include_credentials);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                strip_credentials(item, include_credentials);
            }
        }
        _ => {}
    }
}

/// 递归剥离字符串里的 URL 用户信息段（`user:pass@`）。
fn redact_url_userinfo_in(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (_, child) in map.iter_mut() {
                redact_url_userinfo_in(child);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                redact_url_userinfo_in(item);
            }
        }
        Value::String(text) => {
            let redacted = redact_url_userinfo(text);
            if redacted != *text {
                *text = redacted;
            }
        }
        _ => {}
    }
}

/// 剥离 URL 里的 `user:pass@`（代理认证）。
///
/// 只处理 `scheme://` 之后、路径 / 查询 / 片段之前的 **authority** 段：该段若含 `@`，
/// `@` 之前即凭据。非 URL（无 `://`）或 authority 无 `@` ⇒ 原样返回。
fn redact_url_userinfo(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let after_scheme = scheme_end + 3;
    let rest = &url[after_scheme..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    match authority.rfind('@') {
        Some(at) => format!(
            "{}{}{}",
            &url[..after_scheme],
            &authority[at + 1..],
            &rest[authority_end..]
        ),
        None => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一条带**真实键**（snake_case）凭据 + 加密信封的账号记录。
    fn account_with_credentials() -> Value {
        json!({
            "id": "a1",
            "uid": "u1",
            "nickname": { "$wbEncrypted": 1, "envelope": "SECRET-ENVELOPE" },
            "access_token": "PLAIN-ACCESS",
            "refresh_token": "PLAIN-REFRESH",
            "auth_raw": { "accessToken": "NESTED-CAMEL", "refreshToken": "NESTED-CAMEL-R" },
            "createdAt": 1,
        })
    }

    #[test]
    fn strip_credentials_removes_every_credential_key_recursively() {
        let mut value = json!({
            "accounts": [account_with_credentials()],
            // Trae 账号：凭据键是 `jwt`（`Cloud-IDE-JWT`）—— 必须同样被剥离，否则换机备份泄露。
            "trae": [{ "uid": "t1", "jwt": "PLAIN-JWT", "refresh_token": "T-REFRESH" }],
        });
        strip_credentials(&mut value, false);
        let text = serde_json::to_string(&value).unwrap();

        assert_eq!(
            contains_credential_key(&text),
            None,
            "剥离后仍能搜到凭据键：{text}"
        );
        // 非凭据字段必须**保留**（不能「无脑全清」）。
        assert_eq!(value["accounts"][0]["uid"], json!("u1"));
        assert_eq!(value["accounts"][0]["createdAt"], json!(1));
        assert_eq!(value["trae"][0]["uid"], json!("t1"));
        // 信封整体剥离 ⇒ nickname 为 null，密文不再出现。
        assert_eq!(value["accounts"][0]["nickname"], Value::Null);
        assert!(
            !text.contains("SECRET-ENVELOPE"),
            "信封密文不得残留：{text}"
        );
        assert!(!text.contains("PLAIN-ACCESS"), "明文 access_token 不得残留");
        assert!(!text.contains("PLAIN-JWT"), "Trae jwt 不得残留：{text}");
    }

    #[test]
    fn camel_case_only_search_would_miss_snake_case_leak() {
        // 构造一份**故意没剥离**的文本（模拟「导出漏剥」的缺陷态）。
        let leaked = serde_json::to_string(&json!({
            "accounts": [{ "access_token": "PLAIN-ACCESS", "refresh_token": "PLAIN-REFRESH" }]
        }))
        .unwrap();
        // 旧判据（只搜 camelCase）⇒ 抓不到（假阴性）。
        assert!(
            !leaked.contains("accessToken"),
            "旧判据抓不到 snake_case 泄露"
        );
        // 新判据（CREDENTIAL_KEYS 含真实键）⇒ 抓到。
        assert_eq!(contains_credential_key(&leaked), Some("access_token"));
    }

    #[test]
    fn include_credentials_keeps_plaintext_but_still_strips_envelope() {
        let mut value = json!({ "accounts": [account_with_credentials()] });
        strip_credentials(&mut value, true);
        let text = serde_json::to_string(&value).unwrap();
        assert_eq!(value["accounts"][0]["access_token"], json!("PLAIN-ACCESS"));
        assert_eq!(
            value["accounts"][0]["refresh_token"],
            json!("PLAIN-REFRESH")
        );
        assert_eq!(
            value["accounts"][0]["nickname"],
            Value::Null,
            "信封必须剥离"
        );
        assert!(!text.contains("$wbEncrypted"), "信封标记不得残留：{text}");
        assert!(!text.contains("SECRET-ENVELOPE"), "信封密文不得残留");
    }

    #[test]
    fn redact_url_userinfo_strips_proxy_credentials_only() {
        assert_eq!(
            redact_url_userinfo("http://user:pass@host:8080"),
            "http://host:8080"
        );
        assert_eq!(
            redact_url_userinfo("https://alice:secret@proxy.example.com/path?x=1"),
            "https://proxy.example.com/path?x=1"
        );
        // 无凭据 / 非 URL ⇒ 原样。
        assert_eq!(redact_url_userinfo("http://host:8080"), "http://host:8080");
        assert_eq!(
            redact_url_userinfo("socks5://127.0.0.1:1080"),
            "socks5://127.0.0.1:1080"
        );
        assert_eq!(redact_url_userinfo("not a url"), "not a url");
    }

    #[test]
    fn redact_url_userinfo_in_walks_nested_strings() {
        let mut value = json!({
            "updateProxy": "http://user:pass@host:8080",
            "nested": { "list": ["http://a:b@c", "plain"] },
        });
        redact_url_userinfo_in(&mut value);
        assert_eq!(value["updateProxy"], json!("http://host:8080"));
        assert_eq!(value["nested"]["list"][0], json!("http://c"));
        assert_eq!(value["nested"]["list"][1], json!("plain"));
    }

    #[test]
    fn parse_envelope_rejects_missing_or_wrong_kind() {
        assert!(parse_envelope("").is_err());
        assert!(parse_envelope("not json").is_err());
        assert!(parse_envelope("[]").is_err());
        assert!(parse_envelope(r#"{"formatVersion":1}"#).is_err(), "缺 kind");
        let wrong = r#"{"kind":"something-else","formatVersion":1}"#;
        assert!(parse_envelope(wrong).is_err(), "kind 不匹配必须拒绝");
    }

    /// `formatVersion` 是唯一兼容依据：`> 上限` 拒绝 + 提示升级；缺 ⇒ 拒绝。
    #[test]
    fn parse_envelope_version_is_fail_closed() {
        assert!(
            parse_envelope(r#"{"kind":"buddy-switch-backup"}"#).is_err(),
            "缺版本"
        );
        let too_new = r#"{"kind":"buddy-switch-backup","formatVersion":2}"#;
        let error = parse_envelope(too_new).unwrap_err();
        assert!(error.contains("升级"), "应提示升级：{error}");

        let ok = parse_envelope(r#"{"kind":"buddy-switch-backup","formatVersion":1}"#);
        assert!(ok.is_ok());
    }

    #[test]
    fn parse_envelope_reports_readable_error_for_corrupted_file() {
        // 各类损坏形态：空 / 空白 / 截断 / 非法 JSON / 非对象标量。
        for broken in [
            "",
            "   ",
            "{",
            "{\"kind\":",
            "[1,2",
            "123",
            "null",
            "not json",
        ] {
            let error = parse_envelope(broken)
                .expect_err(&format!("损坏文件必须报错而不是崩溃：{broken:?}"));
            assert!(!error.is_empty(), "损坏文件必须给可读错误：{broken:?}");
        }
        // 错误信息应能让人看懂（指明 JSON 解析失败 / 内容为空 / 应为对象），而不是一句 panic。
        assert!(
            parse_envelope("{").unwrap_err().contains("JSON"),
            "非法 JSON 的错误应指明 JSON 解析失败"
        );
        assert!(
            parse_envelope("   ").unwrap_err().contains("空"),
            "空文件应提示内容为空"
        );
        assert!(
            parse_envelope("123").unwrap_err().contains("对象"),
            "非对象 JSON 应提示「应为对象」"
        );
    }

    #[test]
    fn migrate_envelope_only_handles_current_version() {
        let value = json!({"kind": BACKUP_KIND, "formatVersion": 1});
        assert_eq!(migrate_envelope(value.clone(), 1).unwrap(), value);
        assert!(
            migrate_envelope(value, 0).is_err(),
            "无历史版本可迁 ⇒ Err（不空转）"
        );
    }

    #[test]
    fn unknown_scope_keys_lists_unparseable_scope_keys() {
        let envelope = json!({ "scopes": { "wb-cn": {}, "foo-cn": {}, "trae-glboal": {} } });
        let mut unknown = unknown_scope_keys(&envelope);
        unknown.sort();
        assert_eq!(
            unknown,
            vec!["foo-cn".to_string(), "trae-glboal".to_string()]
        );
        assert!(resolve_scope_key("wb-cn").is_ok());
        assert!(resolve_scope_key("foo-cn").is_err());
    }

    #[test]
    fn export_backup_covers_all_scopes() {
        let home = isolated_home("scopes");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let selection = BackupSelection::default();
        let envelope = export_backup(&selection).expect("导出应成功");
        let scopes = envelope["scopes"].as_object().expect("scopes 应为对象");
        assert_eq!(
            scopes.len(),
            6,
            "必须 6/6 覆盖（3 平台 × 2 区域）：{envelope}"
        );
        for scope in Scope::all() {
            assert!(
                scopes.contains_key(scope.as_str()),
                "缺作用域 {}",
                scope.as_str()
            );
        }
        assert_eq!(envelope["kind"], json!(BACKUP_KIND));
        assert_eq!(envelope["formatVersion"], json!(SUPPORTED_FORMAT_VERSION));
        assert_eq!(envelope["includesCredentials"], json!(false));

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn export_backup_output_is_credential_free() {
        let home = isolated_home("export");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        // 种入带凭据的 WorkBuddy CN 账号（明文 snake_case + 加密信封 + camelCase 嵌套）。
        crate::modules::account::save_accounts_for(
            crate::modules::region::Region::Cn,
            &[account_with_credentials()],
        )
        .expect("seed accounts");

        let envelope = export_backup(&BackupSelection::default()).expect("导出应成功");
        let text = serde_json::to_string(&envelope).unwrap();

        assert!(
            text.contains("\"u1\""),
            "账号 uid 应出现在导出里，否则本条断言恒真（假阴性）：{text}"
        );
        assert!(
            !text.contains("SECRET-ENVELOPE"),
            "信封密文不得残留：{text}"
        );

        assert_eq!(
            contains_credential_key(&text),
            None,
            "导出文本仍能搜到凭据键：{text}"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 未勾选任何分区的作用域 ⇒ envelope 里该 scope 为空对象（键仍在，4/4 不破）。
    #[test]
    fn export_backup_respects_empty_scope_selection() {
        let home = isolated_home("empty-scope");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let mut selection = BackupSelection::default();
        let empty = ScopeSelection::default();
        selection.scopes.insert("trae-global".to_string(), empty);
        let envelope = export_backup(&selection).expect("导出应成功");
        assert_eq!(envelope["scopes"]["trae-global"], json!({}));
        // 其余作用域默认全选。
        assert!(envelope["scopes"]["wb-cn"]
            .as_object()
            .unwrap()
            .contains_key("accounts"));

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── T02 · 导入 / 预览 / 快照 / 定时备份 ──────────────────────────────────────

    /// 造一份「单账号」备份文本（wb-cn · accounts），用于导入编排测试。
    fn backup_text_with_account(uid: &str, nickname: &str, token: Option<&str>) -> String {
        let mut account = json!({ "id": format!("id-{uid}"), "uid": uid, "nickname": nickname });
        if let Some(token) = token {
            account["access_token"] = json!(token);
        }
        json!({
            "kind": BACKUP_KIND,
            "formatVersion": SUPPORTED_FORMAT_VERSION,
            "includesCredentials": token.is_some(),
            "scopes": { "wb-cn": { "accounts": [account] } },
        })
        .to_string()
    }

    #[test]
    fn import_backup_is_idempotent_with_default_policy() {
        let home = isolated_home("idempotent");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let text = backup_text_with_account("u1", "甲", Some("tok"));
        let selection = BackupSelection::default();

        let first = import_backup(&text, ConflictPolicy::KeepLocal, &selection, &[])
            .expect("首次导入应成功");
        assert_eq!(first["failed"], json!(0), "{first}");

        let second = import_backup(&text, ConflictPolicy::KeepLocal, &selection, &[])
            .expect("二次导入应成功");
        let rows = second["perScope"].as_array().unwrap();
        let wb_cn = rows.iter().find(|row| row["scope"] == "wb-cn").unwrap();
        assert_eq!(wb_cn["added"], json!(0), "第二次不得新增（幂等）：{second}");
        assert_eq!(wb_cn["skipped"], json!(1), "第二次应全部跳过：{second}");
        assert_eq!(
            crate::modules::account::load_accounts_for(crate::modules::region::Region::Cn).len(),
            1,
            "连导两次不得产生重复账号"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn import_backup_rejects_unknown_scope_fail_closed() {
        let home = isolated_home("unknown-scope");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let text = json!({
            "kind": BACKUP_KIND,
            "formatVersion": SUPPORTED_FORMAT_VERSION,
            "includesCredentials": true,
            "scopes": {
                "wb-cn": { "accounts": [{ "id": "x", "uid": "u", "nickname": "n", "access_token": "t" }] },
                "foo-cn": { "accounts": [{ "id": "y", "uid": "v", "nickname": "m", "access_token": "t" }] },
                // 真实世界的拼写错例（`global` 拼成 `glboal`）—— 必须同样被拒。
                "trae-glboal": { "accounts": [{ "id": "z", "uid": "w", "nickname": "k", "access_token": "t" }] },
            }
        })
        .to_string();

        let summary = import_backup(
            &text,
            ConflictPolicy::KeepLocal,
            &BackupSelection::default(),
            &[],
        )
        .unwrap();
        assert_eq!(
            summary["failed"],
            json!(2),
            "两个未知 scope 必须计入失败：{summary}"
        );
        let rows = summary["perScope"].as_array().unwrap();
        for bad_scope in ["foo-cn", "trae-glboal"] {
            let bad = rows.iter().find(|row| row["scope"] == bad_scope).unwrap();
            assert!(
                bad["error"].as_str().is_some(),
                "未知 scope {bad_scope} 必须报错、不得静默跳过：{summary}"
            );
        }
        // 已知 scope 照常导入（部分失败态）。
        let good = rows.iter().find(|row| row["scope"] == "wb-cn").unwrap();
        assert_eq!(good["added"], json!(1), "已知 scope 应照常导入：{summary}");
        assert_eq!(
            summary["retryable"],
            json!(0),
            "未知 scope 不该计入可重试（重试同一个坏键名必然再失败）：{summary}"
        );
        assert!(
            summary["retryableScopes"].as_array().unwrap().is_empty(),
            "未知 scope 不得进重试名单：{summary}"
        );
        for bad_scope in ["foo-cn", "trae-glboal"] {
            let bad = rows.iter().find(|row| row["scope"] == bad_scope).unwrap();
            assert_eq!(
                bad["retryable"],
                json!(false),
                "未知 scope {bad_scope} 必须标为不可重试：{summary}"
            );
        }
        assert_eq!(
            crate::modules::account::load_accounts_for(crate::modules::region::Region::Cn).len(),
            1,
            "未知 scope 的记录不得回落到已知 scope：{summary}"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn import_backup_retry_only_touches_listed_scopes_and_snapshots() {
        let home = isolated_home("retry-scopes");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let text = json!({
            "kind": BACKUP_KIND,
            "formatVersion": SUPPORTED_FORMAT_VERSION,
            "includesCredentials": true,
            "scopes": {
                "wb-cn": { "accounts": [{ "id": "x", "uid": "u", "nickname": "n", "access_token": "t" }] },
                "trae-cn": { "accounts": [{ "id": "y", "uid": "v", "nickname": "m", "access_token": "t" }] },
                // 一个**永远失败**的分区：不在重试名单里，就必须被无视。
                "foo-cn": { "accounts": [{ "id": "z", "uid": "w", "nickname": "k", "access_token": "t" }] },
            }
        })
        .to_string();

        let summary = import_backup(
            &text,
            ConflictPolicy::KeepLocal,
            &BackupSelection::default(),
            &["trae-cn".to_string()],
        )
        .unwrap();

        let rows = summary["perScope"].as_array().unwrap();
        assert_eq!(
            rows.len(),
            1,
            "重试只应处理名单内的 scope，实际处理了 {:?}",
            rows.iter()
                .map(|r| r["scope"].as_str().unwrap())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            rows[0]["scope"],
            json!("trae-cn"),
            "只应重跑 trae-cn：{summary}"
        );
        assert_eq!(
            summary["failed"],
            json!(0),
            "名单外的坏分区不该让重试失败：{summary}"
        );
        // wb-cn 未被本次重试触碰（名单外 ⇒ 整段跳过）。
        assert!(
            !rows.iter().any(|row| row["scope"] == "wb-cn"),
            "名单外的 wb-cn 不得被重试处理：{summary}"
        );
        let snapshot = summary["snapshotPath"].as_str().unwrap_or_default();
        assert!(
            snapshot.contains("pre-import-"),
            "重试必须同样产生导入前快照（可撤销），实际：{snapshot}"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn preview_import_backup_does_not_write() {
        let home = isolated_home("preview");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let text = backup_text_with_account("u1", "甲", Some("tok"));
        let preview = preview_import_backup(&text, ConflictPolicy::KeepLocal).unwrap();
        assert_eq!(preview["formatVersion"], json!(SUPPORTED_FORMAT_VERSION));
        assert_eq!(
            preview["needRelogin"],
            json!(0),
            "带凭据 ⇒ 无需重新登录：{preview}"
        );

        assert!(
            crate::modules::account::load_accounts_for(crate::modules::region::Region::Cn)
                .is_empty(),
            "预览不得写盘"
        );
        assert!(
            config::managed_backup_files().is_empty(),
            "预览不得产生备份文件"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn preview_counts_need_relogin_for_credential_free_accounts() {
        let home = isolated_home("relogin");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let text = json!({
            "kind": BACKUP_KIND,
            "formatVersion": SUPPORTED_FORMAT_VERSION,
            "includesCredentials": false,
            "scopes": { "wb-cn": { "accounts": [
                { "id": "a", "uid": "u1", "nickname": "甲" },
                { "id": "b", "uid": "u2", "nickname": "乙" },
                { "id": "c", "uid": "u3", "nickname": "丙", "access_token": "tok" },
            ] } }
        })
        .to_string();

        let preview = preview_import_backup(&text, ConflictPolicy::KeepLocal).unwrap();
        assert_eq!(preview["includesCredentials"], json!(false));
        assert_eq!(
            preview["needRelogin"],
            json!(2),
            "两个无凭据账号需重新登录：{preview}"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn import_backup_snapshots_before_writing() {
        let home = isolated_home("snapshot");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let text = backup_text_with_account("u1", "甲", Some("tok"));
        let summary = import_backup(
            &text,
            ConflictPolicy::KeepLocal,
            &BackupSelection::default(),
            &[],
        )
        .unwrap();
        let snapshot = summary["snapshotPath"].as_str().expect("必须返回快照路径");
        let path = std::path::Path::new(snapshot);
        assert!(path.is_file(), "导入前必须产生快照：{snapshot}");
        assert!(
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(config::PRE_IMPORT_SNAPSHOT_PREFIX))
                .unwrap_or(false),
            "快照文件名前缀应为导入前快照：{snapshot}"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `TokenPolicy::Allow`：**无凭据**账号（`includesCredentials=false`）也能导入。
    ///
    /// 可证伪：若全局导入误用 `Require`（账号级语义）⇒ 无 token 记录被跳过 ⇒ added=0 ⇒ 变红。
    #[test]
    fn import_backup_accepts_records_without_credentials() {
        let home = isolated_home("no-creds");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let text = backup_text_with_account("u1", "甲", None);
        let summary = import_backup(
            &text,
            ConflictPolicy::KeepLocal,
            &BackupSelection::default(),
            &[],
        )
        .unwrap();
        let rows = summary["perScope"].as_array().unwrap();
        let wb_cn = rows.iter().find(|row| row["scope"] == "wb-cn").unwrap();
        assert_eq!(
            wb_cn["added"],
            json!(1),
            "无凭据账号必须能导入（Allow）：{summary}"
        );
        assert_eq!(
            crate::modules::account::load_accounts_for(crate::modules::region::Region::Cn).len(),
            1
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `ConflictPolicy::Overwrite`：命中同 uid ⇒ 覆盖本地（区别于默认的保留本地）。
    #[test]
    fn import_backup_overwrite_policy_replaces_local() {
        let home = isolated_home("overwrite");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let local =
            json!([{ "id": "local", "uid": "u1", "nickname": "本地", "access_token": "t" }]);
        crate::modules::account::save_accounts_for(
            crate::modules::region::Region::Cn,
            &[local[0].clone()],
        )
        .expect("seed");

        let text = backup_text_with_account("u1", "导入", Some("tok-new"));
        let summary = import_backup(
            &text,
            ConflictPolicy::Overwrite,
            &BackupSelection::default(),
            &[],
        )
        .unwrap();
        let rows = summary["perScope"].as_array().unwrap();
        let wb_cn = rows.iter().find(|row| row["scope"] == "wb-cn").unwrap();
        assert_eq!(wb_cn["overwritten"], json!(1), "覆盖策略应覆盖：{summary}");

        let accounts =
            crate::modules::account::load_accounts_for(crate::modules::region::Region::Cn);
        assert_eq!(accounts.len(), 1, "覆盖不得增行");
        assert_eq!(accounts[0]["nickname"], json!("导入"));

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 定时备份（D17）：**同日幂等**（同一文件），且写进 `backup_dir()`。
    #[test]
    fn auto_backup_is_daily_idempotent() {
        let home = isolated_home("auto");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let first = auto_backup().expect("自动备份应成功");
        let second = auto_backup().expect("自动备份应成功");
        assert_eq!(first, second, "同日自动备份应幂等（同一文件）");
        assert!(std::path::Path::new(&first).is_file());
        assert_eq!(config::managed_backup_files().len(), 1);

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 保留策略（D17）：超过 7 份删最旧；**手动导出**的文件不进保留集。
    #[test]
    fn prune_managed_backups_keeps_newest_seven_and_spares_manual_exports() {
        let home = isolated_home("retention");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let dir = config::backup_dir();
        std::fs::create_dir_all(&dir).expect("create backup dir");
        for index in 0..10 {
            let name = format!(
                "{}2026-01-{:02}.json",
                config::AUTO_BACKUP_PREFIX,
                index + 1
            );
            std::fs::write(dir.join(name), "{}").expect("seed managed backup");
        }
        // 手动导出（非受管前缀）—— 不得被清理。
        std::fs::write(dir.join("manual-export.json"), "{}").expect("seed manual export");

        let removed = config::prune_managed_backups(config::AUTO_BACKUP_KEEP);
        assert_eq!(removed, 3, "10 份保留 7 份应删 3");
        assert_eq!(config::managed_backup_files().len(), 7, "保留集应剩 7 份");
        assert!(
            dir.join("manual-export.json").exists(),
            "手动导出不进保留集"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 恢复入口**防目录穿越**：只接受受管的裸文件名（拒绝相对 / **绝对** / 越权路径）。
    #[test]
    fn restore_auto_backup_rejects_path_traversal() {
        let home = isolated_home("traversal");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        for bad in [
            "../secrets.json",
            "a/b.json",
            "a\\b.json",
            "",
            "random.json",
            // 绝对路径（POSIX / Windows）—— 恢复入口不得被用来读任意文件。
            "/etc/passwd",
            "C:\\Windows\\win.ini",
            // 反斜杠穿越。
            "..\\..\\evil.json",
            // 受管前缀夹带穿越（前缀骗不过分隔符 / `..` 检查）。
            "auto-backup-2026-01-01.json/../../x.json",
        ] {
            assert!(
                restore_auto_backup(bad).is_err(),
                "非法恢复文件名必须拒绝：{bad:?}"
            );
        }

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn auto_backup_defaults_on_and_can_be_disabled() {
        let home = isolated_home("auto-toggle");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        assert!(config::is_auto_backup_enabled(), "定时备份默认应开启");

        // 关掉 ⇒ 标志变 false（宿主据此不再产生新备份）。
        config::save_auto_backup_config(&json!({ "enabled": false })).expect("保存配置");
        assert!(
            !config::is_auto_backup_enabled(),
            "关闭后必须为 false（用户能关）"
        );

        // 已产生的备份在关闭后**保留**（不追溯删除）。
        let produced = auto_backup().expect("自动备份应成功");
        assert!(std::path::Path::new(&produced).is_file());
        config::save_auto_backup_config(&json!({ "enabled": false })).expect("保存配置");
        assert!(
            std::path::Path::new(&produced).is_file(),
            "关闭定时备份不得追溯删除已产生的备份"
        );

        // 再开 ⇒ 恢复 true（开关可双向）。
        config::save_auto_backup_config(&json!({ "enabled": true })).expect("保存配置");
        assert!(config::is_auto_backup_enabled());

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn corrupted_backup_is_rejected_without_side_effects() {
        let home = isolated_home("corrupted");
        let _guard = crate::modules::config::HomeOverrideGuard::set(&home);

        let broken = "{\"kind\":\"buddy-switch-backup\",\"formatVersion\":1,\"scopes\":";
        assert!(
            preview_import_backup(broken, ConflictPolicy::KeepLocal).is_err(),
            "损坏文件的预览必须报错"
        );
        assert!(
            import_backup(
                broken,
                ConflictPolicy::KeepLocal,
                &BackupSelection::default(),
                &[]
            )
            .is_err(),
            "损坏文件的导入必须报错"
        );
        assert!(
            crate::modules::account::load_accounts_for(crate::modules::region::Region::Cn)
                .is_empty(),
            "损坏文件不得改动账号库"
        );
        assert!(
            config::managed_backup_files().is_empty(),
            "损坏文件不得产生快照"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 建一个隔离的临时 home（已存在），避免导出测试触碰真实用户数据。
    fn isolated_home(label: &str) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!(
            "buddy-switch-backup-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&home).expect("create isolated home");
        home
    }
}
