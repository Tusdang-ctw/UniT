export type ListId = 'tasks' | 'work' | 'personal' | 'meeting';
export type Tag = 'meeting' | 'work' | 'personal' | 'today' | null;
export type RecurRule = 'none' | 'daily' | 'weekly' | 'weekdays';
export type ViewId = 'my-day' | 'planned' | 'important' | 'tasks' | `list:${ListId}`;
export type Mode = 'list' | 'calendar';

export interface Task {
  id: number;
  title: string;
  due: string | null;        // ISO yyyy-mm-dd
  time: string | null;       // HH:mm 24h
  list: ListId;
  starred: boolean;
  done: boolean;
  myDay: boolean;
  note: string;
  tag: Tag;
  created: number;           // ms since epoch
  gcalSynced: boolean;
  duration: number;          // minutes
  recur: RecurRule;
  remindMinutesBefore: number | null;
  lastNotifiedAt: number | null;
  gcalEventId: string | null;
}

export interface Settings {
  userName: string;
  userSub: string;
  gcalConnected: boolean;
  gcalClientId: string | null;
  locale: string;           // 'en' | 'vi'
  theme: 'light' | 'dark' | 'system';
  videoBg: boolean;
  backgrounds: string[];            // absolute paths the user has saved
  activeBackground: string | null;  // null = use bundled default
}

export const DEFAULT_SETTINGS: Settings = {
  userName: 'You',
  userSub: '',
  gcalConnected: false,
  gcalClientId: null,
  locale: 'en',
  theme: 'dark',
  videoBg: true,
  backgrounds: [],
  activeBackground: null,
};

export function emptyTask(partial: Partial<Task> = {}): Task {
  return {
    id: 0,
    title: '',
    due: null,
    time: null,
    list: 'tasks',
    starred: false,
    done: false,
    myDay: false,
    note: '',
    tag: null,
    created: Date.now(),
    gcalSynced: false,
    duration: 30,
    recur: 'none',
    remindMinutesBefore: null,
    lastNotifiedAt: null,
    gcalEventId: null,
    ...partial,
  };
}
