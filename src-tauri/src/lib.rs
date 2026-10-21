#[cfg(target_os = "macos")]
mod hevc_decode;
mod liveview;
mod luna;
mod video_thumbnail;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_process::init())
    .manage(luna::LunaState::default())
    .manage(liveview::LiveViewState::default())
    .invoke_handler(tauri::generate_handler![
      luna::luna_connect,
      luna::luna_disconnect,
      luna::luna_status,
      luna::luna_delete_files,
      luna::luna_command,
      luna::luna_transfer_activity,
      luna::luna_set_notification_capture,
      liveview::luna_liveview_start,
      liveview::luna_liveview_stop,
      liveview::luna_liveview_pause,
      liveview::luna_liveview_resume,
      liveview::luna_liveview_stats,
      video_thumbnail::luna_video_thumbnail,
    ])
    .setup(|app| {
      // Auto-updater (desktop only)
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

      // Was gated behind `cfg!(debug_assertions)`, 2026-10-20: that's false
      // under `tauri dev --release` (same root cause as the `devtools`
      // feature below needing to be explicit — see Cargo.toml) — meaning
      // this plugin, and every `log::` call anywhere in this codebase, had
      // never actually initialized across this project's entire history of
      // running that way. Always-on by default now (the `debug-log` Cargo
      // feature, on unless the build opts out — see Cargo.toml's own
      // comment): this is a single-user debug tool (tauri build's DMG step
      // doesn't even work yet, so there's no real "shipped build" to keep
      // this out of by default).
      //
      // FOUND AND FIXED, same day: this originally also added a Folder
      // target writing inside this repo, at src-tauri/debug-logs/, so it
      // could be read back over the device bridge without a new folder
      // grant. That was wrong — `tauri dev`'s own file watcher monitors the
      // whole src-tauri tree for rebuild triggers, so every log write (and
      // tracking produces a lot of them) was itself seen as a source change,
      // triggering a full rebuild-and-relaunch. David saw this as "the app
      // crashes and restarts" when drawing a box and moving around — not a
      // real crash, a self-inflicted loop, confirmed by his terminal paste
      // showing "File src-tauri/debug-logs/luna.log changed. Rebuilding
      // application..." right after tracking traffic. Removed; now just
      // tauri_plugin_log::Builder's own defaults — Stdout plus the OS log
      // dir (`~/Library/Logs/com.ripwords.luna-ultra-desktop` on macOS,
      // well outside anything a dev-mode watcher looks at), nothing custom.
      //
      // ADDED 2026-10-20 (later the same day): David asked for a way to do
      // a full compile that produces no log files at all — e.g. for a build
      // he means to keep around rather than one more debug cycle. Simply
      // never calling `.plugin(...)` here is enough: nothing else installs
      // a `log` backend, so every `log::` call elsewhere in this codebase
      // (luna.rs's unmatched-frame line, for instance) becomes a silent
      // no-op rather than a write. Gated on the `debug-log` feature instead
      // of `cfg!(debug_assertions)` again on purpose — that flag has already
      // lied once about what "a real build" means for this project (see
      // above), where a plain Cargo feature says exactly what was asked for
      // and nothing else.
      #[cfg(feature = "debug-log")]
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
