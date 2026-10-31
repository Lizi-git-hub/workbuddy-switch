
use std::sync::Mutex;

use buddy_switch_gateway::unified::{UnifiedGateway, UnifiedGatewayState};
use buddy_switch_gateway::{GatewayHost, GatewayProduct};

/// 进程内共享的统一网关状态（惰性初始化，读一次配置）。
///
/// 独立监听与管理面复用**同一份**状态 ⇒ 监听 57892 上的真实请求与配置改动互相可见。
pub fn shared_state() -> UnifiedGatewayState {
    <UnifiedGateway as GatewayProduct>::shared_state()
}

/// 独立监听生命周期（Tauri managed state）。
///
/// ## 为什么用 `std::sync::Mutex`（而非 `tokio::sync::Mutex`）
///
/// 与 [`crate::gateway::GatewayRuntime`] 同款：状态查询命令是**同步**的，需要同步读
/// `is_running` / `addr`。为**不跨 `await` 持有 std 锁**，`apply` 先把 [`GatewayHost`]
/// **整体取出**（`mem::take`），在锁外 `await` 之后再放回。
pub struct UnifiedGatewayRuntime {
    host: Mutex<GatewayHost<UnifiedGateway>>,
}

impl Default for UnifiedGatewayRuntime {
    fn default() -> Self {
        Self {
            host: Mutex::new(GatewayHost::new()),
        }
    }
}

impl UnifiedGatewayRuntime {
    /// 新建（未启动）。
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn apply(&self) -> Result<Option<String>, String> {
        let mut host = self.take_host();
        let result = host.start().await;
        self.put_host(host);
        result
    }

    /// 是否运行中。
    pub fn is_running(&self) -> bool {
        self.host.lock().unwrap().is_running()
    }

    /// 运行中的监听地址。
    pub fn addr(&self) -> Option<String> {
        self.host.lock().unwrap().addr()
    }

    /// 取出宿主（在**锁外** `await` 用；[`GatewayHost`] 实现了 `Default`）。
    fn take_host(&self) -> GatewayHost<UnifiedGateway> {
        std::mem::take(&mut *self.host.lock().unwrap())
    }

    /// 放回宿主（与 [`UnifiedGatewayRuntime::take_host`] 配对）。
    fn put_host(&self, host: GatewayHost<UnifiedGateway>) {
        *self.host.lock().unwrap() = host;
    }
}
