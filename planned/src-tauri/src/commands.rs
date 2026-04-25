use crate::db::Pool;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{AppHandle, State};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, s: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        s.serialize_str(&self.to_string())
    }
}

pub type CommandResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub due: Option<String>,
    pub time: Option<String>,
    pub list: String,
    pub starred: bool,
    pub done: bool,
    pub my_day: bool,
    pub note: String,
    pub tag: Option<String>,
    pub created: i64,
    pub gcal_synced: bool,
    pub duration: i64,
    pub recur: String,
    pub remind_minutes_before: Option<i64>,
    pub last_notified_at: Option<i64>,
    pub gcal_event_id: Option<String>,
}

fn row_to_task(row: sqlx::sqlite::SqliteRow) -> Task {
    Task {
        id: row.get("id"),
        title: row.get("title"),
        due: row.get("due"),
        time: row.get("time"),
        list: row.get("list"),
        starred: row.get::<i64, _>("starred") != 0,
        done: row.get::<i64, _>("done") != 0,
        my_day: row.get::<i64, _>("my_day") != 0,
        note: row.get("note"),
        tag: row.get("tag"),
        created: row.get("created"),
        gcal_synced: row.get::<i64, _>("gcal_synced") != 0,
        duration: row.get("duration"),
        recur: row.get("recur"),
        remind_minutes_before: row.get("remind_minutes_before"),
        last_notified_at: row.get("last_notified_at"),
        gcal_event_id: row.get("gcal_event_id"),
    }
}

#[tauri::command]
pub async fn list_tasks(pool: State<'_, Pool>) -> CommandResult<Vec<Task>> {
    let rows = sqlx::query("SELECT * FROM tasks ORDER BY id ASC")
        .fetch_all(&*pool)
        .await?;
    Ok(rows.into_iter().map(row_to_task).collect())
}

#[tauri::command]
pub async fn upsert_task(
    app: AppHandle,
    pool: State<'_, Pool>,
    mut task: Task,
) -> CommandResult<Task> {
    if task.id == 0 {
        let res = sqlx::query(
            r#"INSERT INTO tasks
               (title, due, time, list, starred, done, my_day, note, tag, created,
                gcal_synced, duration, recur, remind_minutes_before, last_notified_at, gcal_event_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&task.title)
        .bind(&task.due)
        .bind(&task.time)
        .bind(&task.list)
        .bind(task.starred as i64)
        .bind(task.done as i64)
        .bind(task.my_day as i64)
        .bind(&task.note)
        .bind(&task.tag)
        .bind(task.created)
        .bind(task.gcal_synced as i64)
        .bind(task.duration)
        .bind(&task.recur)
        .bind(task.remind_minutes_before)
        .bind(task.last_notified_at)
        .bind(&task.gcal_event_id)
        .execute(&*pool)
        .await?;
        task.id = res.last_insert_rowid();
    } else {
        sqlx::query(
            r#"UPDATE tasks SET
                title=?, due=?, time=?, list=?, starred=?, done=?, my_day=?, note=?,
                tag=?, created=?, gcal_synced=?, duration=?, recur=?,
                remind_minutes_before=?, last_notified_at=?, gcal_event_id=?
               WHERE id=?"#,
        )
        .bind(&task.title)
        .bind(&task.due)
        .bind(&task.time)
        .bind(&task.list)
        .bind(task.starred as i64)
        .bind(task.done as i64)
        .bind(task.my_day as i64)
        .bind(&task.note)
        .bind(&task.tag)
        .bind(task.created)
        .bind(task.gcal_synced as i64)
        .bind(task.duration)
        .bind(&task.recur)
        .bind(task.remind_minutes_before)
        .bind(task.last_notified_at)
        .bind(&task.gcal_event_id)
        .bind(task.id)
        .execute(&*pool)
        .await?;
    }
    crate::tray::refresh(&app).await;
    Ok(task)
}

#[tauri::command]
pub async fn delete_task(app: AppHandle, pool: State<'_, Pool>, id: i64) -> CommandResult<()> {
    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(id)
        .execute(&*pool)
        .await?;
    crate::tray::refresh(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn get_settings(pool: State<'_, Pool>) -> CommandResult<serde_json::Value> {
    let rows = sqlx::query("SELECT key, value FROM settings")
        .fetch_all(&*pool)
        .await?;
    let mut map = serde_json::Map::new();
    for r in rows {
        let k: String = r.get("key");
        let v: String = r.get("value");
        let parsed: serde_json::Value =
            serde_json::from_str(&v).unwrap_or(serde_json::Value::String(v));
        map.insert(k, parsed);
    }
    Ok(serde_json::Value::Object(map))
}

#[tauri::command]
pub async fn save_settings(
    pool: State<'_, Pool>,
    settings: serde_json::Value,
) -> CommandResult<()> {
    let obj = settings
        .as_object()
        .ok_or_else(|| AppError::Other("settings must be an object".into()))?;
    let mut tx = pool.begin().await?;
    for (k, v) in obj {
        let s = serde_json::to_string(v)?;
        sqlx::query(
            "INSERT INTO settings(key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(k)
        .bind(s)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

// ————— Import / Export —————

#[tauri::command]
pub async fn export_tasks_json(pool: State<'_, Pool>, path: String) -> CommandResult<usize> {
    let tasks = list_tasks(pool).await?;
    let json = serde_json::to_string_pretty(&tasks)?;
    std::fs::write(&path, &json).map_err(|e| AppError::Other(format!("write: {e}")))?;
    Ok(tasks.len())
}

#[tauri::command]
pub async fn import_tasks_json(
    app: AppHandle,
    pool: State<'_, Pool>,
    path: String,
) -> CommandResult<usize> {
    let data = std::fs::read_to_string(&path).map_err(|e| AppError::Other(format!("read: {e}")))?;
    let incoming: Vec<Task> = serde_json::from_str(&data)?;
    let mut n = 0;
    for mut t in incoming {
        t.id = 0; // re-key so imports are always inserts
        upsert_task(app.clone(), pool.clone(), t).await?;
        n += 1;
    }
    Ok(n)
}

// ————— Autostart —————
#[cfg(desktop)]
#[tauri::command]
pub async fn set_autostart(app: AppHandle, enabled: bool) -> CommandResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    let r = if enabled { m.enable() } else { m.disable() };
    r.map_err(|e| AppError::Other(format!("autostart: {e}")))?;
    m.is_enabled()
        .map_err(|e| AppError::Other(format!("autostart: {e}")))
}
#[cfg(desktop)]
#[tauri::command]
pub async fn get_autostart(app: AppHandle) -> CommandResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| AppError::Other(format!("autostart: {e}")))
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn set_autostart(_app: AppHandle, _enabled: bool) -> CommandResult<bool> {
    Ok(false)
}
#[cfg(not(desktop))]
#[tauri::command]
pub async fn get_autostart(_app: AppHandle) -> CommandResult<bool> {
    Ok(false)
}
