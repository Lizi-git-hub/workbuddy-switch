
use std::sync::OnceLock;

use tokio::sync::Mutex;

use buddy_switch_gateway::trae::{TraeGateway, TraeGatewayState};
use buddy_switch_gateway::{GatewayHost, GatewayProduct};

static HOST: OnceLock<Mutex<GatewayHost<TraeGateway>>> = OnceLock::new();

/// 进程内共享的 Trae 网关状态（惰性初始化，读一次配置）。
pub fn shared_state() -> TraeGatewayState {
    <TraeGateway as GatewayProduct>::shared_state()
}

fn host() -> &'static Mutex<GatewayHost<TraeGateway>> {
    HOST.get_or_init(|| Mutex::new(GatewayHost::new()))
}

/// 按当前配置应用（启动 / 重启）独立监听。
pub async fn apply() -> Result<Option<String>, String> {
    host().lock().await.start().await
}

/// 查询运行状态（运行中, 监听地址）。
pub async fn status() -> (bool, Option<String>) {
    let host = host().lock().await;
    (host.is_running(), host.addr())
}
