// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = buddy_switch_core::modules::agent_hook_rx::try_run_hook_cli(&args) {
        std::process::exit(code);
    }
    buddy_switch_rust_lib::run()
}
