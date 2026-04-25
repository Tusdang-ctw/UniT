# UniT

A cross-platform desktop **task manager & calendar** with natural-language input, background reminders, a system-tray quick-add, and Google Calendar sync. Built as a thin **Tauri 2** shell around a TypeScript frontend and a Rust core, so it stays under ~10 MB and feels native on Windows, macOS, and Linux.

The repo also contains the original single-file HTML prototype (`task_scheduler.html`) that the desktop app was ported from — drop it in any browser if you just want to try the UI.

## Features

- **List + week-calendar views** with a now-line and grouped-by-date sections
- **Natural-language add** — `"Call dentist tomorrow 3pm #meeting"` parses date, time, and tag in one shot
- **SQLite persistence** in the OS data dir (`%APPDATA%/UniT/unit.db` on Windows)
- **Background reminders** via a tokio task — native OS notifications fire even when the window is hidden
- **Recurring tasks** — daily / weekly / weekdays, auto-advance on complete
- **System tray** with today's open-task count, quick-add, and quit
- **Global hotkey** — `Ctrl+Shift+Space` focuses the app and the add-input from anywhere
- **Google Calendar sync** — OAuth 2.0 PKCE, tokens in the OS keychain, push `#meeting` tasks to your primary calendar
- **Autostart**, **window-state restore**, **single-instance** focus, **JSON import/export**
- **Dark mode** and **EN / VI** i18n

## Tech Stack

| Layer | Choice |
|---|---|
| Shell | Tauri v2 (Rust) |
| Frontend | TypeScript + Vite (no framework — vanilla DOM) |
| Storage | SQLite via `sqlx` (WAL mode) |
| Scheduler | `tokio` background task + `tauri-plugin-notification` |
| Auth | OAuth 2.0 PKCE → `keyring` (Windows Credential Manager / macOS Keychain / Secret Service) |
| Plugins | `notification`, `dialog`, `fs`, `window-state`, `autostart`, `global-shortcut`, `single-instance`, `updater` (scaffolded) |

## Running Locally

The full walkthrough — including Google Calendar setup and the optional auto-update wiring — lives in [`planned/README.md`](./planned/README.md). In short:

```bash
cd planned

# 1. Install Node 20+ and Rust (rustup)
# 2. Install dependencies
npm install

# 3. Run the desktop app
npm run tauri dev
```

To build an installer:

```bash
npm run tauri build
```

Outputs land in `planned/src-tauri/target/release/bundle/` — `.msi`/`.exe` on Windows, `.app`/`.dmg` on macOS, `.deb`/`.AppImage`/`.rpm` on Linux.

## Architecture

```
┌────────────────────────────────────────┐
│              Tauri App                 │
│                                        │
│  ┌─────────────┐    ┌───────────────┐  │
│  │  WebView    │    │  Rust Core    │  │
│  │  TS + Vite  │◄──►│  Commands +   │  │
│  │  UI         │    │  Event bus    │  │
│  └─────────────┘    └───────┬───────┘  │
│                             │          │
│            ┌────────────────┼────────┐ │
│            │                │        │ │
│       ┌────▼────┐   ┌───────▼──┐  ┌──▼──────┐
│       │ SQLite  │   │ Tokio    │  │ Keyring │
│       │ (sqlx)  │   │ scheduler│  │ (OAuth) │
│       └─────────┘   └────┬─────┘  └─────────┘
└────────────────────────┬─┴───────────────────┘
                         │ HTTPS
                  ┌──────▼───────┐
                  │ Google Cal   │
                  └──────────────┘
```

The Rust side exposes commands the frontend calls via `invoke`:

- `list_tasks / upsert_task / delete_task / settings_*` — SQLite CRUD
- `import_json / export_json` — native file dialogs
- `gcal_start_auth / gcal_complete_auth / gcal_push_event` — OAuth PKCE + Calendar push

A long-running tokio task wakes every minute, queries due-and-not-yet-notified tasks, and emits OS notifications.

## Known Limitations

- **Google Calendar is push-only.** Events created in Google won't show up in UniT — pull/two-way sync is out of scope for v0.2.
- **Recurring tasks** support daily / weekly / weekdays only. No arbitrary RRULE (e.g. "every other Tuesday").
- **Auto-update is scaffolded but disabled** — needs a Tauri signing keypair, an update endpoint, and `TAURI_SIGNING_PRIVATE_KEY` at build time. See the *Enabling auto-update* section in `planned/README.md`.
- **Mobile** (Android/iOS) targets are scaffolded by Tauri but untested.

## Project Layout

```
UniT/
├── task_scheduler.html        # Original single-file browser prototype
└── planned/                   # Desktop app
    ├── src/                   # TypeScript frontend (Vite, vanilla DOM)
    │   ├── app.ts             # bootstrap, render, event wiring
    │   ├── store.ts           # SqliteRepo (Tauri invoke) + LocalStorage fallback
    │   ├── i18n.ts            # EN / VI dictionaries
    │   └── styles.css         # design tokens, light + dark
    ├── src-tauri/             # Rust backend
    │   ├── src/db.rs          # sqlx + SQLite schema/migrations
    │   ├── src/commands.rs    # Tauri commands exposed to the frontend
    │   ├── src/scheduler.rs   # tokio reminder loop + notifications
    │   ├── src/tray.rs        # tray icon + menu
    │   ├── src/gcal.rs        # OAuth PKCE + Calendar event push
    │   ├── capabilities/      # Tauri v2 permissions
    │   ├── icons/
    │   └── tauri.conf.json
    └── README.md              # Full setup & ops guide
```

## License

MIT.
