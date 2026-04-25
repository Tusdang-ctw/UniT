mod commands;
mod db;
mod gcal;
mod scheduler;
mod tray;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::MacosLauncher;
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                tray::focus_main(app);
            }))
            .plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                            tracing::info!(?shortcut, "global shortcut fired");
                            tray::focus_main_and_quick_add(app);
                        }
                    })
                    .build(),
            );
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            let path = db::db_path("UniT");
            tracing::info!(?path, "opening database");
            let pool = tauri::async_runtime::block_on(db::connect(&path))
                .expect("failed to open database");
            app.manage(pool);

            #[cfg(desktop)]
            {
                if let Err(e) = tray::build(app.handle()) {
                    tracing::warn!(?e, "tray init failed; continuing without tray");
                }

                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let sc = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP);
                if let Err(e) = app.global_shortcut().register(sc) {
                    tracing::warn!(?e, "could not register global shortcut");
                }
            }

            scheduler::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tasks,
            commands::upsert_task,
            commands::delete_task,
            commands::get_settings,
            commands::save_settings,
            commands::export_tasks_json,
            commands::import_tasks_json,
            commands::set_autostart,
            commands::get_autostart,
            gcal::gcal_connect,
            gcal::gcal_disconnect,
            gcal::gcal_status,
            gcal::gcal_push_task,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
