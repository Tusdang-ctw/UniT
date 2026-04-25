use anyhow::Result;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use std::path::{Path, PathBuf};
use std::str::FromStr;

pub type Pool = SqlitePool;

pub fn db_path(app_name: &str) -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join(app_name);
    std::fs::create_dir_all(&dir).ok();
    let new_path = dir.join("unit.db");

    // One-time migration from the pre-rename "Planned" install.
    // Copy the old DB over if we have nothing here yet.
    if !new_path.exists() {
        let legacy = base.join("Planned").join("planned.db");
        if legacy.exists() {
            let _ = std::fs::copy(&legacy, &new_path);
        }
    }
    new_path
}

pub async fn connect(path: &Path) -> Result<Pool> {
    let url = format!("sqlite://{}", path.display());
    let opts = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    migrate(&pool).await?;
    Ok(pool)
}

async fn migrate(pool: &Pool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            due TEXT,
            time TEXT,
            list TEXT NOT NULL DEFAULT 'tasks',
            starred INTEGER NOT NULL DEFAULT 0,
            done INTEGER NOT NULL DEFAULT 0,
            my_day INTEGER NOT NULL DEFAULT 0,
            note TEXT NOT NULL DEFAULT '',
            tag TEXT,
            created INTEGER NOT NULL,
            gcal_synced INTEGER NOT NULL DEFAULT 0,
            duration INTEGER NOT NULL DEFAULT 30,
            recur TEXT NOT NULL DEFAULT 'none',
            remind_minutes_before INTEGER,
            last_notified_at INTEGER,
            gcal_event_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
        CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list);
        CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}
