mod applog;
mod cli_bridge;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_fs::FsExt;

// Watched clones and their worktrees live wherever the user keeps them, so the capability file
// can't name them up front — it only covers what is knowable at build time. Each checkout the UI
// touches is added to the runtime fs scope instead, which `resolve_path` ORs with the capability
// scope. The set keeps a 10-minute poll from pushing the same globs over and over.
#[derive(Default)]
struct AllowedPaths(Mutex<HashSet<PathBuf>>);

// Widen the fs scope to one checkout. Called with paths the user configured by hand, so consent
// is the registration itself; nothing here widens the scope on its own.
#[tauri::command]
fn allow_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    {
        let state = app.state::<AllowedPaths>();
        let mut allowed = state.0.lock().map_err(|e| e.to_string())?;
        if !allowed.insert(path.clone()) {
            return Ok(());
        }
    }
    // `.claude` needs a pattern of its own: `allow_directory` pushes `p` and `p/**`, and unix
    // scope matching sets require_literal_leading_dot, so no glob ever matches a dot component —
    // the same reason the capability file has to name `Projects/**/.claude/**` outright.
    let widened = app
        .fs_scope()
        .allow_directory(&path, true)
        .and_then(|()| app.fs_scope().allow_directory(path.join(".claude"), true));
    if let Err(e) = widened {
        // the globs never landed, so drop the path: left in, it reports this widen as done and
        // short-circuits every retry
        app.state::<AllowedPaths>()
            .0
            .lock()
            .map_err(|err| err.to_string())?
            .remove(&path);
        return Err(e.to_string());
    }
    Ok(())
}

// Open (or focus) a PR browser window. Built from Rust so a navigation toolbar
// (back/forward/reload + URL bar) can be injected into every page it loads.
#[tauri::command]
async fn open_pr_window(app: tauri::AppHandle, label: String, url: String, title: String) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(&label) {
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(parsed))
        .title(&title)
        .inner_size(1280.0, 900.0)
        .initialization_script(include_str!("browser-toolbar.js"));
    // macOS glass titlebar looks broken over remote pages; overlay = traffic lights only,
    // repositioned so they center vertically in the injected 46px toolbar
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // y is not a top inset: the effective light center lands at (y + button_height)/2;
            // 25.5 tuned by eye to center the lights in the 46px toolbar
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 25.5));
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // GUI apps launched from Finder get launchd's bare PATH; pull in the login shell's
    // PATH so `claude`, `gh` and `code` resolve in release builds.
    let _ = fix_path_env::fix();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(
                    "sqlite:lookout.db",
                    vec![
                        tauri_plugin_sql::Migration {
                            version: 1,
                            description: "create tasks",
                            sql: include_str!("../migrations/001_tasks.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 2,
                            description: "activity tracking",
                            sql: include_str!("../migrations/002_activity.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 3,
                            description: "pr created at",
                            sql: include_str!("../migrations/003_created_at.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 4,
                            description: "snooze until activity",
                            sql: include_str!("../migrations/004_snooze.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 5,
                            description: "manual sort order",
                            sql: include_str!("../migrations/005_sort_order.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 6,
                            description: "notification center",
                            sql: include_str!("../migrations/006_notifications.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 7,
                            description: "notification archive",
                            sql: include_str!("../migrations/007_notif_archive.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 8,
                            description: "discovery seen flag",
                            sql: include_str!("../migrations/008_seen.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 9,
                            description: "pr draft flag",
                            sql: include_str!("../migrations/009_is_draft.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 10,
                            description: "derived alerts",
                            sql: include_str!("../migrations/010_alerts.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 11,
                            description: "alert archive",
                            sql: include_str!("../migrations/011_alert_archive.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 12,
                            description: "rename inbox stage to needs_review",
                            sql: include_str!("../migrations/012_needs_review.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 13,
                            description: "store the pull request board",
                            sql: include_str!("../migrations/013_my_prs.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .manage(AllowedPaths::default())
        .invoke_handler(tauri::generate_handler![
            open_pr_window,
            allow_path,
            applog::log_append,
            applog::log_path,
            applog::log_clear
        ])
        // the socket the `lookout` CLI pings after a write, so the board repaints immediately
        .setup(|app| {
            cli_bridge::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                cli_bridge::stop(app);
            }
        });
}
