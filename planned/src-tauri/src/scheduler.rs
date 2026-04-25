use crate::db::Pool;
use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use sqlx::Row;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// Background task that wakes every TICK and fires notifications for due tasks.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Slight startup delay to let the window settle.
        tokio::time::sleep(Duration::from_secs(3)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            if let Err(e) = tick(&app).await {
                tracing::warn!(?e, "scheduler tick failed");
            }
        }
    });
}

async fn tick(app: &AppHandle) -> anyhow::Result<()> {
    let pool = app.state::<Pool>();
    let now = Local::now().naive_local();
    let today = now.date();

    // Candidate tasks: not done, have due + time, not yet past one hour ago.
    let rows = sqlx::query(
        r#"SELECT id, title, due, time, remind_minutes_before, last_notified_at
           FROM tasks
           WHERE done = 0 AND due IS NOT NULL AND time IS NOT NULL"#,
    )
    .fetch_all(&*pool)
    .await?;

    for r in rows {
        let id: i64 = r.get("id");
        let title: String = r.get("title");
        let due: String = r.get("due");
        let time: String = r.get("time");
        let remind: Option<i64> = r.get("remind_minutes_before");
        let last_notified: Option<i64> = r.get("last_notified_at");

        let Some(task_dt) = parse_dt(&due, &time) else {
            continue;
        };
        let offset_min = remind.unwrap_or(0);
        let fire_at = task_dt - chrono::Duration::minutes(offset_min);

        // Only fire if fire_at <= now AND we haven't notified for this occurrence.
        if fire_at > now {
            continue;
        }
        // Skip if last_notified_at >= fire_at (ms epoch).
        // DST-safe: fall back to one-hour-later if this naive time is ambiguous/absent.
        let fire_epoch_ms = match Local.from_local_datetime(&fire_at) {
            chrono::LocalResult::Single(dt) => dt.timestamp_millis(),
            chrono::LocalResult::Ambiguous(a, _) => a.timestamp_millis(),
            chrono::LocalResult::None => (fire_at + chrono::Duration::hours(1))
                .and_local_timezone(Local)
                .earliest()
                .map(|d| d.timestamp_millis())
                .unwrap_or(0),
        };
        if last_notified.map(|v| v >= fire_epoch_ms).unwrap_or(false) {
            continue;
        }
        // Skip stale ones more than 2h past.
        if now - task_dt > chrono::Duration::hours(2) {
            continue;
        }

        let body = if offset_min > 0 {
            format!("Starts at {} (in {} min)", friendly_time(&time), offset_min)
        } else {
            format!("Scheduled for {}", friendly_time(&time))
        };

        if let Err(e) = app
            .notification()
            .builder()
            .title(format!("⏰ {}", title))
            .body(body)
            .show()
        {
            tracing::warn!(?e, id, "notification show failed");
            continue;
        }

        // Mark as notified so we don't repeat.
        sqlx::query("UPDATE tasks SET last_notified_at = ? WHERE id = ?")
            .bind(fire_epoch_ms)
            .bind(id)
            .execute(&*pool)
            .await
            .ok();

        // Also signal the frontend so UI can refresh if desired.
        app.emit_to("main", "task-notified", id).ok();
        let _ = today; // silence unused warning when no debug print
    }
    crate::tray::refresh(app).await;
    Ok(())
}

fn parse_dt(date: &str, time: &str) -> Option<NaiveDateTime> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let t = NaiveTime::parse_from_str(time, "%H:%M").ok()?;
    Some(NaiveDateTime::new(d, t))
}

fn friendly_time(hm: &str) -> String {
    let Some(t) = NaiveTime::parse_from_str(hm, "%H:%M").ok() else {
        return hm.into();
    };
    t.format("%-I:%M %p").to_string()
}
