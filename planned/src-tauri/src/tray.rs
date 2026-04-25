use crate::db::Pool;
use chrono::Local;
use sqlx::Row;
use tauri::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

pub struct TrayState {
    pub today_label: MenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> anyhow::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open UniT", true, None::<&str>)?;
    let quick = MenuItem::with_id(
        app,
        "quick_add",
        "Quick add…",
        true,
        Some("CmdOrCtrl+Shift+P"),
    )?;
    let today_label = MenuItem::with_id(
        app,
        "today_label",
        today_summary_blocking(app),
        false,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&today_label, &sep, &show, &quick, &sep, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("default window icon missing; tray not created"))?;

    TrayIconBuilder::with_id("main-tray")
        .tooltip("UniT")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_tray)
        .build(app)?;

    app.manage(TrayState { today_label });
    Ok(())
}

fn on_menu(app: &AppHandle, ev: MenuEvent) {
    match ev.id.as_ref() {
        "show" => focus_main(app),
        "quick_add" => focus_main_and_quick_add(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn on_tray(icon: &tauri::tray::TrayIcon<Wry>, ev: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = ev
    {
        focus_main(icon.app_handle());
    }
}

pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn focus_main_and_quick_add(app: &AppHandle) {
    focus_main(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("quick-add", ());
    }
}

/// Recompute today's open-task count and update the tray menu label.
/// No-op if the tray hasn't been built yet or the DB isn't managed.
pub async fn refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let text = today_summary(app).await;
    let _ = state.today_label.set_text(text);
}

async fn today_summary(app: &AppHandle) -> String {
    let Some(pool) = app.try_state::<Pool>() else {
        return String::from("Today — —");
    };
    let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
    let count: i64 =
        sqlx::query("SELECT COUNT(*) AS c FROM tasks WHERE done = 0 AND (due = ? OR my_day = 1)")
            .bind(&today)
            .fetch_one(&*pool)
            .await
            .map(|r| r.get::<i64, _>("c"))
            .unwrap_or(0);
    format!("Today — {} open", count)
}

fn today_summary_blocking(app: &AppHandle) -> String {
    tauri::async_runtime::block_on(today_summary(app))
}
