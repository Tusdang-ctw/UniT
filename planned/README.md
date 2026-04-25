# UniT — Tasks & Calendar

A native-feeling desktop task manager & calendar built with **Tauri 2 + Vite + TypeScript + Rust**.

Ported from a single-file HTML prototype (`../task_scheduler.html`) into a full desktop app with persistence, background scheduling, and Google Calendar sync.

## Features

- **List + calendar views** — group by date, drag-free week calendar with now-line
- **Natural-language add** — `"Call dentist tomorrow 3pm #meeting"`
- **SQLite persistence** — all tasks live in the OS data dir (`%APPDATA%/UniT/unit.db` on Windows)
- **Background reminders** — tokio task fires native OS notifications even when the window is hidden
- **Recurring tasks** — daily / weekly / weekdays; auto-advance on complete
- **System tray** — today's open-task count, quick-add, quit
- **Global hotkey** — `Ctrl+Shift+Space` focuses the app and the add-input from anywhere
- **Autostart** — optional launch at login
- **Window state** — window position/size persisted across restarts
- **Single instance** — second launch focuses the existing window
- **Import / export** — JSON files via native dialog
- **Google Calendar sync** — OAuth 2.0 PKCE, tokens in OS keychain, push `#meeting` tasks to your primary calendar
- **Dark mode + i18n** — English and Vietnamese

## Prerequisites

- Node.js 20+ and npm
- Rust 1.80+ (`rustup`)
- Platform toolchain: MSVC (Windows), Xcode CLI (macOS), `build-essential + webkit2gtk-4.1 + libssl-dev + librsvg2-dev` (Linux)

## Development

```bash
npm install
npm run tauri dev
```

Vite serves on `http://localhost:1420` and Tauri opens the window.

## Production build

```bash
npm run tauri build
```

Outputs an installer under `src-tauri/target/release/bundle/`:
- Windows: `.msi` and `.exe` (NSIS)
- macOS: `.app` and `.dmg`
- Linux: `.deb`, `.AppImage`, `.rpm`

## Google Calendar setup (optional)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**.
2. Create an **OAuth 2.0 Client ID** of type **Desktop app**.
3. Enable the **Google Calendar API** under **APIs & Services → Library**.
4. Copy the Client ID.
5. In UniT, click **Connect Google Calendar** in the sidebar. Paste the Client ID when prompted.
6. Your browser will open for consent. Approve, and the tab will auto-close.
7. Tokens are stored in your OS keychain under service `unit-app`.

From now on, any task marked **Sync to Google Calendar** (or tagged `#meeting`) will push a calendar event with the title, note, and start/end times.

## Architecture

```
src/                TypeScript frontend
├── app.ts           bootstrap + rendering + event wiring
├── store.ts         Repo interface; SqliteRepo via Tauri invoke, LocalStorageRepo fallback
├── types.ts         Task, Settings, enums
├── i18n.ts          EN/VI dictionaries + {key} interpolation
├── styles.css       light + dark design tokens
└── index.html       shell UI

src-tauri/          Rust backend
├── src/lib.rs       Tauri builder, plugin registration
├── src/db.rs        sqlx + SQLite (WAL), schema migrations
├── src/commands.rs  list/upsert/delete tasks, settings, import/export, autostart
├── src/scheduler.rs background tokio task, native notifications
├── src/tray.rs      tray icon + menu
└── src/gcal.rs      OAuth PKCE + Calendar event push
```

## Enabling auto-update

The `tauri-plugin-updater` dependency is in place but not wired, because it cannot build without a signing key. To turn it on:

1. Generate a keypair:
   ```bash
   npm run tauri signer generate -- -w ~/.tauri/unit.key
   ```
   Copy the public key output.
2. In `src-tauri/tauri.conf.json`, add:
   ```json
   "plugins": {
     "updater": {
       "endpoints": ["https://your-host.example.com/unit/latest.json"],
       "pubkey": "<paste public key here>"
     }
   }
   ```
3. In `src-tauri/src/lib.rs`, register the plugin after the other `.plugin(...)` lines:
   ```rust
   .plugin(tauri_plugin_updater::Builder::new().build())
   ```
4. Set `TAURI_SIGNING_PRIVATE_KEY` (and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) in your release CI environment. Host `latest.json` alongside the signed installers.

## Known limitations

- **Google Calendar pull** is one-way for now (push only). Events created outside UniT won't appear.
- **Recurring tasks** only support daily/weekly/weekdays; no arbitrary RRULE (e.g. "every 2 weeks on Tuesday").
- **Mobile** builds are scaffolded but untested.

## License

MIT.
