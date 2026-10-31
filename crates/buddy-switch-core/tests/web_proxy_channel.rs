
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use buddy_switch_core::modules::qoder::region::QoderRegion;
use buddy_switch_core::modules::qoder::web_proxy::WebProxyConfig;
use buddy_switch_core::modules::qoder::web_usage;

/// 本地 CONNECT 隧道：记录目标 + 转发原始字节。
fn spawn_tunnel() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定本地隧道端口");
    let port = listener.local_addr().unwrap().port();
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_for_thread = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(client) = stream else { break };
            let seen = seen_for_thread.clone();
            std::thread::spawn(move || {
                let _ = handle_connect(client, seen);
            });
        }
    });
    (port, seen)
}

fn handle_connect(client: TcpStream, seen: Arc<Mutex<Vec<String>>>) -> std::io::Result<()> {
    let mut client = client;
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    // 逐字节读到首个请求头结束（CONNECT 头很小，逐字节读不会成为瓶颈）。
    while !buf.ends_with(b"\r\n\r\n") {
        let n = client.read(&mut byte)?;
        if n == 0 {
            return Ok(());
        }
        buf.push(byte[0]);
    }
    let first = String::from_utf8_lossy(&buf);
    let first_line = first.lines().next().unwrap_or_default().to_string();
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_ascii_uppercase();
    let target = parts.next().unwrap_or_default().to_string();
    if method != "CONNECT" {
        let _ = client.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
        return Ok(());
    }
    seen.lock().unwrap().push(target.clone());

    let (host, port) = target
        .rsplit_once(':')
        .map(|(h, p)| (h.to_string(), p.parse::<u16>().unwrap_or(443)))
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad target"))?;
    let mut remote = TcpStream::connect((host.as_str(), port))?;
    client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;

    // 双向转发（TLS 密文，不解密）。
    let mut remote_clone = remote.try_clone()?;
    let mut client_clone = client.try_clone()?;
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut client, &mut remote_clone);
    });
    let down = std::thread::spawn(move || {
        let _ = std::io::copy(&mut remote, &mut client_clone);
    });
    let _ = up.join();
    let _ = down.join();
    Ok(())
}

fn temp_home_with_proxy(global_proxy: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("创建临时目录");
    std::env::set_var("BUDDY_SWITCH_HOME", dir.path());
    let config = WebProxyConfig {
        cn: String::new(),
        global: global_proxy.to_string(),
    };
    config.save().expect("写入代理配置");
    dir
}

#[tokio::test]
#[ignore = "真网络测试：需要出站网络；CI 与默认 cargo test 不跑"]
async fn global_per_pack_request_goes_through_proxy() {
    let (port, seen) = spawn_tunnel();
    let _home = temp_home_with_proxy(&format!("http://127.0.0.1:{port}"));

    let result = web_usage::fetch_credit_packs_raw(
        QoderRegion::Global,
        "qoder_session_cookie=deliberately-invalid-channel-test",
    )
    .await;

    let targets = seen.lock().unwrap().clone();
    assert!(
        targets.iter().any(|t| t == "qoder.com:443"),
        "国际版请求没有经过代理通道（隧道只看到: {targets:?}）"
    );
    match result {
        Err(error) => {
            // 关键判据是「走了通道」（上面的 CONNECT 断言）。至于拿到什么：
            // - 有真实 egress 的环境 ⇒ 上游 401（unauthorized）；
            // - 本机网络到 qoder.com 被 IP 拦截且无可用 egress ⇒ 传输层错误。
            //   两者都证明「配置的代理被使用」；唯一不可接受的是 Ok（假会话绝不能成功）。
            println!("[通道验证] 国际版请求结果: {error}");
        }
        Ok(_) => panic!("假会话不应成功"),
    }
}

#[tokio::test]
#[ignore = "真网络测试：需要出站网络；CI 与默认 cargo test 不跑"]
async fn cn_request_without_proxy_bypasses_tunnel() {
    let (_port, seen) = spawn_tunnel();
    let _home = temp_home_with_proxy(""); // CN/国际版都留空 = 直连

    let result = web_usage::fetch_credit_packs_raw(
        QoderRegion::Cn,
        "qoder_session_cookie=deliberately-invalid-channel-test",
    )
    .await;

    let targets = seen.lock().unwrap().clone();
    assert!(
        !targets.iter().any(|t| t.contains("qoder.com")),
        "未配代理的 CN 请求不应经过隧道（隧道看到: {targets:?}）"
    );
    match result {
        Err(error) => assert!(error.unauthorized, "直连 401 才说明真的到了上游: {error}"),
        Ok(_) => panic!("假会话不应成功"),
    }
}
