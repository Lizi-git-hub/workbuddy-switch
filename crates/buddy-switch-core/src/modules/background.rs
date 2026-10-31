
use std::time::Duration;

use crate::modules::product::Product;
use crate::modules::schedule::ScheduleTask;

/// WorkBuddy 账号池治理状态落盘周期。
///
/// 取值理由：`Pool::flush_if_dirty` 只在**有改动**时才真正写盘，所以这里定的是
/// 「最坏情况下最多丢多少治理状态」。30 秒足够短（冷却 / 熔断的时效是分钟级，
/// 丢 30 秒不会造成错误决策），又远长于一次请求。
pub const POOL_PERSIST_INTERVAL: Duration = Duration::from_secs(30);

/// 账号池**余额 / 积分**刷新周期。
///
/// 与 WorkBuddy 余额刷新的缺省间隔（30 分钟）一致：同一管理面不该有两种节奏。
/// ⚠️ WorkBuddy 侧实际等待时长由 `credits_refresh::next_refresh_wait_ms` 动态给出
/// （池为空 ⇒ 短探测），此常量只是**标称值**（见 [`TaskSpec::interval`]）。
pub const CREDITS_REFRESH_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// 定时备份的**检查**周期。
///
/// 取 1 小时：`backup::auto_backup()` 当日已备份时**幂等直接返回**（不重复读全量），
/// 故检查本身开销极低；小时级足以在跨日后尽快产生当日备份。
pub const AUTO_BACKUP_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 自动轮换的**检查**周期。
///
/// 真正的轮换间隔由 `auto_rotate_config.check_interval_minutes` 决定，本值只是
/// 「多久看一眼配置」的心跳。
pub const AUTO_ROTATE_CHECK_INTERVAL: Duration = Duration::from_secs(30);

pub const GATEWAY_USAGE_RECORD_INTERVAL: Duration = Duration::from_secs(2 * 60);

pub const CLIENT_USAGE_RECORD_INTERVAL: Duration = Duration::from_secs(2 * 60);

/// 后台任务的**种类**（L2）—— 与产品线（[`TaskSpec::product`]）**正交**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    /// 启动补跑：整理历史签到日志 + 签到核验 / 旅行派出领取 / 保活各跑一轮
    /// （**受各自排程开关约束**，关掉的任务一次都不跑）。
    StartupMaintenance,
    /// 自动轮换（按 `auto_rotate_config` 间隔；CodeBuddy CLI 为 CN 专有）。
    AutoRotate,
    /// 账号池**余额 / 积分刷新**（真实读数回填选号权重）。
    ///
    /// 二维化后**两产品共用此 kind**，由 [`TaskSpec::product`] 区分实现：
    /// - `(Workbuddy, CreditsRefresh)`：WorkBuddy 账号池余额刷新；
    /// - `(Trae, CreditsRefresh)`：Trae 两条国内产品线的积分刷新。
    ///
    /// 两者的**实现完全不同**（前者走 `gateway::shared_state` 的池，后者走
    /// `trae::credits` 的区域账号库），这正是「产品线」与「任务种类」是两个维度
    /// 而非一个扁平枚举的实证。
    CreditsRefresh,
    /// 账号池**治理状态落盘**（冷却 / 熔断 / 成功率 EMA / 余额读数）。
    ///
    /// 缺了它这些状态只在内存里，每次重启从零开始 —— 例如刚判定 `SessionDead`
    /// 的账号重启后立刻又被选中、再撞一次同样的墙。
    PoolPersist,
    /// **定时全局备份**（D17）：每日一份、保留 7 份、写 `backup_dir()`。
    ///
    /// **默认开**、但可在设置里关掉 —— 关闭后本任务不再产生新备份。
    AutoBackup,
    GatewayCatalogProbe,
    /// **网关用量「今日」快照**（2026-10-15 新增，缺陷修复）。
    ///
    /// 周期调用 `token_daily::record_gateway_today`，把 `gateway_logs.json` 聚合进
    /// `token_daily` 的 **gateway 桶**并落盘。由宿主侧遍历
    /// [`crate::modules::region::Region::all`] 覆盖**两个 region**（网关日志是单文件、
    /// 行内带 `region`，只记一个 region 会让另一个的历史永远空着）。
    ///
    /// ## 为什么必须有它（模块头那三类事故的同一形态）
    ///
    /// 「函数存在、类型全对、单测全绿，但生产上没有调用点」：`record_gateway_today`
    /// 此前唯一的调用点是账号页命令（`get_account_token_today` /
    /// `api_account_token_today`）⇒ 不进账号页就没人写 gateway 桶，
    /// `token_daily` 的 90 天保留窗里大片空洞，「网关用量进趋势图」永远缺原始素材。
    GatewayUsageRecord,
    /// **客户端（登录态）用量「今日」快照**（2026-10-15 新增，用户报障修复）。
    ///
    /// 周期调用 `token_daily::record_client_today(region, false)`，把客户端会话日志
    /// （`{data_dir}/projects` 下的 jsonl）的**今日**用量聚合进 `token_daily` 的
    /// **client 桶**并落盘。宿主侧遍历
    /// [`crate::modules::region::Region::all`] 覆盖**两个 region**（语料按区域分目录：
    /// CN = `.workbuddy/projects`，Global = `.workbuddy-ai/projects`）。
    ///
    /// ## 为什么必须有它（与 [`Self::GatewayUsageRecord`] 同一形态的事故）
    ///
    /// `record_client_today` 此前唯一的调用点是「打开账号页」的命令 ⇒ 不进账号页，
    /// 卡片「今日 Token」的 **client 列一直是旧值**（2026-10-15 用户报障：「client
    /// 数字不动」）。而 `gateway` 桶当天已有周期任务 ⇒ 同一张卡片的两个桶**一新一旧**，
    /// 用户看到的是自相矛盾的数字。
    ///
    /// ## ⚠️ 为什么与网关那条**分成两个 kind**（而不是合并进一个循环）
    ///
    /// 节奏相同、服务同一张卡片，但**失败面完全不同**：这条要读盘扫 jsonl（I/O 密集、
    /// 路径/权限都可能出问题），网关那条只读一份受 `log_keep` 封顶的日志。合并成一个
    /// 循环 ⇒ 客户端扫描一旦 panic，**网关记录会一起停摆**（tokio 任务 panic 只杀自己
    /// 那个循环）。分 kind = 天然隔离，且两条各自的「必须登记」护栏独立可读。
    ///
    /// `force = false`：走 `token_daily::CLIENT_SCAN_TTL_MS` 闸门。本循环周期与闸门同值，
    /// 闸门挡掉的只是「刚被账号页扫过」的重复轮次，不挡新鲜度。
    ClientUsageRecord,
    /// 八类积分定时任务之一（按 `schedule_config` 的小时表，各自独立排程）。
    Scheduled(ScheduleTask),
}

impl TaskKind {
    /// **种类级**稳定标识（供日志 / 诊断）：`startup_maintenance` / `credits_refresh` / …
    ///
    /// [`TaskKind::Scheduled`] 拼上定时任务标识（`scheduled:checkin`）。
    ///
    /// ⚠️ 本函数的返回值在**整张表**上**不保证**互不相同：[`TaskKind::CreditsRefresh`] 是
    /// **两个产品共用的同一 kind**（二维化的本意）⇒ 裸 kind 标签会重复（`credits_refresh`
    /// 出现两次）。**任务级**唯一标识请用 [`TaskSpec::label`]（`产品:种类`）。
    pub fn label(self) -> String {
        match self {
            TaskKind::StartupMaintenance => "startup_maintenance".to_string(),
            TaskKind::AutoRotate => "auto_rotate".to_string(),
            TaskKind::CreditsRefresh => "credits_refresh".to_string(),
            TaskKind::PoolPersist => "pool_persist".to_string(),
            TaskKind::AutoBackup => "auto_backup".to_string(),
            TaskKind::GatewayCatalogProbe => "gateway_catalog_probe".to_string(),
            TaskKind::GatewayUsageRecord => "gateway_usage_record".to_string(),
            TaskKind::ClientUsageRecord => "client_usage_record".to_string(),
            TaskKind::Scheduled(task) => format!("scheduled:{}", task.as_str()),
        }
    }
}

/// 一条后台任务：`(产品线, 种类)` 二维坐标 + 标称周期。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskSpec {
    /// 该任务服务的产品线。
    pub product: Product,
    /// 任务种类。
    pub kind: TaskKind,
    /// **标称**周期，仅作诊断 / 文档用途（启动分支按各自语义决定实际等待）：
    ///
    /// - `Duration::ZERO` = 「由配置 / 小时表 / 动态判据驱动，无固定周期」
    ///   （启动补跑、WorkBuddy 余额刷新、六类定时任务）；
    /// - 非零 = 固定（或检查）周期（落盘 / Trae 积分刷新 / 备份 / 轮换检查）。
    pub interval: Duration,
}

impl TaskSpec {
    /// **任务级**稳定标识（`产品:种类`，例 `wb:credits_refresh` / `trae:credits_refresh`）。
    ///
    /// ## 为什么标识必须带产品（而不是只有 kind）
    ///
    /// 一个后台任务的**身份**是 `(产品, 种类)` 这个**二维坐标**，而不是单独的种类：
    /// [`TaskKind::CreditsRefresh`] 被**两个产品共用**（二维化的本意）——
    /// 只按 kind 打标签会让「WorkBuddy 余额刷新」与「Trae 积分刷新」**同名**，
    /// 日志 / 诊断里无从区分，而两者的实现与数据源**完全不同**
    /// （前者走 `gateway::shared_state` 的池，后者走 `trae::credits` 的区域账号库）。
    ///
    /// 故本函数的返回值在**整张表**上**互不相同**（由 `task_labels_are_stable_and_distinct` 守住）。
    pub fn label(&self) -> String {
        format!("{}:{}", self.product.slug(), self.kind.label())
    }
}

pub const TASKS: &[TaskSpec] = &[
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::StartupMaintenance,
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::AutoRotate,
        interval: AUTO_ROTATE_CHECK_INTERVAL,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::CreditsRefresh,
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::PoolPersist,
        interval: POOL_PERSIST_INTERVAL,
    },
    TaskSpec {
        product: Product::Trae,
        kind: TaskKind::CreditsRefresh,
        interval: CREDITS_REFRESH_INTERVAL,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::AutoBackup,
        interval: AUTO_BACKUP_CHECK_INTERVAL,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::GatewayCatalogProbe,
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::GatewayUsageRecord,
        interval: GATEWAY_USAGE_RECORD_INTERVAL,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::ClientUsageRecord,
        interval: CLIENT_USAGE_RECORD_INTERVAL,
    },
    TaskSpec {
        product: Product::Trae,
        kind: TaskKind::GatewayUsageRecord,
        interval: GATEWAY_USAGE_RECORD_INTERVAL,
    },
    TaskSpec {
        product: Product::Qoder,
        kind: TaskKind::GatewayUsageRecord,
        interval: GATEWAY_USAGE_RECORD_INTERVAL,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::Scheduled(ScheduleTask::Checkin),
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::Scheduled(ScheduleTask::Travel),
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::Scheduled(ScheduleTask::Activity),
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::Scheduled(ScheduleTask::Keepalive),
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::Scheduled(ScheduleTask::School),
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Workbuddy,
        kind: TaskKind::Scheduled(ScheduleTask::Cat),
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Trae,
        kind: TaskKind::Scheduled(ScheduleTask::TraeCheckin),
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Trae,
        kind: TaskKind::Scheduled(ScheduleTask::TraeJwtRefresh),
        interval: Duration::ZERO,
    },
    // Qoder（第三条产品线）两条：签到与令牌保活。与 Trae 两条**同判据**：
    // 签到默认关（opt-in，它会替用户去领东西）、保活默认开（维持用户自己交出来的 refresh_token）。
    // ⚠️ 不登记 = 两宿主都不会起这个排程循环 ⇒ 设置页的开关是**假控件**
    //    （Trae JWT 续期就是这么被发现「界面标了、后台从没跑过」的）。
    TaskSpec {
        product: Product::Qoder,
        kind: TaskKind::Scheduled(ScheduleTask::QoderCheckin),
        interval: Duration::ZERO,
    },
    TaskSpec {
        product: Product::Qoder,
        kind: TaskKind::Scheduled(ScheduleTask::QoderKeepalive),
        interval: Duration::ZERO,
    },
];

/// 是否存在「该产品线的该种类」任务。
pub fn has_task(product: Product, kind: TaskKind) -> bool {
    TASKS
        .iter()
        .any(|spec| spec.product == product && spec.kind == kind)
}

/// 本表登记的全部定时任务种类（按声明顺序，去重）。
pub fn scheduled_tasks() -> Vec<ScheduleTask> {
    let mut out: Vec<ScheduleTask> = Vec::new();
    for spec in TASKS {
        if let TaskKind::Scheduled(task) = spec.kind {
            if !out.contains(&task) {
                out.push(task);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两个宿主的源码（**跨文件护栏**的读取对象）。
    ///
    /// ⚠️ 路径相对 **core 的 `CARGO_MANIFEST_DIR`**（`crates/buddy-switch-core`）：
    /// `../..` = 仓库根。与 `product.rs` 读取前端 `registry.ts` 同款做法。
    const TAURI_LIB_RS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src-tauri/src/lib.rs");
    const SERVER_MAIN_RS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../crates/buddy-switch-server/src/main.rs"
    );

    fn read_source(path: &str) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("读不到 {path}: {error}"))
    }

    /// 某一 [`TaskKind`] 在两个宿主的 `spawn` 派发里应有的**分支标记**。
    ///
    /// 标记带 `=>`（或 `(`）而**不是**裸类型名：宿主的**测试**里也会出现
    /// `TaskKind::AutoBackup`（作为 `has_task` 的实参），若标记不带箭头，删掉 spawn
    /// 分支后测试自身的引用仍会「满足」断言 ⇒ 护栏在空转。带箭头可精确锚定**分支**。
    fn spawn_arm_marker(kind: TaskKind) -> &'static str {
        match kind {
            TaskKind::StartupMaintenance => "TaskKind::StartupMaintenance =>",
            TaskKind::AutoRotate => "TaskKind::AutoRotate =>",
            TaskKind::CreditsRefresh => "TaskKind::CreditsRefresh =>",
            TaskKind::PoolPersist => "TaskKind::PoolPersist =>",
            TaskKind::AutoBackup => "TaskKind::AutoBackup =>",
            TaskKind::GatewayCatalogProbe => "TaskKind::GatewayCatalogProbe =>",
            TaskKind::GatewayUsageRecord => "TaskKind::GatewayUsageRecord =>",
            TaskKind::ClientUsageRecord => "TaskKind::ClientUsageRecord =>",
            TaskKind::Scheduled(_) => "TaskKind::Scheduled(",
        }
    }

    /// 表必须覆盖**全部**定时任务（宏 `define_schedule_tasks!` 是定时任务集合的唯一来源）。
    ///
    /// 可证伪：从 [`TASKS`] 删掉任一 `Scheduled(...)` 会让本用例变红 —— 该任务在**两个
    /// 宿主里**都不会被启动（排程控件空转，典型症状是「活跃地图」从未点亮）。
    #[test]
    fn tasks_cover_all_scheduled_tasks() {
        let scheduled = scheduled_tasks();
        for task in ScheduleTask::all() {
            assert!(
                scheduled.contains(&task),
                "TASKS 缺少定时任务「{}」——它在任何宿主里都不会执行（登记即执行）",
                task.as_str()
            );
        }
        assert_eq!(
            scheduled.len(),
            ScheduleTask::all().len(),
            "TASKS 的定时任务登记数必须与 ScheduleTask::all() 一致（不得漏登 / 重复）"
        );
    }

    /// 三次真实事故对应的任务**必须**登记在表里。
    ///
    /// 可证伪：删掉任一条 ⇒ 对应用例断言变红。
    #[test]
    fn tasks_include_every_key_background_task() {
        assert!(
            has_task(Product::Workbuddy, TaskKind::CreditsRefresh),
            "缺 WorkBuddy 账号池余额刷新 ⇒ 池里 credits 恒为 0，四因子加权静默退化为两因子"
        );
        assert!(
            has_task(Product::Trae, TaskKind::CreditsRefresh),
            "缺 Trae 积分刷新 ⇒ 纯用 API 时积分读数永远陈旧"
        );
        assert!(
            has_task(Product::Workbuddy, TaskKind::PoolPersist),
            "缺账号池治理状态落盘 ⇒ 冷却 / 熔断 / 成功率 EMA 只在内存里、重启清零"
        );
        assert!(
            has_task(Product::Workbuddy, TaskKind::AutoBackup),
            "缺定时全局备份 ⇒ 生产上永不产生自动备份（P5 R9「登记即执行」）"
        );
        assert!(
            has_task(Product::Workbuddy, TaskKind::GatewayCatalogProbe),
            "缺网关启动补识别（P10 T03 / ✅ #7）⇒ 「内置 / 陈旧」的模型清单永远不会在启动时\
             被补成实时，用户只能看到「内置」来源条"
        );
        assert!(
            has_task(Product::Workbuddy, TaskKind::GatewayUsageRecord),
            "缺网关用量今日快照 ⇒ record_gateway_today 只剩账号页一个调用点，\
             90 天历史大片空洞、账号卡片的 gateway 桶长时间不刷新"
        );
        assert!(
            has_task(Product::Workbuddy, TaskKind::ClientUsageRecord),
            "缺客户端用量今日快照 ⇒ record_client_today 只剩账号页一个调用点，\
             账号卡片「今日 Token」的 client 列长时间不刷新（用户报障原文）"
        );
        assert!(
            has_task(Product::Workbuddy, TaskKind::StartupMaintenance),
            "缺启动补跑"
        );
        assert!(
            has_task(Product::Workbuddy, TaskKind::AutoRotate),
            "缺自动轮换"
        );
        assert!(
            has_task(
                Product::Trae,
                TaskKind::Scheduled(ScheduleTask::TraeJwtRefresh)
            ),
            "缺 Trae JWT 自动续期 ⇒ 卡片上「自动刷新 JWT」标记与添加账号对话框\
             「网页登录的账号可以自动续期」都变成空头承诺（凭据静默过期）"
        );
    }

    /// 二维化落地：`CreditsRefresh` 是**同一 kind 的两个产品**（不是两个扁平变体）。
    #[test]
    fn credits_refresh_is_one_kind_across_two_products() {
        let wb = TASKS
            .iter()
            .find(|s| s.product == Product::Workbuddy && s.kind == TaskKind::CreditsRefresh)
            .expect("WorkBuddy 余额刷新必须在表里");
        let trae = TASKS
            .iter()
            .find(|s| s.product == Product::Trae && s.kind == TaskKind::CreditsRefresh)
            .expect("Trae 积分刷新必须在表里");
        // 同一 kind，两个 product ⇒ 正是二维坐标。
        assert_eq!(wb.kind, trae.kind, "两者必须共用同一 TaskKind（二维化）");
        assert_ne!(wb.product, trae.product);
    }

    #[test]
    fn task_labels_are_stable_and_distinct() {
        let labels: Vec<String> = TASKS.iter().map(|spec| spec.label()).collect();
        for label in &labels {
            assert!(!label.is_empty(), "任务标识不得为空");
        }
        let mut sorted = labels.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            labels.len(),
            "任务标识必须互不相同：{labels:?}"
        );
        // 二维坐标：同一 kind 的两个产品必须产生**不同**的任务级标签。
        assert!(
            labels.iter().any(|l| l == "wb:credits_refresh"),
            "{labels:?}"
        );
        assert!(
            labels.iter().any(|l| l == "trae:credits_refresh"),
            "{labels:?}"
        );
        // 定时任务的标识带上类别后缀，便于日志区分。
        assert!(
            labels.iter().any(|l| l == "wb:scheduled:checkin"),
            "{labels:?}"
        );
        assert!(
            labels.iter().any(|l| l == "trae:scheduled:trae_checkin"),
            "{labels:?}"
        );
    }

    #[test]
    fn both_hosts_register_every_task_kind() {
        for host in [TAURI_LIB_RS, SERVER_MAIN_RS] {
            let source = read_source(host);
            for spec in TASKS {
                let marker = spawn_arm_marker(spec.kind);
                assert!(
                    source.contains(marker),
                    "宿主 {host} 的 spawn 派发缺少分支 `{marker}` —— \
                     该任务在此宿主里**永远不会执行**（登记即执行 / P5 R9）"
                );
            }
        }
    }

    #[test]
    fn gateway_usage_record_interval_is_a_today_metric_cadence() {
        assert!(
            GATEWAY_USAGE_RECORD_INTERVAL <= Duration::from_secs(10 * 60),
            "周期过长（{:?}）—— 账号卡片的 gateway 桶又会长时间不刷新",
            GATEWAY_USAGE_RECORD_INTERVAL
        );
        assert!(
            GATEWAY_USAGE_RECORD_INTERVAL >= Duration::from_secs(30),
            "周期过短（{:?}）—— 无谓地反复读网关日志、写 token_daily 存储",
            GATEWAY_USAGE_RECORD_INTERVAL
        );
    }

    #[test]
    fn client_usage_record_interval_is_a_today_metric_cadence() {
        assert!(
            CLIENT_USAGE_RECORD_INTERVAL <= Duration::from_secs(10 * 60),
            "周期过长（{:?}）—— 账号卡片的 client 桶又会长时间不刷新",
            CLIENT_USAGE_RECORD_INTERVAL
        );
        assert!(
            CLIENT_USAGE_RECORD_INTERVAL >= Duration::from_secs(30),
            "周期过短（{:?}）—— 无谓地反复扫客户端语料、写 token_daily 存储",
            CLIENT_USAGE_RECORD_INTERVAL
        );
    }

    #[test]
    fn both_hosts_record_client_usage_for_every_region_without_forcing_rescans() {
        let marker = "TaskKind::ClientUsageRecord =>";
        for host in [TAURI_LIB_RS, SERVER_MAIN_RS] {
            let source = read_source(host);
            let start = source
                .find(marker)
                .unwrap_or_else(|| panic!("宿主 {host} 的 spawn 派发缺少分支 `{marker}`"));
            // 只看分支体：从标记往后到下一个 `TaskKind::` 分支（或文件尾）。
            let rest = &source[start + marker.len()..];
            let end = rest.find("TaskKind::").unwrap_or(rest.len());
            let body = &rest[..end];
            assert!(
                body.contains("record_client_today(region, false)"),
                "宿主 {host} 的客户端用量分支必须调用 `record_client_today(region, false)`\
                 （`false` = 走 TTL 闸门；`true` 会每轮全量重扫，闸门形同虚设）"
            );
            assert!(
                body.contains("Region::all()"),
                "宿主 {host} 的客户端用量分支必须遍历 Region::all()（两个 region）——\
                 只扫一个，另一个的 client 桶会永远旧值"
            );
        }
    }

    #[test]
    fn both_hosts_record_gateway_usage_for_every_region() {
        let marker = "TaskKind::GatewayUsageRecord =>";
        for host in [TAURI_LIB_RS, SERVER_MAIN_RS] {
            let source = read_source(host);
            let start = source
                .find(marker)
                .unwrap_or_else(|| panic!("宿主 {host} 的 spawn 派发缺少分支 `{marker}`"));
            // 只看分支体：从标记往后到下一个 `TaskKind::` 分支（或文件尾）。
            let rest = &source[start + marker.len()..];
            let end = rest.find("TaskKind::").unwrap_or(rest.len());
            let body = &rest[..end];
            assert!(
                body.contains("record_gateway_today"),
                "宿主 {host} 的网关用量分支没有调用 record_gateway_today"
            );
            assert!(
                body.contains("Region::all()"),
                "宿主 {host} 的网关用量分支必须遍历 Region::all()（两个 region）——\
                 只记一个 region，另一个的 gateway 历史会永远空着"
            );
        }
    }

    /// 反向护栏：`spawn_arm_marker` 必须覆盖 `TaskKind` 的**全部**取值。
    ///
    /// 可证伪：新增一个 [`TaskKind`] 变体却忘了给 `spawn_arm_marker` 加分支 ⇒ 本 `match`
    /// 不穷尽 ⇒ 编译失败（把「护栏自身漏项」也变成编译期强制）。
    #[test]
    fn spawn_arm_marker_covers_every_kind() {
        for kind in [
            TaskKind::StartupMaintenance,
            TaskKind::AutoRotate,
            TaskKind::CreditsRefresh,
            TaskKind::PoolPersist,
            TaskKind::AutoBackup,
            TaskKind::GatewayCatalogProbe,
            TaskKind::GatewayUsageRecord,
            TaskKind::ClientUsageRecord,
            TaskKind::Scheduled(ScheduleTask::Checkin),
        ] {
            assert!(!spawn_arm_marker(kind).is_empty(), "{kind:?}");
        }
    }
}
