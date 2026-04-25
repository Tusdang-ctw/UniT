import type { Task, Settings } from './types';
import { DEFAULT_SETTINGS } from './types';

// Lazy import so non-Tauri dev contexts still build.
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
async function getInvoke(): Promise<Invoke | null> {
  try {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke as Invoke;
  } catch {
    return null;
  }
}

export interface Repo {
  init(): Promise<void>;
  listTasks(): Promise<Task[]>;
  upsertTask(t: Task): Promise<Task>;
  deleteTask(id: number): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
}

// ————— SQLite (via Tauri) —————
class SqliteRepo implements Repo {
  constructor(private invoke: Invoke) {}
  async init() {}
  async listTasks(): Promise<Task[]> {
    return await this.invoke<Task[]>('list_tasks');
  }
  async upsertTask(t: Task): Promise<Task> {
    return await this.invoke<Task>('upsert_task', { task: t });
  }
  async deleteTask(id: number): Promise<void> {
    await this.invoke<void>('delete_task', { id });
  }
  async getSettings(): Promise<Settings> {
    const raw = await this.invoke<Partial<Settings>>('get_settings');
    return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  }
  async saveSettings(s: Settings): Promise<void> {
    await this.invoke<void>('save_settings', { settings: s });
  }
}

// ————— localStorage fallback (for browser-only dev / preview) —————
const TASK_KEY = 'unit:tasks';
const SETTINGS_KEY = 'unit:settings';
const NEXT_ID_KEY = 'unit:nextId';

class LocalStorageRepo implements Repo {
  async init() {
    if (!localStorage.getItem(TASK_KEY)) localStorage.setItem(TASK_KEY, '[]');
    if (!localStorage.getItem(NEXT_ID_KEY)) localStorage.setItem(NEXT_ID_KEY, '1');
  }
  async listTasks(): Promise<Task[]> {
    try { return JSON.parse(localStorage.getItem(TASK_KEY) ?? '[]'); } catch { return []; }
  }
  async upsertTask(t: Task): Promise<Task> {
    const all = await this.listTasks();
    if (!t.id) {
      const n = parseInt(localStorage.getItem(NEXT_ID_KEY) ?? '1', 10);
      t.id = n;
      localStorage.setItem(NEXT_ID_KEY, String(n + 1));
    }
    const i = all.findIndex((x) => x.id === t.id);
    if (i >= 0) all[i] = t; else all.push(t);
    localStorage.setItem(TASK_KEY, JSON.stringify(all));
    return t;
  }
  async deleteTask(id: number) {
    const all = (await this.listTasks()).filter((t) => t.id !== id);
    localStorage.setItem(TASK_KEY, JSON.stringify(all));
  }
  async getSettings(): Promise<Settings> {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; } catch { return { ...DEFAULT_SETTINGS }; }
  }
  async saveSettings(s: Settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

let _repo: Repo | null = null;
export async function getRepo(): Promise<Repo> {
  if (_repo) return _repo;
  const invoke = await getInvoke();
  const isTauri = !!(globalThis as any).__TAURI_INTERNALS__;
  _repo = invoke && isTauri ? new SqliteRepo(invoke) : new LocalStorageRepo();
  await _repo.init();
  return _repo;
}
