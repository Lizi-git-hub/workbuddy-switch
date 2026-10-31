
use std::sync::Mutex;

use buddy_switch_gateway::trae::{TraeGateway, TraeGatewayState};
use buddy_switch_gateway::{GatewayHost, GatewayProduct};

/// 进程内共享的 Trae 网关状态（惰性初始化，读一次配置）。
///
/// 独立监听与管理命令复用**同一份**状态，因此「API 服务」页看到的请求日志、
/// 账号池与真实打进来的请求完全一致。
pub fn shared_state() -> TraeGatewayState {
    <TraeGateway as GatewayProduct>::shared_state()
}

/// 独立监听生命周期（Tauri managed state）。
///
/// 锁策略与 [`crate::gateway::GatewayRuntime`] 同款（`std::sync::Mutex` + 锁外 `await`，
/// 因 `trae_gateway_status` 需同步读运行态）。
pub struct TraeGatewayRuntime {
    host: Mutex<GatewayHost<TraeGateway>>,
}

impl Default for TraeGatewayRuntime {
    fn default() -> Self {
        Self {
            host: Mutex::new(GatewayHost::new()),
        }
    }
}

impl TraeGatewayRuntime {
    /// 新建（未启动）。
    pub fn new() -> Self {
        Self::default()
    }

    /// 按当前配置启动 / 重启独立监听。返回实际监听地址；未启用时返回 `None`。
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
    fn take_host(&self) -> GatewayHost<TraeGateway> {
        std::mem::take(&mut *self.host.lock().unwrap())
    }

    /// 放回宿主（与 [`TraeGatewayRuntime::take_host`] 配对）。
    fn put_host(&self, host: GatewayHost<TraeGateway>) {
        *self.host.lock().unwrap() = host;
    }
}
