mod commands;
mod db;
mod fetch;
mod models;
mod opml;
mod theme;

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
}

const TRAY_FETCH: &str = "fetch-now";

fn spawn_fetch_loop(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            fetch::fetch_all(&handle).await;
            // Poisoned lock only means a panicked writer; SQLite writes are
            // transactional, so recovering the inner connection is safe here.
            let interval_min: i64 = {
                let state = handle.state::<AppState>();
                let conn = match state.db.lock() {
                    Ok(c) => c,
                    Err(poisoned) => poisoned.into_inner(),
                };
                db::get_setting(&conn, "fetch_interval_min")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(30)
            };
            tokio::time::sleep(std::time::Duration::from_secs(
                (interval_min.max(1) as u64) * 60,
            ))
            .await;
        }
    });
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open Wellsprings", true, None::<&str>)?;
    let fetch_item = MenuItem::with_id(app, TRAY_FETCH, "Fetch now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &fetch_item, &quit])?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("window icon").clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            TRAY_FETCH => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    fetch::fetch_all(&handle).await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open_db(&dir.join("wellsprings.db"))?;
            db::run_migrations(&conn)?;
            app.manage(AppState { db: Mutex::new(conn) });

            setup_tray(app)?;
            spawn_fetch_loop(app.handle().clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || theme::watch_loop(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_feeds,
            commands::list_items,
            commands::get_item,
            commands::set_read,
            commands::set_starred,
            commands::search,
            commands::get_theme,
            commands::fetch_now,
            commands::get_settings,
            commands::set_setting,
            commands::create_group,
            commands::rename_group,
            commands::delete_group,
            commands::reorder_groups,
            commands::set_source_group,
            commands::rename_source,
            commands::remove_source,
            commands::add_source,
            commands::export_opml,
            commands::import_opml
        ])
        .on_window_event(|window, event| {
            // Close-to-tray: the fetch loop lives in this process.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
