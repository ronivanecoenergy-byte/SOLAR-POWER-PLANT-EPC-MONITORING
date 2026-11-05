import { useSyncExternalStore } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Block, DroneLayer, Profile, ProjectSettings, Subcon, TableState } from './model';

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// A password-reset link returns here with its tokens (or an error) after the '#'. Supabase reads
// the tokens itself; an error (expired or already used link) is shown on the sign-in page.
const linkParams = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
const linkError = !linkParams.get('access_token') && linkParams.get('error_description');
if (linkError) history.replaceState(null, '', location.pathname + location.search);

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'solar-keyplan-auth' },
});

export interface Toast { id: number; kind: 'ok' | 'error' | 'info'; text: string }
export interface Focus { ids: Set<string>; label: string; discipline?: 'MMS' | 'PV' }
export interface State {
  session: Session | null; authChecked: boolean;
  /** signed in from a password-reset link: ask for a new password first */
  recovery: boolean;
  /** message for the sign-in page, e.g. an expired reset link */
  authNotice: string | null;
  profile: Profile | null; loading: boolean; error: string | null;
  projectName: string; settings: ProjectSettings | null;
  subcons: Subcon[]; blocks: Block[]; drone: DroneLayer | null;
  tables: TableState[]; byId: Map<string, TableState>; loadedAt: number | null;
  toasts: Toast[]; focus: Focus | null; selected: string | null; theme: 'system' | 'light' | 'dark';
  dataVersion: number;
}

const readTheme = (): State['theme'] => { try { return (localStorage.getItem('theme') as State['theme']) || 'system'; } catch { return 'system'; } };
let state: State = {
  session: null, authChecked: false, recovery: false,
  authNotice: linkError ? `${linkError.replace(/\+/g, ' ')}. Request a new link below.` : null,
  profile: null, loading: false, error: null, projectName: 'Expansion PV Farm', settings: null,
  subcons: [], blocks: [], drone: null, tables: [], byId: new Map(), loadedAt: null, toasts: [], focus: null, selected: null,
  theme: readTheme(), dataVersion: 0,
};
const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'ok') {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 9000 : 4500);
}

export function applyTheme(theme: State['theme']) {
  try { localStorage.setItem('theme', theme); } catch { /* storage may be blocked */ }
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  setState({ theme });
}

/** Friendly message from a Supabase/PostgREST error. */
export function errText(e: unknown): string {
  const m = (e as { message?: string })?.message || String(e);
  if (/Failed to fetch|NetworkError|fetch failed/i.test(m)) return 'No connection to the server. Check your signal and try again.';
  if (/JWT expired/i.test(m)) return 'Your session expired. Sign in again.';
  return m.replace(/^.*?ERROR:\s*/, '');
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(errText(error));
  return data as T;
}

/** Page through PostgREST's 1,000-row response limit. */
export async function fetchAll<T>(table: string, columns: string, build?: (q: any) => any, pageSize = 1000, orderKey = 'id'): Promise<T[]> {
  // a unique sort key keeps LIMIT/OFFSET pages from overlapping
  const ordered = (q: any) => q.order(orderKey, { ascending: true });
  const first = ordered(build ? build(supabase.from(table).select(columns, { count: 'exact' })) : supabase.from(table).select(columns, { count: 'exact' }));
  const { data, error, count } = await first.range(0, pageSize - 1);
  if (error) throw new Error(errText(error));
  const out = [...(data as T[])];
  const total = count ?? out.length;
  const pages = [];
  for (let from = pageSize; from < total; from += pageSize) {
    const q = ordered(build ? build(supabase.from(table).select(columns)) : supabase.from(table).select(columns));
    pages.push(q.range(from, from + pageSize - 1));
  }
  for (const r of await Promise.all(pages)) {
    if (r.error) throw new Error(errText(r.error));
    out.push(...(r.data as T[]));
  }
  return out;
}

function indexTables(rows: TableState[]) {
  rows.sort((a, b) => (a.table_code || a.sys_key).localeCompare(b.table_code || b.sys_key, undefined, { numeric: true }));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function loadProfile(): Promise<Profile | null> {
  const uid = state.session?.user.id;
  if (!uid) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (error) throw new Error(errText(error));
  return data as Profile | null;
}

export async function loadAll() {
  setState({ loading: true, error: null });
  try {
    const profile = await loadProfile();
    if (!profile?.role || !profile.active) { setState({ profile, loading: false }); return; }
    const [proj, subs, blocks, drone, tables] = await Promise.all([
      supabase.from('project').select('name, settings').eq('id', 1).maybeSingle(),
      supabase.from('subcontractors').select('*').order('code'),
      supabase.from('blocks').select('*').order('sort'),
      supabase.from('drone_layers').select('*').eq('is_active', true).order('capture_date', { ascending: false }).limit(1),
      fetchAll<TableState>('v_table_state', '*'),
    ]);
    for (const r of [proj, subs, blocks, drone]) if (r.error) throw new Error(errText(r.error));
    setState((s) => ({
      profile, loading: false, projectName: proj.data?.name || s.projectName, settings: (proj.data?.settings as ProjectSettings) || null,
      subcons: (subs.data as Subcon[]) || [], blocks: (blocks.data as Block[]) || [], drone: ((drone.data as DroneLayer[]) || [])[0] || null,
      tables, byId: indexTables(tables), loadedAt: Date.now(), dataVersion: s.dataVersion + 1,
    }));
  } catch (e) {
    setState({ loading: false, error: errText(e) });
  }
}

/** Re-read some tables (after an action) or all of them. */
export async function refreshTables(ids?: string[]) {
  try {
    let rows: TableState[];
    if (ids && ids.length && ids.length <= 300) {
      const { data, error } = await supabase.from('v_table_state').select('*').in('id', ids);
      if (error) throw error;
      rows = data as TableState[];
      const map = new Map(state.byId);
      for (const r of rows) map.set(r.id, r);
      const tables = state.tables.map((t) => map.get(t.id) || t);
      setState((s) => ({ tables, byId: map, loadedAt: Date.now(), dataVersion: s.dataVersion + 1 }));
    } else {
      rows = await fetchAll<TableState>('v_table_state', '*');
      setState((s) => ({ tables: rows, byId: indexTables(rows), loadedAt: Date.now(), dataVersion: s.dataVersion + 1 }));
    }
  } catch (e) {
    toast(errText(e), 'error');
  }
}

export const subconById = (id: string | null | undefined) => (id ? state.subcons.find((s) => s.id === id) || null : null);
export function findTables(query: string, limit = 12): TableState[] {
  const q = query.trim().toUpperCase().replace(/\s+/g, '');
  if (!q) return [];
  const out: TableState[] = [];
  for (const t of state.tables) {
    const code = (t.table_code || '').toUpperCase();
    if (code === q || t.sys_key === q) out.unshift(t);
    else if (code.includes(q) || t.sys_key.includes(q)) out.push(t);
    if (out.length > limit * 4) break;
  }
  return out.slice(0, limit);
}

let accessToken: string | null = null;
supabase.auth.onAuthStateChange((ev, session) => {
  accessToken = session?.access_token || null;
  if (ev === 'PASSWORD_RECOVERY') setState({ recovery: true });
  const prev = state.session?.user.id;
  setState({ session, authChecked: true });
  if (session && session.user.id !== prev) loadAll();
  if (!session) setState({ profile: null, tables: [], byId: new Map(), selected: null, focus: null, recovery: false });
});
export const getAccessToken = () => accessToken;
