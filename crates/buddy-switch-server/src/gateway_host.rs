
use std::sync::OnceLock;

use tokio::sync::Mutex;

use buddy_switch_gateway::{GatewayHost, GatewayProduct, GatewayState, WbGateway};

static HOST: OnceLock<Mutex<GatewayHost<WbGateway>>> = OnceLock::new();

/// 进程内共享的网关状态（惰性初始化，读一次配置）。
///
/// 独立监听与 `api.rs` 的管理面复用**同一份**状态，因此监听 57891 上的真实请求日志与
/// `/v1/models` 目录刷新结果都能在管理页看到。
pub fn shared_state() -> GatewayState {
    <WbGateway as GatewayProduct>::shared_state()
}

fn host() -> &'static Mutex<GatewayHost<WbGateway>> {
    HOST.get_or_init(|| Mutex::new(GatewayHost::new()))
}

/// 按当前配置应用（启动 / 重启）独立监听。
///
/// 以共享状态内的配置为准（管理面保存配置时会同步写回该状态）；配置为 disabled
/// 等价于停止。
pub async fn apply() -> Result<Option<String>, String> {
    host().lock().await.start().await
}

/// 查询运行状态（运行中, 监听地址）。
pub async fn status() -> (bool, Option<String>) {
    let host = host().lock().await;
    (host.is_running(), host.addr())
}
