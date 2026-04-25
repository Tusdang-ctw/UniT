import './styles.css';
import type { Task, ListId, ViewId, Mode, RecurRule } from './types';
import { emptyTask } from './types';
import { getRepo } from './store';
import type { Repo } from './store';
import { apply as applyI18n, setLocale, t } from './i18n';
import type { Locale } from './i18n';
let repo: Repo;

const darkMq: MediaQueryList | null = typeof matchMedia === 'function'
  ? matchMedia('(prefers-color-scheme: dark)')
  : null;
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

function applyTheme(theme: 'light' | 'dark' | 'system') {
  const prefersDark = darkMq?.matches ?? false;
  const dark = theme === 'dark' || (theme === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);

  // Keep the UI in sync with the OS when the user is on 'system'.
  if (!darkMq) return;
  if (systemThemeListener) {
    darkMq.removeEventListener('change', systemThemeListener);
    systemThemeListener = null;
  }
  if (theme === 'system') {
    systemThemeListener = (e) => {
      document.documentElement.classList.toggle('dark', e.matches);
    };
    darkMq.addEventListener('change', systemThemeListener);
  }
}

async function wireThemeAndLocale() {
  const settings = await repo.getSettings();
  applyTheme(settings.theme);
  setLocale((settings.locale as Locale) || 'en');
  applyI18n();

  const sel = $<HTMLSelectElement>('#sel-locale');
  if (sel) {
    sel.value = settings.locale || 'en';
    sel.addEventListener('change', async () => {
      setLocale(sel.value as Locale);
      applyI18n();
      settings.locale = sel.value;
      await repo.saveSettings(settings);
      // Re-render derived text (view title/subtitle + dynamic labels)
      const active = $<HTMLElement>('.nav-item.active[data-view]');
      if (active) (active as HTMLElement).click();
      render();
      renderDetail();
    });
  }

  const btn = $<HTMLButtonElement>('#btn-theme');
  if (btn) {
    btn.addEventListener('click', async () => {
      const next = settings.theme === 'dark' ? 'light' : 'dark';
      settings.theme = next;
      applyTheme(next);
      await repo.saveSettings(settings);
    });
  }
}

async function ensureNotificationPermission(): Promise<void> {
  try {
    const mod = await import('@tauri-apps/plugin-notification');
    let granted = await mod.isPermissionGranted();
    if (!granted) {
      const p = await mod.requestPermission();
      granted = p === 'granted';
    }
    if (!granted) console.warn('Notifications not permitted');
  } catch { /* non-Tauri context */ }
}

async function maybePushToGcal(t: Task): Promise<void> {
  if (!t.gcalSynced || !t.due || !t.time) return;
  try {
    const settings = await repo.getSettings();
    if (!settings.gcalConnected || !settings.gcalClientId) return;
    const coreMod = await import('@tauri-apps/api/core');
    const updated = await coreMod.invoke<Task>('gcal_push_task', {
      clientId: settings.gcalClientId,
      task: t,
    });
    t.gcalEventId = updated.gcalEventId;
    await repo.upsertTask(t);
  } catch (e) {
    console.warn('gcal push failed:', e);
  }
}

// ————— Tick sound (Microsoft To Do style) —————
let tickAudioCtx: AudioContext | null = null;
function playTickSound(): void {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    tickAudioCtx ||= new AC();
    if (tickAudioCtx.state === 'suspended') void tickAudioCtx.resume();
    const ctx = tickAudioCtx;
    const now = ctx.currentTime;
    // Two-note chime: E6 then A6, short with exponential decay.
    [1318.5, 1760].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.06;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch { /* audio unavailable */ }
}

async function toggleDone(t: Task): Promise<void> {
  if (!t.done && t.recur !== 'none') {
    const base = t.due ?? todayISO();
    const next = nextOccurrence(base, t.recur);
    if (next) {
      t.due = next;
      t.lastNotifiedAt = null;
      await repo.upsertTask(t);
      return;
    }
  }
  t.done = !t.done;
  await repo.upsertTask(t);
}

function nextOccurrence(dueISO: string, rule: Task['recur']): string | null {
  if (rule === 'none') return null;
  const d = new Date(dueISO + 'T00:00:00');
  if (rule === 'daily') d.setDate(d.getDate() + 1);
  else if (rule === 'weekly') d.setDate(d.getDate() + 7);
  else if (rule === 'weekdays') {
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  }
  return localISO(d);
}

// ————— State —————
let tasks: Task[] = [];
let selectedId: number | null = null;
let currentMode: Mode = 'list';
let currentView: ViewId = 'planned';
let calWeekStart = startOfWeek(new Date());

// ————— DOM helpers —————
const $ = <T extends Element = HTMLElement>(q: string, c: ParentNode = document) =>
  c.querySelector(q) as T | null;
const $$ = <T extends Element = HTMLElement>(q: string, c: ParentNode = document) =>
  Array.from(c.querySelectorAll(q)) as T[];

const mustGet = <T extends Element = HTMLElement>(q: string): T => {
  const el = $<T>(q);
  if (!el) throw new Error(`missing: ${q}`);
  return el;
};

// ————— Date helpers —————
// Local-date YYYY-MM-DD (avoids UTC drift for users east of UTC at night).
function localISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayISO(): string { return localISO(new Date()); }
function tomorrowISO(): string {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return localISO(d);
}
function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const dow = out.getDay(); // 0=Sun
  out.setDate(out.getDate() - dow);
  return out;
}
function formatDateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function formatTime(t: string | null): string | null {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, '0')} ${period}`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

// ————— Natural language parser —————
interface Parsed {
  title: string;
  due: string | null;
  time: string | null;
  tag: Task['tag'];
  list: ListId;
  duration: number | null;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
const WEEKDAY_PATTERN = Object.keys(WEEKDAYS).join('|');

// Next occurrence of `target` weekday. `forceNextWeek` skips to 7–13 days out
// (for the "next monday" phrasing).
function nextWeekdayISO(target: number, forceNextWeek: boolean): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  let delta = (target - d.getDay() + 7) % 7;
  if (delta === 0 || forceNextWeek) delta += 7;
  d.setDate(d.getDate() + delta);
  return localISO(d);
}

function parseInput(raw: string): Parsed {
  let text = raw.trim();
  let due: string | null = null;
  let time: string | null = null;
  let tag: Task['tag'] = null;
  let list: ListId = 'tasks';
  let duration: number | null = null;

  const tagMatch = text.match(/#(\w+)/);
  if (tagMatch) {
    const tg = tagMatch[1].toLowerCase();
    if (tg === 'meeting') { tag = 'meeting'; list = 'meeting'; }
    else if (tg === 'work') { tag = 'work'; list = 'work'; }
    else if (tg === 'personal') { tag = 'personal'; list = 'personal'; }
    text = text.replace(tagMatch[0], '').trim();
  }

  if (/\btoday\b/i.test(text)) {
    due = todayISO();
    text = text.replace(/\btoday\b/i, '').trim();
  } else if (/\btomorrow\b/i.test(text)) {
    due = tomorrowISO();
    text = text.replace(/\btomorrow\b/i, '').trim();
  } else {
    const inDays = text.match(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/i);
    if (inDays) {
      const n = parseInt(inDays[1], 10);
      const unit = inDays[2].toLowerCase().startsWith('week') ? 7 : 1;
      const d = new Date();
      d.setDate(d.getDate() + n * unit);
      due = localISO(d);
      text = text.replace(inDays[0], '').trim();
    } else {
      const wd = text.match(new RegExp(`\\b(next\\s+)?(${WEEKDAY_PATTERN})\\b`, 'i'));
      if (wd) {
        const target = WEEKDAYS[wd[2].toLowerCase()];
        due = nextWeekdayISO(target, !!wd[1]);
        text = text.replace(wd[0], '').trim();
      }
    }
  }

  // 12-hour time takes priority (e.g. "3pm")
  const timeMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const p = timeMatch[3].toLowerCase();
    if (p === 'pm' && h < 12) h += 12;
    if (p === 'am' && h === 12) h = 0;
    time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    text = text.replace(timeMatch[0], '').trim();
  } else {
    // 24-hour time "HH:mm" (requires the colon to avoid eating every number)
    const t24 = text.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (t24) {
      time = `${String(parseInt(t24[1], 10)).padStart(2, '0')}:${t24[2]}`;
      text = text.replace(t24[0], '').trim();
    }
  }

  // Duration: "for 30m", "for 1h", "for 45min"
  const dur = text.match(/\bfor\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)\b/i);
  if (dur) {
    const n = parseInt(dur[1], 10);
    const unit = dur[2].toLowerCase();
    duration = unit.startsWith('h') ? n * 60 : n;
    text = text.replace(dur[0], '').trim();
  }

  // Collapse double spaces left behind after stripping tokens.
  const title = text.replace(/\s+/g, ' ').trim() || raw.trim();
  return { title, due, time, tag, list, duration };
}

// ————— Filter by current view —————
// Completed tasks disappear from every list; they're still on disk and still
// reachable via the detail panel if something was ticked by mistake.
function visibleTasks(): Task[] {
  const live = tasks.filter((t) => !t.done);
  switch (currentView) {
    case 'my-day':    return live.filter((t) => t.myDay || t.due === todayISO());
    case 'important': return live.filter((t) => t.starred);
    case 'tasks':     return live;
    case 'planned':   return live.filter((t) => !!t.due);
    default:
      if (currentView.startsWith('list:')) {
        const id = currentView.slice(5) as ListId;
        return live.filter((t) => t.list === id);
      }
      return live;
  }
}

// ————— List rendering —————
function render() {
  const container = mustGet('#groups-container');
  container.innerHTML = '';

  const visible = visibleTasks();
  const open = tasks.filter((t) => !t.done);
  mustGet('#count-planned').textContent = String(open.filter((t) => t.due).length);
  mustGet('#count-my-day').textContent = String(open.filter((t) => t.myDay || t.due === todayISO()).length);

  // Group by date; tasks without due date go under "Someday"
  const groups: Record<string, Task[]> = {};
  visible.forEach((t) => {
    const key = t.due ?? '__someday';
    (groups[key] ??= []).push(t);
  });

  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === '__someday') return 1;
    if (b === '__someday') return -1;
    return a.localeCompare(b);
  });

  if (sortedKeys.length === 0) {
    container.innerHTML = `<div class="empty">${t('empty.noTasks')}</div>`;
    return;
  }

  const todayKey = todayISO();
  for (const key of sortedKeys) {
    const label = key === '__someday' ? t('someday') : formatDateLabel(key);
    const isOverdueGroup = key !== '__someday' && key < todayKey;
    const group = document.createElement('div');
    group.className = 'group' + (isOverdueGroup ? ' overdue' : '');
    group.innerHTML = `
      <div class="group-header${isOverdueGroup ? ' overdue' : ''}" data-date="${key}">
        <svg class="chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 9l6 6 6-6"/></svg>
        <span>${label}</span>
        <span class="count">${groups[key].length}</span>
      </div>
      <div class="task-list" data-list="${key}"></div>
    `;
    container.appendChild(group);

    const listEl = group.querySelector('.task-list') as HTMLElement;
    groups[key]
      .sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'))
      .forEach((t) => listEl.appendChild(taskCard(t)));

    (group.querySelector('.group-header') as HTMLElement).addEventListener('click', (e) => {
      const hdr = e.currentTarget as HTMLElement;
      hdr.classList.toggle('collapsed');
      listEl.classList.toggle('hidden');
    });
  }
}

function taskCard(t: Task): HTMLElement {
  const el = document.createElement('div');
  const overdue = !!t.due && !t.done && t.due < todayISO();
  el.className = 'task'
    + (t.done ? ' done' : '')
    + (overdue ? ' overdue' : '')
    + (t.id === selectedId ? ' selected' : '');
  el.dataset.id = String(t.id);

  const tagHtml = t.tag ? `<span class="tag ${t.tag}">${t.tag}</span>` : '';
  const timeHtml = t.time
    ? `<span class="chip"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 7v5l3 2"/></svg>${formatTime(t.time)}</span>`
    : '';
  const syncHtml = t.gcalSynced
    ? `<span class="chip" title="Synced to Google Calendar"><svg fill="none" stroke="#0f62fe" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path stroke-linecap="round" d="M3 9h18"/></svg><span style="color: var(--accent-deep); font-weight:500;">Google Calendar</span></span>`
    : '';
  const listHtml = `<span class="chip">${t.list === 'meeting' ? 'Meetings' : t.list.charAt(0).toUpperCase() + t.list.slice(1)}</span>`;
  const recurHtml = t.recur && t.recur !== 'none' ? `<span class="chip" title="Repeats ${t.recur}">↻ ${t.recur}</span>` : '';

  el.innerHTML = `
    <div class="checkbox">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12l5 5L20 7"/></svg>
    </div>
    <div class="task-body">
      <div class="task-title">${escapeHtml(t.title.replace(/#\w+/g, '').trim())}</div>
      <div class="task-meta">
        ${tagHtml}
        ${listHtml}
        ${timeHtml ? `<span class="dot">·</span>${timeHtml}` : ''}
        ${recurHtml ? `<span class="dot">·</span>${recurHtml}` : ''}
        ${syncHtml ? `<span class="dot">·</span>${syncHtml}` : ''}
      </div>
    </div>
    <button class="star-btn ${t.starred ? 'starred' : ''}" data-star="${t.id}">
      <svg fill="${t.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2l2.9 6.3 6.9.7-5.2 4.8L18 21l-6-3.5L6 21l1.4-7.2L2.2 9l6.9-.7L12 2z"/></svg>
    </button>
  `;

  (el.querySelector('.checkbox') as HTMLElement).addEventListener('click', async (e) => {
    e.stopPropagation();
    const willComplete = !t.done;
    if (willComplete) {
      el.classList.add('ticking');
      playTickSound();
      await new Promise((r) => setTimeout(r, 420));
    }
    await toggleDone(t);
    render();
    if (selectedId === t.id) renderDetail();
  });
  (el.querySelector('[data-star]') as HTMLElement).addEventListener('click', async (e) => {
    e.stopPropagation();
    t.starred = !t.starred;
    await repo.upsertTask(t);
    render();
  });
  el.addEventListener('click', () => {
    selectedId = t.id;
    render();
    renderDetail();
  });

  return el;
}

// ————— Detail panel —————
function renderDetail() {
  const body = mustGet('#detail-body');
  const footer = mustGet('#detail-footer');
  const task = tasks.find((t) => t.id === selectedId);

  if (!task) {
    body.innerHTML = `<div class="empty">${t('empty.selectTask')}</div>`;
    footer.style.display = 'none';
    return;
  }

  footer.style.display = 'flex';
  const createdDate = new Date(task.created).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  mustGet('#created-stamp').textContent = `Created ${createdDate}`;

  body.innerHTML = `
    <div class="detail-title-card">
      <div class="checkbox" id="d-checkbox" style="${task.done ? 'background:var(--accent);border-color:var(--accent);' : ''}">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" style="opacity:${task.done ? 1 : 0}"><path stroke-linecap="round" d="M5 12l5 5L20 7"/></svg>
      </div>
      <input id="d-title" value="${escapeHtml(task.title)}" />
      <button class="star-btn ${task.starred ? 'starred' : ''}" id="d-star">
        <svg fill="${task.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2l2.9 6.3 6.9.7-5.2 4.8L18 21l-6-3.5L6 21l1.4-7.2L2.2 9l6.9-.7L12 2z"/></svg>
      </button>
    </div>

    <div class="detail-action ${task.myDay ? 'active' : ''}" id="d-myday">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path stroke-linecap="round" d="M12 3v1M12 20v1M4.93 4.93l.7.7M18.36 18.36l.71.71M3 12h1M20 12h1M4.93 19.07l.7-.7M18.36 5.64l.71-.71"/></svg>
      <span>${task.myDay ? 'Added to My Day' : 'Add to My Day'}</span>
      ${task.myDay ? '<div class="clear" id="clear-myday"><svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M6 6l12 12M6 18L18 6"/></svg></div>' : ''}
    </div>

    <div class="detail-action ${task.remindMinutesBefore != null ? 'active' : ''}" id="d-remind">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 17h5l-1.4-1.4A2 2 0 0118 14V11a6 6 0 00-4-5.7V5a2 2 0 00-4 0v.3A6 6 0 006 11v3a2 2 0 01-.6 1.6L4 17h5m6 0a3 3 0 11-6 0"/></svg>
      <span>${task.remindMinutesBefore != null ? `Remind ${task.remindMinutesBefore} min before` : 'Remind me'}</span>
      ${task.remindMinutesBefore != null ? '<div class="clear" id="clear-remind"><svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M6 6l12 12M6 18L18 6"/></svg></div>' : ''}
    </div>

    <div class="detail-action ${task.due ? 'active' : ''}" id="d-due">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path stroke-linecap="round" d="M3 9h18M8 2v4M16 2v4"/></svg>
      <span>${task.due ? `Due ${formatDateLabel(task.due)}${task.time ? ' · ' + formatTime(task.time) : ''}` : 'Add due date'}</span>
      ${task.due ? '<div class="clear" id="clear-due"><svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M6 6l12 12M6 18L18 6"/></svg></div>' : ''}
    </div>

    <div class="detail-action ${task.recur !== 'none' ? 'active' : ''}" id="d-recur">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 4v6h6M20 20v-6h-6M20 9A8 8 0 006 5M4 15a8 8 0 0014 4"/></svg>
      <span>${task.recur === 'none' ? 'Repeat' : `Repeats ${task.recur}`}</span>
    </div>

    <div class="detail-action ${task.gcalSynced ? 'active' : ''}" id="d-gcal">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path stroke-linecap="round" d="M3 9h18"/></svg>
      <span>${task.gcalSynced ? 'Synced to Google Calendar' : 'Sync to Google Calendar'}</span>
    </div>

    <div class="note-box">
      <textarea id="d-note" placeholder="Add note">${escapeHtml(task.note || '')}</textarea>
    </div>
  `;

  mustGet('#d-checkbox').addEventListener('click', async () => {
    const willComplete = !task.done;
    if (willComplete) playTickSound();
    await toggleDone(task); render(); renderDetail();
  });
  mustGet<HTMLInputElement>('#d-title').addEventListener('change', async (e) => {
    task.title = (e.target as HTMLInputElement).value;
    await repo.upsertTask(task); render();
    void maybePushToGcal(task);
  });
  mustGet('#d-star').addEventListener('click', async () => {
    task.starred = !task.starred; await repo.upsertTask(task); render(); renderDetail();
  });
  mustGet('#d-myday').addEventListener('click', async (e) => {
    if ((e.target as HTMLElement).closest('#clear-myday')) task.myDay = false;
    else task.myDay = !task.myDay;
    await repo.upsertTask(task); render(); renderDetail();
  });
  mustGet('#d-due').addEventListener('click', async (e) => {
    if ((e.target as HTMLElement).closest('#clear-due')) {
      task.due = null; task.time = null;
      await repo.upsertTask(task); render(); renderDetail();
      return;
    }
    openDatePicker(task, e.currentTarget as HTMLElement);
  });
  mustGet('#d-recur').addEventListener('click', async () => {
    const order: RecurRule[] = ['none', 'daily', 'weekly', 'weekdays'];
    const i = order.indexOf(task.recur);
    task.recur = order[(i + 1) % order.length];
    await repo.upsertTask(task); render(); renderDetail();
  });
  mustGet('#d-remind').addEventListener('click', async (e) => {
    if ((e.target as HTMLElement).closest('#clear-remind')) {
      task.remindMinutesBefore = null;
    } else {
      const v = prompt('Remind how many minutes before the scheduled time?', String(task.remindMinutesBefore ?? 10));
      if (v === null) return;
      const n = parseInt(v, 10);
      task.remindMinutesBefore = Number.isFinite(n) && n >= 0 ? n : null;
    }
    await repo.upsertTask(task); renderDetail();
  });
  mustGet('#d-gcal').addEventListener('click', async () => {
    task.gcalSynced = !task.gcalSynced;
    if (task.gcalSynced) { task.tag = 'meeting'; task.list = 'meeting'; }
    await repo.upsertTask(task); render(); renderDetail();
    if (currentMode === 'calendar') renderCalendar();
    if (task.gcalSynced) void maybePushToGcal(task);
  });
  mustGet<HTMLTextAreaElement>('#d-note').addEventListener('change', async (e) => {
    task.note = (e.target as HTMLTextAreaElement).value;
    await repo.upsertTask(task);
    void maybePushToGcal(task);
  });
}

// ————— Date picker popover —————
let dpTarget: Task | null = null;
let dpMonth: Date = new Date();
let dpSelected: string | null = null;

function openDatePicker(task: Task, anchor: HTMLElement) {
  dpTarget = task;
  dpSelected = task.due;
  dpMonth = task.due ? new Date(task.due + 'T00:00:00') : new Date();
  const pop = mustGet<HTMLDivElement>('#date-popover');
  mustGet<HTMLInputElement>('#dp-time').value = task.time ?? '';
  renderDatePicker();

  pop.classList.add('visible');
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left;
  if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 6;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.max(8, left)}px`;
}

function closeDatePicker() {
  mustGet('#date-popover').classList.remove('visible');
  dpTarget = null;
}

function renderDatePicker() {
  mustGet('#dp-label').textContent = dpMonth.toLocaleDateString('en-US', {
    month: 'long', year: 'numeric',
  });

  const grid = mustGet('#dp-grid');
  grid.innerHTML = '';

  const first = new Date(dpMonth.getFullYear(), dpMonth.getMonth(), 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(dpMonth.getFullYear(), dpMonth.getMonth() + 1, 0).getDate();
  const prevMonthDays = new Date(dpMonth.getFullYear(), dpMonth.getMonth(), 0).getDate();
  const todayStr = todayISO();

  // Leading (prev month) days
  for (let i = startDow - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const date = new Date(dpMonth.getFullYear(), dpMonth.getMonth() - 1, d);
    grid.appendChild(dayCell(date, true));
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(dpMonth.getFullYear(), dpMonth.getMonth(), d);
    grid.appendChild(dayCell(date, false));
  }
  // Trailing (next month) to fill to 6 rows (42 cells)
  const total = grid.children.length;
  for (let i = 0; i < 42 - total; i++) {
    const date = new Date(dpMonth.getFullYear(), dpMonth.getMonth() + 1, i + 1);
    grid.appendChild(dayCell(date, true));
  }

  function dayCell(date: Date, muted: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'dp-day' + (muted ? ' muted' : '');
    const iso = localISO(date);
    if (iso === todayStr) el.classList.add('today');
    if (iso === dpSelected) el.classList.add('selected');
    el.textContent = String(date.getDate());
    el.addEventListener('click', () => {
      dpSelected = iso;
      renderDatePicker();
    });
    return el;
  }
}

function wireDatePicker() {
  const pop = mustGet('#date-popover');
  mustGet('#dp-prev').addEventListener('click', () => {
    dpMonth = new Date(dpMonth.getFullYear(), dpMonth.getMonth() - 1, 1);
    renderDatePicker();
  });
  mustGet('#dp-next').addEventListener('click', () => {
    dpMonth = new Date(dpMonth.getFullYear(), dpMonth.getMonth() + 1, 1);
    renderDatePicker();
  });
  pop.querySelectorAll<HTMLButtonElement>('.dp-quick button').forEach((b) => {
    b.addEventListener('click', () => {
      const preset = b.dataset.preset;
      const d = new Date();
      if (preset === 'tomorrow') d.setDate(d.getDate() + 1);
      else if (preset === 'nextWeek') d.setDate(d.getDate() + 7);
      dpSelected = localISO(d);
      dpMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      renderDatePicker();
    });
  });
  mustGet('#dp-clear').addEventListener('click', async () => {
    if (!dpTarget) return;
    dpTarget.due = null;
    dpTarget.time = null;
    await repo.upsertTask(dpTarget);
    closeDatePicker();
    render();
    renderDetail();
  });
  mustGet('#dp-save').addEventListener('click', async () => {
    if (!dpTarget) return;
    dpTarget.due = dpSelected;
    const time = mustGet<HTMLInputElement>('#dp-time').value;
    dpTarget.time = time || null;
    dpTarget.lastNotifiedAt = null;
    await repo.upsertTask(dpTarget);
    closeDatePicker();
    render();
    renderDetail();
    if (currentMode === 'calendar') renderCalendar();
    void maybePushToGcal(dpTarget);
  });
  // click-away
  document.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement;
    if (!pop.classList.contains('visible')) return;
    if (pop.contains(target)) return;
    // don't close if user clicked the d-due action itself (its own handler toggles)
    if (target.closest('#d-due')) return;
    closeDatePicker();
  });
}


// ————— Calendar —————
function renderCalendar() {
  const header = mustGet('#week-header');
  const body = mustGet('#week-body');
  header.innerHTML = '<div class="col-gutter"></div>';

  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(calWeekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
    const isToday = d.toDateString() === new Date().toDateString();
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    header.insertAdjacentHTML('beforeend', `
      <div>
        <div>${weekday}</div>
        <div class="day-num ${isToday ? 'today' : ''}">${d.getDate()}</div>
      </div>
    `);
  }

  mustGet('#cal-month-label').textContent = days[0].toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  body.innerHTML = '';
  const { startHour, endHour } = computeHourRange(days);
  const hourHeight = 44;
  for (let h = startHour; h <= endHour; h++) {
    const hourLabel = h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : h === 0 ? '12 AM' : `${h} AM`;
    body.insertAdjacentHTML('beforeend', `<div class="hour-label">${hourLabel}</div>`);
    for (let d = 0; d < 7; d++) {
      body.insertAdjacentHTML('beforeend', `<div class="day-cell" data-day="${d}" data-hour="${h}"></div>`);
    }
  }

  tasks.forEach((t) => {
    if (t.done || !t.due || !t.time) return;
    const taskDate = new Date(t.due + 'T00:00:00');
    const dayIdx = days.findIndex((d) => d.toDateString() === taskDate.toDateString());
    if (dayIdx === -1) return;

    const [h, m] = t.time.split(':').map(Number);
    if (h < startHour || h > endHour) return;

    const duration = t.duration || (t.tag === 'meeting' ? 30 : 30);
    const topOffset = (h - startHour) * hourHeight + (m / 60) * hourHeight;
    const height = Math.max(26, (duration / 60) * hourHeight);
    const isMeeting = t.tag === 'meeting' || t.gcalSynced;

    const evt = document.createElement('div');
    const compact = duration < 45;
    evt.className = 'event'
      + (isMeeting ? '' : ' task-event')
      + (compact ? ' compact' : '');
    evt.style.top = topOffset + 'px';
    evt.style.height = height + 'px';
    evt.style.left = `calc(${dayIdx * (100 / 7)}% + 52px * ${(7 - dayIdx) / 7} + 4px)`;
    evt.style.width = `calc(${100 / 7}% - 52px / 7 - 8px)`;
    const displayTitle = t.title.replace(/#\w+/g, '').trim() || t.title;
    const timeRange = `${formatTime(t.time)}${duration >= 30 ? ` – ${formatEndTime(h, m, duration)}` : ''}`;
    // Native browser tooltip for the full text, since short blocks always truncate.
    evt.title = `${displayTitle}\n${timeRange}${t.note ? `\n\n${t.note}` : ''}`;
    evt.innerHTML = `
      <span class="e-title">${escapeHtml(displayTitle)}</span>
      <span class="e-time">${timeRange}</span>
    `;
    evt.addEventListener('click', () => { selectedId = t.id; renderDetail(); });
    body.appendChild(evt);
  });

  const now = new Date();
  const todayIdx = days.findIndex((d) => d.toDateString() === now.toDateString());
  if (todayIdx !== -1 && now.getHours() >= startHour && now.getHours() <= endHour) {
    const nowOffset = (now.getHours() - startHour) * hourHeight + (now.getMinutes() / 60) * hourHeight;
    const line = document.createElement('div');
    line.className = 'now-line';
    line.style.top = nowOffset + 'px';
    body.appendChild(line);
  }
}
function formatEndTime(h: number, m: number, dMin: number): string | null {
  const total = h * 60 + m + dMin;
  const eh = Math.floor(total / 60), em = total % 60;
  return formatTime(`${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`);
}

// Fit the week grid to the tasks it actually contains, with 1-hour padding.
// Falls back to 07:00–21:00 when the visible week has no timed tasks.
function computeHourRange(days: Date[]): { startHour: number; endHour: number } {
  const dayKeys = new Set(days.map((d) => d.toDateString()));
  let min = 24, max = -1;
  for (const t of tasks) {
    if (t.done || !t.due || !t.time) continue;
    const taskDate = new Date(t.due + 'T00:00:00');
    if (!dayKeys.has(taskDate.toDateString())) continue;
    const h = parseInt(t.time.split(':')[0], 10);
    if (Number.isNaN(h)) continue;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  if (max === -1) return { startHour: 7, endHour: 21 };
  return { startHour: Math.max(0, min - 1), endHour: Math.min(23, max + 1) };
}

// ————— Bootstrapping —————
async function wireEvents() {
  mustGet('#delete-task').addEventListener('click', async () => {
    if (selectedId == null) return;
    await repo.deleteTask(selectedId);
    tasks = tasks.filter((t) => t.id !== selectedId);
    selectedId = null;
    render(); renderDetail();
    if (currentMode === 'calendar') renderCalendar();
  });
  mustGet('#close-detail').addEventListener('click', () => {
    selectedId = null; render(); renderDetail();
  });

  mustGet<HTMLInputElement>('#add-input').addEventListener('keydown', async (e) => {
    const input = e.target as HTMLInputElement;
    if (e.key === 'Enter' && input.value.trim()) {
      const parsed = parseInput(input.value);
      // Quick-adds with no parsed date land on today, not Someday.
      const due = parsed.due ?? todayISO();
      const t = emptyTask({
        title: parsed.title,
        due,
        time: parsed.time,
        list: parsed.list,
        tag: parsed.tag,
        myDay: due === todayISO(),
        gcalSynced: parsed.tag === 'meeting',
        duration: parsed.duration ?? 30,
      });
      const saved = await repo.upsertTask(t);
      tasks.push(saved);
      input.value = '';
      selectedId = saved.id;
      render(); renderDetail();
      if (currentMode === 'calendar') renderCalendar();
    }
  });


  $$('.view-switch button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.view-switch button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = (btn as HTMLElement).dataset.mode as Mode;
      if (currentMode === 'calendar') {
        (mustGet('#list-view') as HTMLElement).style.display = 'none';
        mustGet('#calendar-view').classList.add('visible');
        renderCalendar();
      } else {
        (mustGet('#list-view') as HTMLElement).style.display = '';
        mustGet('#calendar-view').classList.remove('visible');
      }
    });
  });

  mustGet('#cal-prev').addEventListener('click', () => {
    calWeekStart.setDate(calWeekStart.getDate() - 7);
    renderCalendar();
  });
  mustGet('#cal-next').addEventListener('click', () => {
    calWeekStart.setDate(calWeekStart.getDate() + 7);
    renderCalendar();
  });
  mustGet('#cal-today-btn').addEventListener('click', () => {
    calWeekStart = startOfWeek(new Date());
    renderCalendar();
  });

  $$('.nav-item[data-view]').forEach((item) => {
    item.addEventListener('click', () => {
      $$('.nav-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      const view = (item as HTMLElement).dataset.view as ViewId;
      currentView = view;
      const titles: Record<string, { title: string; sub: string }> = {
        'my-day':        { title: t('nav.myDay'),     sub: t('subtitle.myDay') },
        'planned':       { title: t('nav.planned'),   sub: t('subtitle.planned') },
        'important':     { title: t('nav.important'), sub: t('subtitle.important') },
        'tasks':         { title: t('nav.tasks'),     sub: t('subtitle.tasks') },
        'list:work':     { title: t('nav.work'),      sub: t('subtitle.work') },
        'list:personal': { title: t('nav.personal'),  sub: t('subtitle.personal') },
        'list:meeting':  { title: t('nav.meetings'),  sub: t('subtitle.meetings') },
      };
      const meta = titles[view];
      if (meta) {
        mustGet('#view-title').textContent = meta.title;
        mustGet('#view-subtitle').textContent = meta.sub;
      }
      render();
    });
  });
}

async function wireImportExport() {
  const importBtn = $<HTMLButtonElement>('#btn-import');
  const exportBtn = $<HTMLButtonElement>('#btn-export');
  if (!importBtn || !exportBtn) return;
  let dialogMod: typeof import('@tauri-apps/plugin-dialog') | null = null;
  let coreMod: typeof import('@tauri-apps/api/core') | null = null;
  try {
    dialogMod = await import('@tauri-apps/plugin-dialog');
    coreMod = await import('@tauri-apps/api/core');
  } catch { /* web dev */ }

  exportBtn.addEventListener('click', async () => {
    if (!dialogMod || !coreMod) return alert('Export requires the desktop app.');
    const path = await dialogMod.save({
      title: 'Export UniT tasks',
      defaultPath: `unit-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!path) return;
    const n = await coreMod.invoke<number>('export_tasks_json', { path });
    alert(`Exported ${n} task${n === 1 ? '' : 's'}.`);
  });

  importBtn.addEventListener('click', async () => {
    if (!dialogMod || !coreMod) return alert('Import requires the desktop app.');
    const picked = await dialogMod.open({
      title: 'Import UniT tasks',
      multiple: false,
      directory: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!picked || typeof picked !== 'string') return;
    const n = await coreMod.invoke<number>('import_tasks_json', { path: picked });
    tasks = await repo.listTasks();
    render();
    alert(`Imported ${n} task${n === 1 ? '' : 's'}.`);
  });
}

function wireEditableField(
  selector: string,
  field: 'userName' | 'userSub',
  settings: { userName: string; userSub: string },
  fallback: string,
): void {
  const el = $<HTMLElement>(selector);
  if (!el) return;
  el.textContent = settings[field] || fallback;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') {
      el.textContent = settings[field] || fallback;
      el.blur();
    }
  });
  el.addEventListener('blur', async () => {
    const next = (el.textContent || '').trim();
    if (next === settings[field]) return;
    settings[field] = next;
    el.textContent = next || fallback;
    await repo.saveSettings(settings as Parameters<typeof repo.saveSettings>[0]);
  });
}

const DEFAULT_BG_SRC = '/background.mp4';

interface BuiltInBg {
  id: string;              // stored in settings.activeBackground as "builtin:<id>"
  name: string;
  url: string;
}
const BUILT_IN_BG: BuiltInBg[] = [
  { id: 'default', name: 'Default', url: '/background.mp4' },
  { id: 'bg1', name: 'Scene 1', url: '/backgrounds/bg1.mp4' },
  { id: 'bg2', name: 'Scene 2', url: '/backgrounds/bg2.mp4' },
  { id: 'bg3', name: 'Scene 3', url: '/backgrounds/bg3.mp4' },
  { id: 'bg4', name: 'Streaming Scene', url: 'https://stream.mux.com/BuGGTsiXq1T00WUb8qfURrHkTCbhrkfFLSv4uAOZzdhw.m3u8' },
];

function resolveBgSource(stored: string | null): string {
  if (!stored) return DEFAULT_BG_SRC;
  if (stored.startsWith('builtin:')) {
    const id = stored.slice(8);
    return BUILT_IN_BG.find((b) => b.id === id)?.url ?? DEFAULT_BG_SRC;
  }
  // User-added absolute path → run through Tauri's asset protocol.
  const core = (globalThis as unknown as { __TAURI__?: { core: { convertFileSrc: (p: string) => string } } }).__TAURI__;
  try {
    if (core?.core?.convertFileSrc) return core.core.convertFileSrc(stored);
  } catch { /* fall through */ }
  return stored;
}

let hlsInstance: { destroy: () => void } | null = null;
async function applyBackgroundSrc(stored: string | null): Promise<void> {
  const vid = document.getElementById('app-bg') as HTMLVideoElement | null;
  if (!vid) return;
  const nextSrc = resolveBgSource(stored);
  if (vid.dataset.srcKey === nextSrc) return;
  vid.dataset.srcKey = nextSrc;

  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  vid.removeAttribute('src');
  vid.load();

  if (nextSrc.endsWith('.m3u8')) {
    // Safari / some WebViews play HLS natively.
    if (vid.canPlayType('application/vnd.apple.mpegurl')) {
      vid.src = nextSrc;
    } else {
      try {
        const Hls = (await import('hls.js')).default;
        if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(nextSrc);
          hls.attachMedia(vid);
          hlsInstance = hls;
        } else {
          vid.src = nextSrc; // last-ditch
        }
      } catch (e) {
        console.warn('HLS load failed:', e);
      }
    }
  } else {
    vid.src = nextSrc;
  }
  void vid.play().catch(() => { /* autoplay may be blocked before gesture */ });
}

function applyVideoBg(enabled: boolean) {
  document.documentElement.classList.toggle('no-bg', !enabled);
  const vid = document.getElementById('app-bg') as HTMLVideoElement | null;
  if (!vid) return;
  if (enabled) {
    void vid.play().catch(() => { /* autoplay may be blocked before user gesture */ });
  } else {
    vid.pause();
  }
}

function basename(p: string): string {
  const m = p.match(/[^\\/]+$/);
  return m ? m[0] : p;
}

// Treat null and "builtin:default" as the same stored value so old settings still match.
function normalizeKey(k: string | null | undefined): string | null {
  if (!k || k === 'builtin:default') return null;
  return k;
}

async function wireBackgroundsPicker() {
  const btn = $<HTMLButtonElement>('#btn-backgrounds');
  const pop = $<HTMLElement>('#bg-popover');
  const list = $<HTMLElement>('#bg-list');
  const add = $<HTMLButtonElement>('#bg-add-btn');
  if (!btn || !pop || !list || !add) return;

  const settings = await repo.getSettings();
  await applyBackgroundSrc(settings.activeBackground);

  // Row shape: `key` is what we store in settings.activeBackground
  // (null = the very first built-in "default", `builtin:<id>`, or an absolute file path).
  interface Row { key: string | null; label: string; removable: boolean; hint: string; }

  const renderList = () => {
    list.innerHTML = '';
    const rows: Row[] = [
      ...BUILT_IN_BG.map((b, i) => ({
        // First built-in is equivalent to "null" so old data keeps working.
        key: i === 0 ? null : `builtin:${b.id}`,
        label: b.name,
        removable: false,
        hint: b.url,
      })),
      ...settings.backgrounds.map((p) => ({
        key: p,
        label: basename(p),
        removable: true,
        hint: p,
      })),
    ];
    for (const row of rows) {
      const el = document.createElement('div');
      const active = normalizeKey(row.key) === normalizeKey(settings.activeBackground);
      el.className = 'bg-item' + (active ? ' active' : '');
      el.title = row.hint;
      el.innerHTML = `<span class="bg-item-name"></span>`
        + (row.removable ? `<span class="bg-item-remove" title="Remove">×</span>` : '');
      (el.querySelector('.bg-item-name') as HTMLElement).textContent = row.label;
      el.addEventListener('click', async (e) => {
        if ((e.target as HTMLElement).closest('.bg-item-remove')) return;
        settings.activeBackground = row.key;
        await repo.saveSettings(settings);
        await applyBackgroundSrc(row.key);
        renderList();
      });
      const rm = el.querySelector('.bg-item-remove');
      rm?.addEventListener('click', async (e) => {
        e.stopPropagation();
        settings.backgrounds = settings.backgrounds.filter((p) => p !== row.key);
        if (settings.activeBackground === row.key) {
          settings.activeBackground = null;
          await applyBackgroundSrc(null);
        }
        await repo.saveSettings(settings);
        renderList();
      });
      list.appendChild(el);
    }
  };
  renderList();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.classList.toggle('visible');
  });
  document.addEventListener('mousedown', (e) => {
    if (!pop.classList.contains('visible')) return;
    const target = e.target as HTMLElement;
    if (pop.contains(target) || target.closest('#btn-backgrounds')) return;
    pop.classList.remove('visible');
  });

  add.addEventListener('click', async () => {
    let dialogMod: typeof import('@tauri-apps/plugin-dialog') | null = null;
    try { dialogMod = await import('@tauri-apps/plugin-dialog'); } catch { return; }
    const picked = await dialogMod.open({
      title: 'Pick a background video',
      multiple: false,
      directory: false,
      filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv'] }],
    });
    if (!picked || typeof picked !== 'string') return;
    if (!settings.backgrounds.includes(picked)) {
      settings.backgrounds.push(picked);
    }
    settings.activeBackground = picked;
    await repo.saveSettings(settings);
    await applyBackgroundSrc(picked);
    renderList();
  });
}

async function wireVideoBgToggle() {
  const chk = $<HTMLInputElement>('#chk-video-bg');
  if (!chk) return;
  const settings = await repo.getSettings();
  chk.checked = settings.videoBg;
  applyVideoBg(settings.videoBg);
  chk.addEventListener('change', async () => {
    settings.videoBg = chk.checked;
    await repo.saveSettings(settings);
    applyVideoBg(chk.checked);
  });
}

async function wireAutostartToggle() {
  const chk = $<HTMLInputElement>('#chk-autostart');
  if (!chk) return;
  let coreMod: typeof import('@tauri-apps/api/core') | null = null;
  try { coreMod = await import('@tauri-apps/api/core'); } catch { /* web */ }
  if (!coreMod) { chk.disabled = true; return; }
  try {
    chk.checked = await coreMod.invoke<boolean>('get_autostart');
  } catch { chk.disabled = true; }
  chk.addEventListener('change', async () => {
    try {
      const v = await coreMod!.invoke<boolean>('set_autostart', { enabled: chk.checked });
      chk.checked = v;
    } catch (e) {
      console.error(e);
      alert('Could not toggle autostart.');
    }
  });
}

async function wireGcal() {
  const btn = $<HTMLButtonElement>('#btn-gcal');
  if (!btn) return;
  let coreMod: typeof import('@tauri-apps/api/core') | null = null;
  try { coreMod = await import('@tauri-apps/api/core'); } catch { /* web */ }
  if (!coreMod) { btn.disabled = true; return; }

  const settings = await repo.getSettings();
  const refreshLabel = async () => {
    const connected = await coreMod!.invoke<boolean>('gcal_status').catch(() => false);
    btn.textContent = connected ? t('bottom.disconnectGcal') : t('bottom.connectGcal');
    if (connected) (mustGet('#gcal-banner') as HTMLElement).style.display = 'flex';
    else (mustGet('#gcal-banner') as HTMLElement).style.display = 'none';
    settings.gcalConnected = connected;
    await repo.saveSettings(settings);
  };
  await refreshLabel();

  btn.addEventListener('click', async () => {
    const connected = await coreMod!.invoke<boolean>('gcal_status').catch(() => false);
    try {
      if (connected) {
        await coreMod!.invoke<void>('gcal_disconnect');
      } else {
        const clientId = prompt(
          'Paste your Google OAuth Client ID (Desktop app type).\n\nCreate one at console.cloud.google.com → APIs & Services → Credentials.',
          settings.gcalClientId ?? ''
        );
        if (!clientId) return;
        settings.gcalClientId = clientId;
        await repo.saveSettings(settings);
        btn.disabled = true;
        btn.textContent = 'Opening browser…';
        await coreMod!.invoke<boolean>('gcal_connect', { clientId });
      }
    } catch (e) {
      alert(`Google Calendar: ${e}`);
    } finally {
      btn.disabled = false;
      await refreshLabel();
    }
  });
}

async function bootstrap() {
  repo = await getRepo();
  await ensureNotificationPermission();

  try {
    const ev = await import('@tauri-apps/api/event');
    await ev.listen<number>('task-notified', async () => {
      tasks = await repo.listTasks();
      render();
      if (selectedId != null) renderDetail();
    });
    await ev.listen('quick-add', () => {
      const inp = $<HTMLInputElement>('#add-input');
      if (inp) { inp.focus(); inp.select(); }
    });
  } catch { /* browser dev */ }

  await wireImportExport();
  await wireAutostartToggle();
  await wireVideoBgToggle();
  await wireBackgroundsPicker();
  await wireGcal();
  await wireThemeAndLocale();

  const settings = await repo.getSettings();
  if (settings.gcalConnected) (mustGet('#gcal-banner') as HTMLElement).style.display = 'flex';
  wireEditableField('#user-name', 'userName', settings, 'You');
  wireEditableField('#user-sub', 'userSub', settings, '');

  tasks = await repo.listTasks();

  // Seed once if empty so first-run has a showcase.
  if (tasks.length === 0) {
    const seed: Task[] = [
      emptyTask({ title: 'Welcome to UniT — click to open details', due: todayISO(), time: '09:00', list: 'tasks', myDay: true, note: 'Your data is saved automatically.' }),
      emptyTask({ title: 'Try natural language: "Call dentist tomorrow 3pm #meeting"', due: todayISO(), time: '10:00', list: 'personal', myDay: true }),
      emptyTask({ title: 'Weekly review #work', due: tomorrowISO(), time: '16:00', list: 'work', tag: 'work', recur: 'weekly' }),
    ];
    for (const t of seed) tasks.push(await repo.upsertTask(t));
  }

  await wireEvents();
  wireDatePicker();
  render();
  renderDetail();
}

bootstrap().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="padding:24px;color:#b54708;">Startup error: ${escapeHtml(String(e))}</pre>`;
});
