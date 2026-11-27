// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().skip(1).any(|arg| arg == "--version") {
        println!("NoobClawMatrix {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    noobclaw_lib::run()
}
