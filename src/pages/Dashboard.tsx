import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GroupedBars, Lines } from '../components/Charts';
import { personName, useNames } from '../components/TablePanel';
import { Empty, Figures, fmtDate, fmtDateTime, Meter, Modal, StatusDot, Tabs, today } from '../components/ui';
import { can, COUNT_RULES, countTables, fmtPct, label, matchCount, ROLE_LABEL, STATUS, WORK_LABEL, type Counts, type Discipline, type Role, type TableState, type WorkStatus } from '../lib/model';
import { behindSchedule, completionRate, dailyCompletions, droneDiscrepancies, forecast, planVsActual, qualityBySubcon, turnaroundDays, useDashData, workFrontReady, type DashData, type Row, mondayOf } from '../lib/stats';
import { errText, getState, refreshTables, rpc, setState, supabase, toast, useStore } from '../lib/store';
import Reports from './Reports';

export function useShowOnMap() {
  const nav = useNavigate();
  return (ids: Iterable<string>, lab: string, discipline?: Discipline) => { setState({ focus: { ids: new Set(ids), label: lab, discipline }, selected: null }); nav('/keyplan'); };
}

export default function Dashboard() {
  const role = useStore((s) => s.profile?.role) as Role;
  const name = useStore((s) => s.profile?.full_name);
  const subId = useStore((s) => s.profile?.subcontractor_id);
  const subcons = useStore((s) => s.subcons);
  const projectName = useStore((s) => s.projectName);
  const [tab, setTab] = useState<'overview' | 'reports'>('overview');
  const data = useDashData(60);
  useNames();
  const mySub = subcons.find((s) => s.id === subId);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{role === 'subcontractor' ? `${mySub?.code ?? 'Your company'} — your work` : ROLE_TITLE[role]}</h1>
          <p>{projectName} · signed in as {name} ({ROLE_LABEL[role]}). Figures come from saved, verified records; submitted reports count only after verification.</p>
        </div>
        <Tabs value={tab} onChange={setTab} items={[{ key: 'overview', label: 'Dashboard' }, { key: 'reports', label: 'Reports' }]} />
      </div>
      {tab === 'reports' ? <Reports /> : <RoleDashboard role={role} data={data} />}
    </div>
  );
}
const ROLE_TITLE: Record<Role, string> = {
  admin: 'Project overview', ceo: 'Executive dashboard', project_manager: 'Project status', construction_manager: 'Site execution',
  pic_engineer: 'Work coordination', qaqc_engineer: 'Quality dashboard', site_engineer: 'Field progress', project_planner: 'Planning dashboard', subcontractor: 'Your work',
};

function RoleDashboard({ role, data }: { role: Role; data: DashData }) {
  const subId = useStore((s) => s.profile?.subcontractor_id) ?? null;
  switch (role) {
    case 'ceo': return <div className="stack loose"><Headline /><div className="grid cols-2"><PlanActual data={data} d="MMS" /><PlanActual data={data} d="PV" /></div><Attention data={data} focus="management" /><BlockTable /><SubconComparison /><div className="grid cols-2"><QualitySummary data={data} /><Milestones data={data} /></div><ForecastPanel data={data} /></div>;
    case 'project_manager': case 'admin': return <div className="stack loose"><Headline /><Attention data={data} focus="management" /><div className="grid cols-2"><DailyChart data={data} /><QualitySummary data={data} /></div><div className="grid cols-2"><PlanActual data={data} d="MMS" /><PlanActual data={data} d="PV" /></div><SubconComparison /><BlockTable /><div className="grid cols-2"><Milestones data={data} /><ForecastPanel data={data} /></div>{role === 'admin' && <ImportSummary />}</div>;
    case 'construction_manager': return <div className="stack loose"><Headline /><VerificationQueue data={data} /><div className="grid cols-2"><DailyChart data={data} /><Attention data={data} focus="site" /></div><SubconComparison productivity data={data} /><BlockTable /><Constraints data={data} /></div>;
    case 'pic_engineer': return <div className="stack loose"><VerificationQueue data={data} /><Headline /><div className="grid cols-2"><Targets data={data} /><Attention data={data} focus="site" /></div><BlockTable /><Constraints data={data} /></div>;
    case 'qaqc_engineer': return <div className="stack loose"><QaFigures data={data} /><div className="grid cols-2"><QualityTrends data={data} /><Attention data={data} focus="quality" /></div><QaQueues data={data} /></div>;
    case 'site_engineer': return <div className="stack loose"><Headline /><VerificationQueue data={data} /><div className="grid cols-2"><DailyChart data={data} days={7} /><Attention data={data} focus="field" /></div><BlockTable /><div className="grid cols-2"><Targets data={data} /><Constraints data={data} /></div></div>;
    case 'project_planner': return <div className="stack loose"><Headline /><div className="grid cols-2"><PlanActual data={data} d="MMS" /><PlanActual data={data} d="PV" /></div><div className="grid cols-2"><Targets data={data} editable /><Milestones data={data} editable /></div><Attention data={data} focus="planning" /><BlockTable /><ForecastPanel data={data} /></div>;
    case 'subcontractor': return <div className="stack loose"><Headline subcon={subId} /><div className="grid cols-2"><Targets data={data} subcon={subId} /><DailyChart data={data} subcon={subId} /></div><div className="grid cols-2"><SubconQueues data={data} /><Constraints data={data} /></div></div>;
  }
}

// ---------------- panels
function Panel({ title, children, action, sub }: { title: string; children: React.ReactNode; action?: React.ReactNode; sub?: string }) {
  return <section className="sheet"><header><div><h3>{title}</h3>{sub && <div className="xs faint">{sub}</div>}</div>{action}</header><div className="body">{children}</div></section>;
}

function Headline({ subcon }: { subcon?: string | null }) {
  const tables = useStore((s) => s.tables); const show = useShowOnMap();
  const scope = subcon === undefined ? undefined : subcon;
  const m = countTables(tables, 'MMS', scope); const p = countTables(tables, 'PV', scope);
  const mods = tables.filter((t) => t.pv_work && (scope === undefined || t.pv_subcon === scope)).reduce((a, t) => [a[0] + (t.pv_modules || 0), a[1] + t.modules_required], [0, 0]);
  const go = (d: Discipline, k: keyof Counts, lab: string) => show(tables.filter((t) => (scope === undefined || (d === 'MMS' ? t.mms_subcon : t.pv_subcon) === scope) && matchCount(t, d, k)).map((t) => t.id), lab, d);
  return (
    <div className="stack tight">
      <Figures items={[
        { key: 'mi', value: fmtPct(m.installed, m.total), label: 'Mounting structure installed', sub: `${m.installed.toLocaleString()} of ${m.total.toLocaleString()} tables`, onClick: () => go('MMS', 'installed', 'MMS installed'), title: COUNT_RULES.installed },
        { key: 'ma', value: fmtPct(m.approved, m.total), label: 'Mounting structure approved', sub: `${m.approved.toLocaleString()} tables · ${m.forInspection} for inspection`, onClick: () => go('MMS', 'approved', 'MMS approved'), title: COUNT_RULES.approved },
        { key: 'pi', value: fmtPct(p.installed, p.total), label: 'PV tables installed', sub: `${p.installed.toLocaleString()} of ${p.total.toLocaleString()} · ${mods[0].toLocaleString()} of ${mods[1].toLocaleString()} modules`, onClick: () => go('PV', 'installed', 'PV installed'), title: COUNT_RULES.installed },
        { key: 'pa', value: fmtPct(p.approved, p.total), label: 'PV tables approved', sub: `${p.approved.toLocaleString()} tables · ${p.forInspection} for inspection`, onClick: () => go('PV', 'approved', 'PV approved'), title: COUNT_RULES.approved },
        { key: 'rc', value: (m.rectification + p.rectification).toLocaleString(), label: 'For rectification', sub: `MMS ${m.rectification} · PV ${p.rectification}`, onClick: () => show(tables.filter((t) => (scope === undefined || t.mms_subcon === scope || t.pv_subcon === scope) && (t.mms_qa === 'for_rectification' || t.pv_qa === 'for_rectification')).map((t) => t.id), 'For rectification'), title: COUNT_RULES.rectification },
        { key: 'oh', value: (m.onHold + p.onHold).toLocaleString(), label: 'On hold', sub: `MMS ${m.onHold} · PV ${p.onHold}`, onClick: () => show(tables.filter((t) => t.mms_work === 'on_hold' || t.pv_work === 'on_hold').map((t) => t.id), 'On hold'), title: COUNT_RULES.onHold },
      ]} />
      <p className="xs faint">Installed and approved are separate counts: a table can be installed and still waiting for inspection. Counts overlap and are never added together.</p>
    </div>
  );
}

function BlockTable() {
  const tables = useStore((s) => s.tables); const blocks = useStore((s) => s.blocks); const show = useShowOnMap();
  const rows = blocks.map((b) => { const ts = tables.filter((t) => t.block_code === b.code); return { b, ts, m: countTables(ts, 'MMS'), p: countTables(ts, 'PV'), late: behindSchedule(ts, 'MMS').length + behindSchedule(ts, 'PV').length }; });
  return (
    <Panel title="Progress by block and discipline" sub="Solid bar: approved · lighter bar: installed">
      <div className="tablewrap"><table className="data">
        <thead><tr><th>Block</th><th className="n">Tables</th><th style={{ width: '22%' }}>Mounting structure</th><th className="n">Installed</th><th className="n">Approved</th><th style={{ width: '22%' }}>PV modules</th><th className="n">Installed</th><th className="n">Approved</th><th className="n">Remaining PV</th><th className="n">Behind target</th></tr></thead>
        <tbody>{rows.map(({ b, ts, m, p, late }) => (
          <tr key={b.code} className="clickable" onClick={() => show(ts.map((t) => t.id), `Block ${b.code}`)}>
            <td><b>{b.code}</b></td><td className="n">{ts.length.toLocaleString()}</td>
            <td><Meter a={m.approved} b={m.installed} total={m.total} color="var(--series-mms)" /></td><td className="n">{fmtPct(m.installed, m.total)}</td><td className="n">{fmtPct(m.approved, m.total)}</td>
            <td><Meter a={p.approved} b={p.installed} total={p.total} color="var(--series-pv)" /></td><td className="n">{fmtPct(p.installed, p.total)}</td><td className="n">{fmtPct(p.approved, p.total)}</td>
            <td className="n">{p.remaining.toLocaleString()}</td><td className="n">{late || '—'}</td>
          </tr>))}</tbody>
      </table></div>
    </Panel>
  );
}

export function SubconComparison({ productivity, data }: { productivity?: boolean; data?: DashData }) {
  const tables = useStore((s) => s.tables); const subcons = useStore((s) => s.subcons); const nav = useNavigate();
  const [d, setD] = useState<Discipline>('MMS');
  return (
    <Panel title="Subcontractor comparison" sub="Assigned, completed and approved come from the system; progress is completed ÷ assigned"
      action={<div className="seg">{(['MMS', 'PV'] as Discipline[]).map((x) => <button key={x} className={d === x ? 'on' : ''} onClick={() => setD(x)}>{x === 'MMS' ? 'Mounting structure' : 'PV modules'}</button>)}</div>}>
      <div className="tablewrap"><table className="data">
        <thead><tr><th>Subcontractor</th><th className="n">Assigned</th><th className="n">Completed</th><th className="n">Approved</th><th className="n">For inspection</th><th className="n">For rectification</th><th className="n">On hold</th><th style={{ width: '18%' }}>Progress</th><th className="n">%</th>{productivity && <th className="n">Completed last 7 days</th>}</tr></thead>
        <tbody>{subcons.map((s) => { const c = countTables(tables, d, s.id); const last7 = productivity && data ? dailyCompletionsFor(data, d, s.id) : 0; return (
          <tr key={s.id} className="clickable" onClick={() => nav(`/subcontractors/${s.code}`)}>
            <td><span className="row" style={{ gap: 6 }}><span className="swatch" style={{ background: s.color }} /><b>{s.code}</b></span></td>
            <td className="n">{c.total.toLocaleString()}</td><td className="n">{c.installed.toLocaleString()}</td><td className="n">{c.approved.toLocaleString()}</td><td className="n">{c.forInspection}</td><td className="n">{c.rectification}</td><td className="n">{c.onHold}</td>
            <td><Meter a={c.approved} b={c.installed} total={c.total} color={d === 'MMS' ? 'var(--series-mms)' : 'var(--series-pv)'} /></td><td className="n">{fmtPct(c.installed, c.total)}</td>
            {productivity && <td className="n">{last7}</td>}
          </tr>); })}</tbody>
      </table></div>
    </Panel>
  );
}
function dailyCompletionsFor(data: DashData, d: Discipline, sub: string) { const r = dailyCompletions(data.events, 7, sub); return (d === 'MMS' ? r.mms : r.pv).reduce((a, b) => a + b, 0); }

function DailyChart({ data, days = 14, subcon }: { data: DashData; days?: number; subcon?: string | null }) {
  const r = useMemo(() => dailyCompletions(data.events, days, subcon === null ? undefined : subcon), [data, days, subcon]);
  const total = r.mms.reduce((a, b) => a + b, 0) + r.pv.reduce((a, b) => a + b, 0);
  return (
    <Panel title={days <= 7 ? 'Accomplishments this week' : `Daily accomplishments, last ${days} days`} sub="Tables completed per day from verified progress">
      {!data.loaded ? <div className="small muted">Loading…</div> : total === 0 ? <Empty title="No verified completions in this period">Completions appear here as Site Engineers record or verify progress. The CAD baseline counts as already complete.</Empty> :
        <GroupedBars ariaLabel="Tables completed per day" categories={r.cats} series={[{ key: 'mms', label: 'Mounting structure', color: 'var(--series-mms)', values: r.mms }, { key: 'pv', label: 'PV modules', color: 'var(--series-pv)', values: r.pv }]} />}
      {total > 0 && <p className="xs faint" style={{ marginTop: 6 }}>{r.modules.reduce((a, b) => a + b, 0).toLocaleString()} PV modules installed in the period.</p>}
    </Panel>
  );
}

function PlanActual({ data, d, subcon }: { data: DashData; d: Discipline; subcon?: string | null }) {
  const tables = useStore((s) => s.tables);
  const r = useMemo(() => planVsActual(tables, data.events, data.targets, d, subcon), [tables, data, d, subcon]);
  const title = `${d === 'MMS' ? 'Mounting structure' : 'PV modules'}: planned vs actual`;
  return (
    <Panel title={title} sub="Cumulative tables complete; plan from weekly targets">
      {!r ? <Empty title="No baseline schedule yet">The Project Planner adds weekly targets on the Planning dashboard; the plan line appears once targets exist.</Empty>
        : <Lines ariaLabel={title} categories={r.cats} series={[{ key: 'a', label: 'Actual', color: d === 'MMS' ? 'var(--series-mms)' : 'var(--series-pv)', values: r.actual }, { key: 'p', label: 'Planned', color: 'var(--ink-3)', values: r.planned, dashed: true }]} />}
    </Panel>
  );
}

function ForecastPanel({ data }: { data: DashData }) {
  const tables = useStore((s) => s.tables);
  const rows = (['MMS', 'PV'] as Discipline[]).map((d) => { const c = countTables(tables, d); const rate = completionRate(data.events, d, 14); return { d, c, rate, f: forecast(c.remaining, rate) }; });
  return (
    <Panel title="Completion forecast" sub="Estimate at the last 14 days’ verified rate; not a schedule commitment">
      <div className="tablewrap"><table className="data"><thead><tr><th>Discipline</th><th className="n">Remaining tables</th><th className="n">Rate (tables/day)</th><th>Estimated completion</th></tr></thead>
        <tbody>{rows.map(({ d, c, rate, f }) => <tr key={d}><td>{d === 'MMS' ? 'Mounting structure' : 'PV modules'}</td><td className="n">{c.remaining.toLocaleString()}</td><td className="n">{rate.toFixed(1)}</td><td>{f.text}</td></tr>)}</tbody></table></div>
    </Panel>
  );
}

function Attention({ data, focus }: { data: DashData; focus: 'management' | 'site' | 'quality' | 'field' | 'planning' }) {
  const tables = useStore((s) => s.tables); const show = useShowOnMap(); const nav = useNavigate();
  const items: { n: number; text: string; go: () => void; tone?: 'error' | '' }[] = [];
  const add = (ids: TableState[] | string[], text: string, tone: 'error' | '' = '', d?: Discipline) => { const arr = (ids as any[]).map((x) => (typeof x === 'string' ? x : x.id)); if (arr.length) items.push({ n: arr.length, text, tone, go: () => show(arr, text, d) }); };
  const lateM = behindSchedule(tables, 'MMS'), lateP = behindSchedule(tables, 'PV');
  const stoppages = data.constraints.filter((c) => c.status === 'open' && c.is_stoppage);
  if (focus !== 'quality') { add(lateM, 'Mounting structure behind target date', 'error', 'MMS'); add(lateP, 'PV modules behind target date', 'error', 'PV'); }
  add(tables.filter((t) => t.mms_work === 'on_hold' || t.pv_work === 'on_hold'), 'Tables on hold (constraints)');
  if (stoppages.length) items.push({ n: stoppages.length, text: 'Open work stoppages', tone: 'error', go: () => nav('/keyplan') });
  add(tables.filter((t) => t.mms_qa === 'for_approval' || t.pv_qa === 'for_approval'), 'Passed inspection, approval outstanding');
  add(tables.filter((t) => t.mms_qa === 'for_rectification' || t.pv_qa === 'for_rectification'), 'Open rectification', 'error');
  if (focus !== 'planning') add(tables.filter((t) => t.mms_qa === 'ready_for_inspection' || t.pv_qa === 'ready_for_inspection'), 'Ready for inspection, not yet scheduled');
  if (focus === 'site' || focus === 'field') { add(workFrontReady(tables), 'PV work front ready (structure complete, PV not started)', '', 'PV'); add(tables.filter((t) => t.pending_reports > 0), 'Subcontractor reports waiting for verification'); }
  if (focus !== 'quality') add(tables.filter((t) => t.has_exception), 'PV recorded before structure approval (dependency exceptions)', '', 'PV');
  if (focus === 'field' || focus === 'site' || focus === 'management') add(droneDiscrepancies(tables), 'Drone shows modules, record says PV not complete — check on site', '', 'PV');
  return (
    <Panel title={focus === 'quality' ? 'Quality items needing action' : 'Needs attention'} sub="Select a line to see the tables on the keyplan">
      {!items.length ? <Empty title="Nothing outstanding">No delays, holds or open approvals right now.</Empty> :
        <div className="stack tight">{items.map((i) => <button key={i.text} className={`flag ${i.tone}`} style={{ cursor: 'pointer', textAlign: 'left' }} onClick={i.go}><b className="num" style={{ minWidth: 44 }}>{i.n.toLocaleString()}</b><span className="grow">{i.text}</span></button>)}</div>}
    </Panel>
  );
}

function VerificationQueue({ data }: { data: DashData }) {
  const byId = useStore((s) => s.byId); const role = useStore((s) => s.profile?.role) ?? null; const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const rows = data.reports;
  const review = async (r: Row, ok: boolean) => {
    setBusy(r.id);
    try { await rpc('review_accomplishment', { p_id: r.id, p_verify: ok, p_note: ok ? null : 'Not as reported on site' }); toast(ok ? 'Verified: official progress updated' : 'Report rejected'); await refreshTables([r.table_id]); }
    catch (e) { toast(errText(e), 'error'); }
    setBusy(null);
  };
  return (
    <Panel title="Accomplishments waiting for verification" sub="Subcontractor reports count toward official progress only after verification">
      {!rows.length ? <Empty title="No reports waiting">New subcontractor submissions will appear here.</Empty> :
        <div className="tablewrap" style={{ maxHeight: 360 }}><table className="data">
          <thead><tr><th>Table</th><th>Discipline</th><th>Reported</th><th>By</th><th>When</th><th /></tr></thead>
          <tbody>{rows.map((r) => { const t = byId.get(r.table_id); return (
            <tr key={r.id}><td><button className="linkbtn mono" onClick={() => nav(`/keyplan?table=${t?.table_code || t?.sys_key}`)}>{t ? label(t) : '—'}</button></td><td>{r.discipline}</td>
              <td>{WORK_LABEL[r.work_status as WorkStatus]}{r.installed_modules != null ? ` · ${r.installed_modules}/${t?.modules_required ?? 28}` : ''}{r.note ? <div className="xs faint">“{r.note}”</div> : null}</td>
              <td>{personName(r.submitted_by)}</td><td>{fmtDateTime(r.submitted_at)}</td>
              <td className="n">{can(role, 'report.verify') && <span className="row" style={{ justifyContent: 'end' }}><button className="btn sm primary" disabled={busy === r.id} onClick={() => review(r, true)}>Verify</button><button className="btn sm" disabled={busy === r.id} onClick={() => review(r, false)}>Reject</button></span>}</td></tr>); })}</tbody>
        </table></div>}
    </Panel>
  );
}

function QaFigures({ data }: { data: DashData }) {
  const tables = useStore((s) => s.tables); const show = useShowOnMap();
  const since30 = Date.now() - 30 * 86400000;
  const req30 = data.requests.filter((r) => new Date(r.requested_at).getTime() > since30);
  const insp30 = data.inspections.filter((i) => i.stage !== 'contractor' && new Date(i.inspected_at).getTime() > since30);
  const awaitingInsp = tables.filter((t) => ['ready_for_inspection', 'for_inspection'].includes(t.mms_qa || '') || ['ready_for_inspection', 'for_inspection'].includes(t.pv_qa || ''));
  const awaitingAppr = tables.filter((t) => t.mms_qa === 'for_approval' || t.pv_qa === 'for_approval');
  const openPunch = data.punch.filter((p) => p.status !== 'closed');
  const backlog = data.requests.filter((r) => r.is_reinspection && (r.status === 'open' || r.status === 'scheduled'));
  const ta = turnaroundDays(data.requests, data.inspections);
  return (
    <Figures items={[
      { key: 'rr', value: req30.length.toLocaleString(), label: 'Inspection requests received', sub: 'last 30 days' },
      { key: 'ic', value: insp30.length.toLocaleString(), label: 'Inspections completed', sub: `last 30 days · ${insp30.filter((i) => i.result === 'failed').length} failed` },
      { key: 'ai', value: awaitingInsp.length.toLocaleString(), label: 'Awaiting inspection', sub: 'tables (MMS or PV)', onClick: () => show(awaitingInsp.map((t) => t.id), 'Awaiting inspection') },
      { key: 'aa', value: awaitingAppr.length.toLocaleString(), label: 'Awaiting approval', onClick: () => show(awaitingAppr.map((t) => t.id), 'Awaiting approval') },
      { key: 'op', value: openPunch.length.toLocaleString(), label: 'Open punch-list items', sub: `${openPunch.filter((p) => p.status === 'resubmitted').length} resubmitted`, onClick: () => show(new Set(openPunch.map((p) => p.table_id)), 'Open punch-list items') },
      { key: 'rb', value: backlog.length.toLocaleString(), label: 'Reinspection backlog', onClick: () => show(backlog.map((r) => r.table_id), 'Reinspection backlog') },
      { key: 'ta', value: ta === null ? '—' : `${ta.toFixed(1)} d`, label: 'Average inspection turnaround', sub: 'request to result' },
    ]} />
  );
}

function QualityTrends({ data }: { data: DashData }) {
  const subcons = useStore((s) => s.subcons);
  const q = qualityBySubcon(data.inspections, subcons.map((s) => s.id));
  return (
    <Panel title="Quality by subcontractor and activity" sub="QA/QC and client inspections, last 60 days">
      <div className="tablewrap"><table className="data"><thead><tr><th>Subcontractor</th><th className="n">MMS passed</th><th className="n">MMS failed</th><th className="n">PV passed</th><th className="n">PV failed</th><th className="n">First-time pass rate</th></tr></thead>
        <tbody>{subcons.map((s) => { const r = q.get(s.id)!; const tot = r.passed + r.failed; return (
          <tr key={s.id}><td><span className="row" style={{ gap: 6 }}><span className="swatch" style={{ background: s.color }} />{s.code}</span></td><td className="n">{r.MMS[0]}</td><td className="n">{r.MMS[1]}</td><td className="n">{r.PV[0]}</td><td className="n">{r.PV[1]}</td><td className="n">{tot ? fmtPct(r.passed, tot) : '—'}</td></tr>); })}</tbody></table></div>
    </Panel>
  );
}
function QualitySummary({ data }: { data: DashData }) {
  const subcons = useStore((s) => s.subcons);
  const open = data.punch.filter((p) => p.status !== 'closed');
  const failed = data.inspections.filter((i) => i.result === 'failed' && i.stage !== 'contractor');
  return (
    <Panel title="Quality issues" sub="Failed inspections (60 days) and open punch-list items by subcontractor">
      {!open.length && !failed.length ? <Empty title="No open quality issues" /> :
        <div className="tablewrap"><table className="data"><thead><tr><th>Subcontractor</th><th className="n">Failed inspections</th><th className="n">Open punch items</th></tr></thead>
          <tbody>{subcons.map((s) => <tr key={s.id}><td>{s.code}</td><td className="n">{failed.filter((f) => subFor(f) === s.id).length}</td><td className="n">{open.filter((p) => p.subcontractor_id === s.id).length}</td></tr>)}</tbody></table></div>}
    </Panel>
  );
}
function subFor(i: Row) { const st = getState().byId.get(i.table_id); return st ? (i.discipline === 'MMS' ? st.mms_subcon : st.pv_subcon) : null; }

function QaQueues({ data }: { data: DashData }) {
  const nav = useNavigate();
  return (
    <Panel title="Inspection work" action={<button className="btn sm" onClick={() => nav('/qaqc')}>Open QA/QC</button>}>
      <p className="small muted">{data.requests.filter((r) => r.status === 'open').length} requests waiting to be scheduled · {data.requests.filter((r) => r.status === 'scheduled').length} scheduled · {data.punch.filter((p) => p.status === 'resubmitted').length} rectifications resubmitted for reinspection.</p>
    </Panel>
  );
}

function SubconQueues({ data }: { data: DashData }) {
  const byId = useStore((s) => s.byId); const nav = useNavigate();
  const open = data.punch.filter((p) => p.status === 'open');
  const pendingInsp = data.requests.filter((r) => r.status === 'open' || r.status === 'scheduled');
  return (
    <Panel title="Inspections and rectifications" sub="Results and comments recorded by QA/QC">
      <div className="stack">
        <div><h4>Pending inspections ({pendingInsp.length})</h4>{pendingInsp.slice(0, 8).map((r) => { const t = byId.get(r.table_id); return <div key={r.id} className="small"><button className="linkbtn mono" onClick={() => nav(`/keyplan?table=${t?.table_code || t?.sys_key}`)}>{t ? label(t) : ''}</button> {r.discipline} · {r.status === 'scheduled' ? `scheduled ${fmtDate(r.scheduled_for)}` : 'waiting for QA/QC'}</div>; })}</div>
        <div><h4>Outstanding rectifications ({open.length})</h4>{open.slice(0, 10).map((p) => { const t = byId.get(p.table_id); return <div key={p.id} className="small"><button className="linkbtn mono" onClick={() => nav(`/keyplan?table=${t?.table_code || t?.sys_key}`)}>{t ? label(t) : ''}</button> {p.discipline} · {p.description}</div>; })}
          {!open.length && <span className="small faint">None open.</span>}</div>
        <div><h4>Your reports waiting for verification ({data.reports.length})</h4></div>
      </div>
    </Panel>
  );
}

function Constraints({ data }: { data: DashData }) {
  const byId = useStore((s) => s.byId); const nav = useNavigate();
  const open = data.constraints.filter((c) => c.status === 'open').sort((a, b) => Number(b.is_stoppage) - Number(a.is_stoppage));
  return (
    <Panel title="Open constraints and work-area restrictions" sub="Recorded on site; stoppages first">
      {!open.length ? <Empty title="No open constraints" /> : <div className="stack tight">{open.slice(0, 12).map((c) => { const t = c.table_id ? byId.get(c.table_id) : null; return (
        <div key={c.id} className={`flag ${c.is_stoppage ? 'error' : ''}`}><div className="small grow"><b>{c.category.replace('_', ' ')}</b>{t ? <> · <button className="linkbtn mono" onClick={() => nav(`/keyplan?table=${t.table_code || t.sys_key}`)}>{label(t)}</button></> : c.block_code ? ` · Block ${c.block_code}` : ''} — {c.description}
          <div className="xs faint">{personName(c.raised_by)} · {fmtDateTime(c.raised_at)}</div></div></div>); })}</div>}
    </Panel>
  );
}

function Milestones({ data, editable }: { data: DashData; editable?: boolean }) {
  const role = useStore((s) => s.profile?.role) ?? null;
  const [open, setOpen] = useState<Row | null>(null);
  const canEdit = editable !== false && can(role, 'plan.milestones');
  return (
    <Panel title="Milestones" action={canEdit ? <button className="btn sm" onClick={() => setOpen({})}>Add milestone</button> : undefined}>
      {!data.milestones.length ? <Empty title="No milestones yet">{canEdit ? 'Add the project’s key dates to track them against forecasts.' : 'The Project Planner adds milestones.'}</Empty> :
        <div className="tablewrap"><table className="data"><thead><tr><th>Milestone</th><th>Planned</th><th>Forecast</th><th>Actual</th><th /></tr></thead>
          <tbody>{data.milestones.map((m) => { const late = !m.actual_date && m.planned_date && (m.forecast_date || today()) > m.planned_date; return (
            <tr key={m.id}><td><b>{m.name}</b>{m.discipline ? <span className="xs faint"> · {m.discipline}</span> : null}</td><td>{fmtDate(m.planned_date)}</td><td style={late ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>{fmtDate(m.forecast_date)}</td><td>{fmtDate(m.actual_date)}</td>
              <td className="n">{canEdit && <button className="btn sm quiet" onClick={() => setOpen(m)}>Edit</button>}</td></tr>); })}</tbody></table></div>}
      {open && <MilestoneModal m={open} onClose={() => setOpen(null)} />}
    </Panel>
  );
}
function MilestoneModal({ m, onClose }: { m: Row; onClose: () => void }) {
  const [v, setV] = useState({ name: m.name || '', discipline: m.discipline || '', planned_date: m.planned_date || '', forecast_date: m.forecast_date || '', actual_date: m.actual_date || '', notes: m.notes || '' });
  const save = async () => {
    const row = { ...v, discipline: v.discipline || null, planned_date: v.planned_date || null, forecast_date: v.forecast_date || null, actual_date: v.actual_date || null, updated_at: new Date().toISOString() };
    const r = m.id ? await supabase.from('milestones').update(row).eq('id', m.id) : await supabase.from('milestones').insert(row);
    if (r.error) return toast(errText(r.error), 'error');
    toast('Milestone saved'); setState((s) => ({ dataVersion: s.dataVersion + 1 })); onClose();
  };
  return (
    <Modal title={m.id ? 'Edit milestone' : 'Add milestone'} onClose={onClose} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!v.name.trim()} onClick={save}>Save milestone</button></>}>
      <div className="stack">
        <label className="field"><span>Name</span><input type="text" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Block M02 PV mechanical completion" /></label>
        <label className="field"><span>Discipline</span><select value={v.discipline} onChange={(e) => setV({ ...v, discipline: e.target.value })}><option value="">Whole project</option><option value="MMS">Mounting structure</option><option value="PV">PV modules</option></select></label>
        <div className="grid cols-3"><label className="field"><span>Planned</span><input type="date" value={v.planned_date} onChange={(e) => setV({ ...v, planned_date: e.target.value })} /></label>
          <label className="field"><span>Forecast</span><input type="date" value={v.forecast_date} onChange={(e) => setV({ ...v, forecast_date: e.target.value })} /></label>
          <label className="field"><span>Actual</span><input type="date" value={v.actual_date} onChange={(e) => setV({ ...v, actual_date: e.target.value })} /></label></div>
        <label className="field"><span>Notes</span><input type="text" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></label>
      </div>
    </Modal>
  );
}

function Targets({ data, editable, subcon }: { data: DashData; editable?: boolean; subcon?: string | null }) {
  const role = useStore((s) => s.profile?.role) ?? null; const subcons = useStore((s) => s.subcons); const tables = useStore((s) => s.tables);
  const [open, setOpen] = useState(false);
  const canEdit = editable !== false && can(role, 'plan.targets');
  const weekKey = mondayOf(new Date()).toISOString().slice(0, 10); const dayKey = today();
  const rows = data.targets.filter((t) => (t.period === 'week' && t.period_start === weekKey) || (t.period === 'day' && t.period_start === dayKey)).filter((t) => subcon === undefined || subcon === null || t.subcontractor_id === subcon);
  const actualFor = (t: Row) => {
    const from = t.period_start; const to = t.period === 'week' ? new Date(new Date(from).getTime() + 7 * 86400000).toISOString().slice(0, 10) : from;
    return data.events.filter((e) => (e.event === 'progress' || e.event === 'verified') && e.discipline === t.discipline && e.to_work === 'completed' && e.from_work !== 'completed'
      && String(e.at).slice(0, 10) >= from && (t.period === 'day' ? String(e.at).slice(0, 10) === from : String(e.at).slice(0, 10) < to)
      && (!t.subcontractor_id || subFor(e) === t.subcontractor_id)).length;
  };
  void tables;
  return (
    <Panel title="Targets this week and today" sub="Tables to complete; actual counts verified completions" action={canEdit ? <button className="btn sm" onClick={() => setOpen(true)}>Set target</button> : undefined}>
      {!rows.length ? <Empty title="No targets for this period">{canEdit ? 'Set daily or weekly targets per subcontractor and discipline.' : 'Targets are set by the Project Planner or Project-in-Charge Engineer.'}</Empty> :
        <div className="tablewrap"><table className="data"><thead><tr><th>Period</th><th>Discipline</th><th>Subcontractor</th><th className="n">Target</th><th className="n">Actual</th><th style={{ width: '25%' }}>Achievement</th></tr></thead>
          <tbody>{rows.map((t) => { const a = actualFor(t); const s = subcons.find((x) => x.id === t.subcontractor_id); return (
            <tr key={t.id}><td>{t.period === 'week' ? `Week of ${fmtDate(t.period_start)}` : fmtDate(t.period_start)}</td><td>{t.discipline}</td><td>{s?.code ?? 'All'}</td><td className="n">{t.quantity}</td><td className="n">{a}</td>
              <td><Meter a={Math.min(a, t.quantity)} total={t.quantity} color={t.discipline === 'MMS' ? 'var(--series-mms)' : 'var(--series-pv)'} /></td></tr>); })}</tbody></table></div>}
      {open && <TargetModal onClose={() => setOpen(false)} />}
    </Panel>
  );
}
function TargetModal({ onClose }: { onClose: () => void }) {
  const subcons = useStore((s) => s.subcons);
  const [v, setV] = useState({ discipline: 'MMS', subcontractor_id: '', period: 'week', period_start: mondayOf(new Date()).toISOString().slice(0, 10), quantity: 20 });
  const save = async () => {
    const start = v.period === 'week' ? mondayOf(new Date(v.period_start)).toISOString().slice(0, 10) : v.period_start;
    const r = await supabase.from('targets').upsert({ ...v, period_start: start, subcontractor_id: v.subcontractor_id || null, block_code: null }, { onConflict: 'discipline,subcontractor_id,block_code,period,period_start' });
    if (r.error) return toast(errText(r.error), 'error');
    toast('Target saved'); setState((s) => ({ dataVersion: s.dataVersion + 1 })); onClose();
  };
  return (
    <Modal title="Set a target" onClose={onClose} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save target</button></>}>
      <div className="grid cols-2">
        <label className="field"><span>Discipline</span><select value={v.discipline} onChange={(e) => setV({ ...v, discipline: e.target.value })}><option value="MMS">Mounting structure</option><option value="PV">PV modules</option></select></label>
        <label className="field"><span>Subcontractor</span><select value={v.subcontractor_id} onChange={(e) => setV({ ...v, subcontractor_id: e.target.value })}><option value="">All subcontractors</option>{subcons.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select></label>
        <label className="field"><span>Period</span><select value={v.period} onChange={(e) => setV({ ...v, period: e.target.value })}><option value="week">Week (starting Monday)</option><option value="day">Day</option></select></label>
        <label className="field"><span>{v.period === 'week' ? 'Week containing' : 'Date'}</span><input type="date" value={v.period_start} onChange={(e) => setV({ ...v, period_start: e.target.value })} /></label>
        <label className="field"><span>Tables to complete</span><input type="number" min={0} value={v.quantity} onChange={(e) => setV({ ...v, quantity: +e.target.value })} /></label>
      </div>
    </Modal>
  );
}

function ImportSummary() {
  const nav = useNavigate();
  return <Panel title="Drawing import" action={<button className="btn sm" onClick={() => nav('/admin?tab=drawings')}>Open import report</button>}><p className="small muted">The baseline came from six AutoCAD drawings. Table ID issues and data conflicts found during import are listed for review in Administration → Drawings.</p></Panel>;
}
