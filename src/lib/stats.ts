import { useEffect, useState } from 'react';
import { fetchAll, getState, supabase, useStore } from './store';
import type { Discipline, TableState } from './model';

export type Row = Record<string, any>;
export interface DashData {
  events: Row[]; requests: Row[]; inspections: Row[]; punch: Row[]; reports: Row[]; constraints: Row[]; targets: Row[]; milestones: Row[]; loaded: boolean;
}
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
export const mondayOf = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const w = (x.getUTCDay() + 6) % 7; return addDays(x, -w); };

export function useDashData(days = 60): DashData {
  const version = useStore((s) => s.dataVersion);
  const [d, setD] = useState<DashData>({ events: [], requests: [], inspections: [], punch: [], reports: [], constraints: [], targets: [], milestones: [], loaded: false });
  useEffect(() => {
    let alive = true;
    const since = addDays(new Date(), -days).toISOString();
    Promise.all([
      fetchAll<Row>('status_events', 'id, table_id, discipline, event, from_work, to_work, from_qa, to_qa, installed_modules, modules_delta, actor, actor_role, at', (q) => q.gte('at', since).neq('event', 'baseline').order('id')),
      fetchAll<Row>('inspection_requests', '*', (q) => q.order('requested_at')),
      fetchAll<Row>('inspections', '*', (q) => q.gte('inspected_at', since).order('inspected_at')),
      fetchAll<Row>('punch_items', '*', (q) => q.order('raised_at')),
      fetchAll<Row>('accomplishments', '*', (q) => q.eq('status', 'submitted').order('submitted_at')),
      fetchAll<Row>('site_constraints', '*', (q) => q.order('raised_at', { ascending: false })),
      fetchAll<Row>('targets', '*', (q) => q.order('period_start')),
      fetchAll<Row>('milestones', '*', (q) => q.order('planned_date')),
    ]).then(([events, requests, inspections, punch, reports, constraints, targets, milestones]) => {
      if (alive) setD({ events, requests, inspections, punch, reports, constraints, targets, milestones, loaded: true });
    }).catch(() => alive && setD((x) => ({ ...x, loaded: true })));
    return () => { alive = false; };
  }, [version, days]);
  return d;
}

const subOf = (t: TableState | undefined, d: Discipline) => (t ? (d === 'MMS' ? t.mms_subcon : t.pv_subcon) : null);

/** Tables newly completed per day (verified progress only; subcontractor submissions are excluded until verified). */
export function dailyCompletions(events: Row[], days: number, subcon?: string | null) {
  const byId = getState().byId;
  const cats: string[] = []; const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) { const dt = addDays(new Date(), -i); keys.push(dayKey(dt)); cats.push(dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })); }
  const idx = new Map(keys.map((k, i) => [k, i]));
  const mms = new Array(days).fill(0), pv = new Array(days).fill(0), modules = new Array(days).fill(0);
  for (const e of events) {
    if (e.event !== 'progress' && e.event !== 'verified') continue;
    const i = idx.get(String(e.at).slice(0, 10)); if (i === undefined) continue;
    if (subcon !== undefined && subOf(byId.get(e.table_id), e.discipline) !== subcon) continue;
    if (e.to_work === 'completed' && e.from_work !== 'completed') (e.discipline === 'MMS' ? mms : pv)[i]++;
    if (e.discipline === 'PV' && e.modules_delta > 0) modules[i] += e.modules_delta;
  }
  return { cats, keys, mms, pv, modules };
}

export function completionRate(events: Row[], d: Discipline, days = 14, subcon?: string | null) {
  const { mms, pv } = dailyCompletions(events, days, subcon);
  const arr = d === 'MMS' ? mms : pv; return arr.reduce((a, b) => a + b, 0) / days;
}
export function forecast(remaining: number, rate: number) {
  if (remaining <= 0) return { date: null as Date | null, text: 'Complete' };
  if (rate <= 0) return { date: null, text: 'Not enough verified progress in the last 14 days to estimate' };
  const date = addDays(new Date(), Math.ceil(remaining / rate));
  return { date, text: `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} at ${rate.toFixed(1)} tables/day` };
}

/** Weekly planned (targets) vs actual cumulative completions for one discipline. */
export function planVsActual(tables: TableState[], events: Row[], targets: Row[], d: Discipline, subcon?: string | null) {
  const ts = targets.filter((t) => t.discipline === d && t.period === 'week' && (subcon === undefined || t.subcontractor_id === subcon || (subcon === null && !t.subcontractor_id)));
  if (!ts.length) return null;
  const weeks = [...new Set(ts.map((t) => t.period_start as string))].sort();
  const now = mondayOf(new Date());
  const last = new Date(Math.max(new Date(weeks[weeks.length - 1]).getTime(), now.getTime()));
  const cats: string[] = []; const keys: string[] = [];
  for (let w = mondayOf(new Date(weeks[0])); w <= last; w = addDays(w, 7)) { keys.push(dayKey(w)); cats.push(w.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })); }
  const byId = getState().byId;
  const inScope = (t: TableState) => subcon === undefined || subOf(t, d) === subcon;
  const doneNow = tables.filter((t) => inScope(t) && (d === 'MMS' ? t.mms_work : t.pv_work) === 'completed').length;
  // completions after the first plotted week, by week
  const perWeek = new Array(keys.length).fill(0);
  for (const e of events) {
    if ((e.event !== 'progress' && e.event !== 'verified') || e.discipline !== d || e.to_work !== 'completed' || e.from_work === 'completed') continue;
    const t = byId.get(e.table_id); if (!t || !inScope(t)) continue;
    const k = dayKey(mondayOf(new Date(e.at))); const i = keys.indexOf(k); if (i >= 0) perWeek[i]++;
  }
  const doneBefore = doneNow - perWeek.reduce((a, b) => a + b, 0);
  const actual: number[] = []; let acc = doneBefore;
  keys.forEach((k, i) => { acc += perWeek[i]; actual.push(new Date(k) <= now ? acc : NaN); });
  const planned: number[] = []; let pacc = doneBefore;
  keys.forEach((k) => { pacc += ts.filter((t) => t.period_start === k).reduce((a, t) => a + t.quantity, 0); planned.push(pacc); });
  const thisWeek = keys.indexOf(dayKey(now));
  return { cats, actual, planned, thisWeekTarget: thisWeek >= 0 ? ts.filter((t) => t.period_start === keys[thisWeek]).reduce((a, t) => a + t.quantity, 0) : 0, thisWeekActual: thisWeek >= 0 ? perWeek[thisWeek] : 0 };
}

export function turnaroundDays(requests: Row[], inspections: Row[]) {
  const byReq = new Map<string, Row>();
  for (const i of inspections) if (i.request_id && !byReq.has(i.request_id)) byReq.set(i.request_id, i);
  const durations: number[] = [];
  for (const r of requests) { const i = byReq.get(r.id); if (i) durations.push((new Date(i.inspected_at).getTime() - new Date(r.requested_at).getTime()) / 86400000); }
  return durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
}

export function qualityBySubcon(inspections: Row[], subconIds: string[]) {
  const byId = getState().byId;
  const out = new Map<string, { passed: number; failed: number; MMS: [number, number]; PV: [number, number] }>();
  for (const s of subconIds) out.set(s, { passed: 0, failed: 0, MMS: [0, 0], PV: [0, 0] });
  for (const i of inspections) {
    if (i.stage === 'contractor') continue;
    const sid = subOf(byId.get(i.table_id), i.discipline); if (!sid || !out.has(sid)) continue;
    const o = out.get(sid)!; const k = i.result === 'passed' ? 0 : 1;
    if (k === 0) o.passed++; else o.failed++;
    (o as any)[i.discipline][k]++;
  }
  return out;
}

export const behindSchedule = (tables: TableState[], d: Discipline) => {
  const today = new Date().toISOString().slice(0, 10);
  return tables.filter((t) => { const f = d === 'MMS' ? t.mms_target_finish : t.pv_target_finish; const w = d === 'MMS' ? t.mms_work : t.pv_work; return f && f < today && w && w !== 'completed'; });
};
export const workFrontReady = (tables: TableState[]) => tables.filter((t) => t.mms_work === 'completed' && t.pv_work === 'not_started');
export const droneDiscrepancies = (tables: TableState[]) => tables.filter((t) => (t.drone_cover ?? 0) > 0.6 && t.pv_work && t.pv_work !== 'completed');
export { supabase };
