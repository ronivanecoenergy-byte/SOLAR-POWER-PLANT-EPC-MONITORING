import { useCallback, useEffect, useState } from 'react';
import {
  can, currentStatus, fullMask, ID_FLAG_TEXT, label, QA_LABEL, STATUS, WORK_LABEL,
  type Discipline, type QaStatus, type TableState, type WorkStatus,
} from '../lib/model';
import { errText, refreshTables, rpc, subconById, supabase, toast, useStore } from '../lib/store';
import { ModuleGrid } from './ModuleGrid';
import { fmtDate, fmtDateTime, Icon, Modal, StatusDot, StatusPill, SubconChip, Tabs, today } from './ui';

type Row = Record<string, any>;
interface Detail { inspections: Row[]; punch: Row[]; approvals: Row[]; events: Row[]; reports: Row[]; files: Row[]; constraints: Row[]; requests: Row[]; exceptions: Row[] }
const EMPTY: Detail = { inspections: [], punch: [], approvals: [], events: [], reports: [], files: [], constraints: [], requests: [], exceptions: [] };

let names: Map<string, { name: string; role: string | null }> | null = null;
async function loadNames() {
  if (names) return names;
  const { data } = await supabase.from('profiles').select('id, full_name, email, role');
  names = new Map((data || []).map((p: Row) => [p.id, { name: p.full_name || p.email, role: p.role }]));
  return names;
}
export const personName = (id: string | null | undefined) => (id && names?.get(id)?.name) || 'Project team';

function useDetail(id: string | null) {
  const [d, setD] = useState<Detail>(EMPTY);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const q = (t: string, cols = '*', order = 'id') => supabase.from(t).select(cols).eq('table_id', id).order(order, { ascending: false });
    const [ins, pun, apr, ev, rep, fil, con, req, exc] = await Promise.all([
      q('inspections', '*', 'inspected_at'), q('punch_items', '*', 'raised_at'), q('approvals', '*', 'approved_at'), q('status_events', '*', 'at'),
      q('accomplishments', '*', 'submitted_at'), q('attachments', '*', 'uploaded_at'), q('site_constraints', '*', 'raised_at'),
      q('inspection_requests', '*', 'requested_at'), q('dependency_exceptions', '*', 'approved_at'), loadNames(),
    ]);
    setD({ inspections: ins.data || [], punch: pun.data || [], approvals: apr.data || [], events: ev.data || [], reports: rep.data || [],
      files: fil.data || [], constraints: con.data || [], requests: req.data || [], exceptions: exc.data || [] });
    setLoading(false);
  }, [id]);
  useEffect(() => { setD(EMPTY); load(); }, [load]);
  return { d, loading, reload: load };
}

async function act(fn: () => Promise<unknown>, ok: string, tableId: string, reload: () => void) {
  try { await fn(); toast(ok); await refreshTables([tableId]); reload(); return true; }
  catch (e) { toast(errText(e), 'error'); return false; }
}

export function TablePanel({ id, onClose, onZoom, onExpand }: { id: string; onClose: () => void; onZoom: () => void; onExpand?: () => void }) {
  const t = useStore((s) => s.byId.get(id));
  const role = useStore((s) => s.profile?.role) ?? null;
  const drone = useStore((s) => s.drone);
  const [tab, setTab] = useState<'overview' | 'MMS' | 'PV' | 'qa' | 'history' | 'files'>('overview');
  const { d, reload } = useDetail(id);
  useEffect(() => { setTab('overview'); }, [id]);
  if (!t) return null;
  const isSub = role === 'subcontractor';
  return (
    <div>
      <button className="grabber" aria-label="Expand details" onClick={onExpand} />
      <div className="td-head">
        <div className="row between" style={{ alignItems: 'start' }}>
          <div className="grow">
            <div className="td-block">Block {t.block_code ?? '—'}</div>
            <div className="td-id">{label(t)}</div>
          </div>
          <div className="row" style={{ gap: 4 }}>
            <button className="iconbtn" title="Zoom to table" aria-label="Zoom to table" onClick={onZoom}>{Icon.fit}</button>
            <button className="iconbtn" title="Close" aria-label="Close details" onClick={onClose}>{Icon.close}</button>
          </div>
        </div>
        <div className="td-meta">
          <span>System ID <b className="mono">{t.sys_key}</b></span>
          {t.id_row && <span>Row <b className="mono">{t.id_row}</b> · Column <b className="mono">{t.id_col}</b></span>}
          <span>Drawing location <b className="mono">{((t.x0 + t.x1) / 2).toFixed(1)}, {((t.y0 + t.y1) / 2).toFixed(1)} m</b></span>
        </div>
        {t.id_flags.filter((f) => ID_FLAG_TEXT[f]).map((f) => <div key={f} className={`flag ${f === 'DUPLICATE_ID' || f === 'NO_ID' ? 'error' : ''}`} style={{ marginTop: 8 }}>{ID_FLAG_TEXT[f]}. See Administration → Drawings for the import report.</div>)}
      </div>
      <Tabs value={tab} onChange={setTab} items={[
        { key: 'overview', label: 'Overview' }, { key: 'MMS', label: 'Mounting structure' }, { key: 'PV', label: 'PV modules' },
        { key: 'qa', label: 'QA/QC' }, { key: 'history', label: 'History' }, { key: 'files', label: `Files${d.files.length ? ` (${d.files.length})` : ''}` },
      ]} />
      <div className="td-body">
        {tab === 'overview' && <Overview t={t} d={d} isSub={isSub} drone={drone?.capture_date} onTab={setTab} reload={reload} />}
        {(tab === 'MMS' || tab === 'PV') && <DisciplinePanel key={tab} t={t} disc={tab} d={d} reload={reload} />}
        {tab === 'qa' && <QaHistory t={t} d={d} reload={reload} />}
        {tab === 'history' && <History d={d} />}
        {tab === 'files' && <Files t={t} d={d} reload={reload} />}
      </div>
    </div>
  );
}

function Overview({ t, d, isSub, drone, onTab, reload }: { t: TableState; d: Detail; isSub: boolean; drone?: string; onTab: (x: any) => void; reload: () => void }) {
  const role = useStore((s) => s.profile?.role) ?? null;
  const mmsS = currentStatus(t.mms_work, t.mms_qa); const pvS = currentStatus(t.pv_work, t.pv_qa);
  const mmsSub = subconById(t.mms_subcon); const pvSub = subconById(t.pv_subcon);
  const qaWorst = (t.mms_qa === 'for_rectification' || t.pv_qa === 'for_rectification') ? 'For Rectification' : t.pv_qa && t.pv_qa !== 'none' ? QA_LABEL[t.pv_qa] : t.mms_qa ? QA_LABEL[t.mms_qa] : '—';
  const openPunch = d.punch.filter((p) => p.status !== 'closed');
  const pending = d.reports.filter((r) => r.status === 'submitted');
  const openReq = d.requests.filter((r) => r.status === 'open' || r.status === 'scheduled');
  const openCons = d.constraints.filter((c) => c.status === 'open');
  const outstanding: string[] = [];
  if (openPunch.length) outstanding.push(`${openPunch.length} open rectification item${openPunch.length > 1 ? 's' : ''}`);
  if (t.mms_qa === 'for_approval' || t.pv_qa === 'for_approval') outstanding.push('Inspection passed, approval not yet recorded');
  if (openReq.length) outstanding.push(`${openReq.length} inspection request${openReq.length > 1 ? 's' : ''} waiting`);
  if (pending.length) outstanding.push(`${pending.length} accomplishment report${pending.length > 1 ? 's' : ''} waiting for verification`);
  if ((t.mms_work === 'completed' || t.pv_work === 'completed') && !d.files.length) outstanding.push('No photographs or documents attached yet');
  if (t.has_exception) outstanding.push('PV work recorded under a dependency exception (structure not approved)');
  if (openCons.length) outstanding.push(`${openCons.length} open site constraint${openCons.length > 1 ? 's' : ''}`);
  outstanding.push('Electrical connection and commissioning records: source drawings not provided yet');
  const [constraintOpen, setConstraintOpen] = useState(false);
  return (
    <>
      <dl className="kv">
        <div><dt>Mounting structure</dt><dd><StatusPill status={mmsS} /></dd></div>
        <div><dt>PV modules</dt><dd className="mono">{t.pv_work ? `${t.pv_modules ?? 0} / ${t.modules_required}` : '—'}</dd></div>
        <div><dt>QA/QC status</dt><dd>{qaWorst}</dd></div>
        <div><dt>Subcontractor</dt><dd>{mmsSub?.id === pvSub?.id ? <SubconChip subcon={mmsSub} /> : <span className="stack tight"><span className="xs faint">MMS</span><SubconChip subcon={mmsSub} /><span className="xs faint">PV</span><SubconChip subcon={pvSub} /></span>}</dd></div>
        <div><dt>Target completion</dt><dd className="small">MMS {fmtDate(t.mms_target_finish)}<br />PV {fmtDate(t.pv_target_finish)}</dd></div>
        <div><dt>Actual completion</dt><dd className="small">MMS {fmtDate(t.mms_actual_finish)}<br />PV {fmtDate(t.pv_actual_finish)}</dd></div>
        <div><dt>Progress</dt><dd className="small">MMS {t.mms_work ? `${t.mms_pct ?? 0}%` : '—'} · PV {t.pv_work ? `${Math.round(((t.pv_modules ?? 0) * 100) / t.modules_required)}%` : '—'}</dd></div>
        <div><dt>Approval records</dt><dd className="small">{d.approvals.length ? d.approvals.slice(0, 2).map((a) => <div key={a.id}>{a.discipline} · {a.stage === 'qaqc' ? 'QA/QC' : a.stage === 'client' ? 'Client' : 'Final'}{a.source === 'CAD baseline' ? ` (${a.reference})` : ` ${fmtDate(a.approved_at)}`}</div>) : 'None recorded'}</dd></div>
      </dl>
      {t.drone_cover !== null && drone && <div className={`flag ${t.drone_cover > 0.6 ? 'info' : ''}`}>
        Drone {fmtDate(drone)}: {t.drone_cover > 0.6 ? 'PV modules visible on this table' : t.drone_cover > 0.3 ? 'some modules visible' : 'no modules visible'} ({Math.round(t.drone_cover * 100)}% module cover, automatic estimate).
        {t.drone_cover > 0.6 && t.pv_work && t.pv_work !== 'completed' ? ' The record says PV is not complete; please check on site.' : ''}
      </div>}
      <section>
        <h4 style={{ marginBottom: 8 }}>Work history</h4>
        <ol className="stack tight small" style={{ margin: 0, paddingLeft: 20 }}>
          <li><b>Pile installation</b> — pile layout not provided yet, so piles can’t be tracked per table. Record pile refusal as a constraint.</li>
          <li><b>Mounting structure</b> — <button className="linkbtn" onClick={() => onTab('MMS')}>{mmsS ? STATUS[mmsS].label : 'not assigned to you'}</button>{t.mms_qa === 'approved' ? (t.mms_approved_at ? `, approved ${fmtDate(t.mms_approved_at)}` : ', approved per the MMS APPROVED 2.0 drawing') : ''}.</li>
          <li><b>PV modules</b> — <button className="linkbtn" onClick={() => onTab('PV')}>{t.pv_work ? `${t.pv_modules ?? 0}/${t.modules_required} installed, ${pvS ? STATUS[pvS].label : ''}` : 'not assigned to you'}</button>; {d.files.length} file{d.files.length === 1 ? '' : 's'} attached.</li>
          <li><b>DC connections</b> — string IDs, cable status, testing and inverter association need the electrical drawings.</li>
        </ol>
      </section>
      <section>
        <h4 style={{ marginBottom: 8 }}>Outstanding items</h4>
        <ul className="stack tight small" style={{ margin: 0, paddingLeft: 20 }}>{outstanding.map((o) => <li key={o}>{o}</li>)}</ul>
      </section>
      <section className="stack tight">
        <div className="row between"><h4>Site constraints</h4>{can(role, 'constraint.raise') && <button className="btn sm" onClick={() => setConstraintOpen(true)}>Record constraint</button>}</div>
        {d.constraints.length === 0 ? <span className="small faint">None recorded.</span> : d.constraints.map((c) => <ConstraintRow key={c.id} c={c} tableId={t.id} reload={reload} />)}
      </section>
      {constraintOpen && <ConstraintModal tableId={t.id} onClose={() => setConstraintOpen(false)} reload={reload} />}
      {isSub && <p className="xs faint">You see records for tables assigned to your company. Other tables show as outlines only.</p>}
    </>
  );
}

function ConstraintRow({ c, tableId, reload }: { c: Row; tableId: string; reload: () => void }) {
  const role = useStore((s) => s.profile?.role) ?? null;
  const uid = useStore((s) => s.session?.user.id);
  const resolve = async () => {
    await act(async () => {
      const { error } = await supabase.from('site_constraints').update({ status: 'resolved', resolved_by: uid, resolved_at: new Date().toISOString(), resolution: 'Resolved on site' }).eq('id', c.id);
      if (error) throw error;
    }, 'Constraint resolved', tableId, reload);
  };
  return (
    <div className={`flag ${c.status === 'open' ? (c.is_stoppage ? 'error' : '') : 'ok'}`}>
      <div className="grow small"><b>{c.category.replace('_', ' ')}</b>{c.is_stoppage ? ' · work stopped' : ''} — {c.description}
        <div className="xs faint">{personName(c.raised_by)}, {fmtDateTime(c.raised_at)}{c.status === 'resolved' ? ` · resolved ${fmtDate(c.resolved_at)}` : ''}</div></div>
      {c.status === 'open' && can(role, 'constraint.resolve') && <button className="btn sm" onClick={resolve}>Resolve</button>}
    </div>
  );
}

const CATEGORIES = ['material', 'access', 'pile_refusal', 'weather', 'design', 'equipment', 'manpower', 'other'];
function ConstraintModal({ tableId, onClose, reload }: { tableId: string; onClose: () => void; reload: () => void }) {
  const uid = useStore((s) => s.session?.user.id);
  const [cat, setCat] = useState('material'); const [desc, setDesc] = useState(''); const [stop, setStop] = useState(false); const [disc, setDisc] = useState<'' | Discipline>('');
  const save = async () => {
    const ok = await act(async () => {
      const { error } = await supabase.from('site_constraints').insert({ table_id: tableId, category: cat, description: desc.trim(), is_stoppage: stop, discipline: disc || null, raised_by: uid });
      if (error) throw error;
    }, 'Constraint recorded', tableId, reload);
    if (ok) onClose();
  };
  return (
    <Modal title="Record a site constraint" onClose={onClose} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!desc.trim()} onClick={save}>Record constraint</button></>}>
      <div className="stack">
        <div className="row wrap" role="group" aria-label="Category">{CATEGORIES.map((c) => <button key={c} type="button" className={`btn sm ${cat === c ? 'primary' : ''}`} onClick={() => setCat(c)}>{c.replace('_', ' ')}</button>)}</div>
        <label className="field"><span>What is holding the work?</span><textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Pile refusal at two piles, waiting for redesign" /></label>
        <div className="row wrap">
          <label className="field" style={{ width: 160 }}><span>Discipline</span><select value={disc} onChange={(e) => setDisc(e.target.value as any)}><option value="">Both</option><option value="MMS">Mounting structure</option><option value="PV">PV modules</option></select></label>
          <label className="check" style={{ marginTop: 18 }}><input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} />Work is stopped</label>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- MMS / PV discipline panel with role-aware actions
function DisciplinePanel({ t, disc, d, reload }: { t: TableState; disc: Discipline; d: Detail; reload: () => void }) {
  const profile = useStore((s) => s.profile);
  const subcons = useStore((s) => s.subcons);
  const role = profile?.role ?? null;
  const work = (disc === 'MMS' ? t.mms_work : t.pv_work) as WorkStatus | null;
  const qa = ((disc === 'MMS' ? t.mms_qa : t.pv_qa) || 'none') as QaStatus;
  const subId = disc === 'MMS' ? t.mms_subcon : t.pv_subcon;
  const st = currentStatus(work, qa);
  const isSub = role === 'subcontractor';
  const mine = isSub ? subId === profile?.subcontractor_id : true;
  const canUpdate = can(role, 'progress.update') && (role !== 'site_engineer' || !profile?.assigned_blocks?.length || profile.assigned_blocks.includes(t.block_code || ''));
  const canSubmit = can(role, 'progress.submit') && mine && !!work;
  const pending = d.reports.filter((r) => r.discipline === disc && r.status === 'submitted');
  const punch = d.punch.filter((p) => p.discipline === disc);
  const openPunch = punch.filter((p) => p.status === 'open');
  const requests = d.requests.filter((r) => r.discipline === disc && (r.status === 'open' || r.status === 'scheduled'));
  const mmsDone = t.mms_work === 'completed';
  const blockedByDependency = disc === 'PV' && !mmsDone && !t.has_exception;
  const [modal, setModal] = useState<null | 'inspect' | 'approve' | 'reopen' | 'punch' | 'dates' | 'assign' | 'exception' | 'request'>(null);

  if (!work) return <div className="empty"><h3>Not assigned to your company</h3><p>This table’s {disc === 'MMS' ? 'mounting structure' : 'PV module'} work belongs to another subcontractor.</p></div>;

  return (
    <>
      <div className="disc">
        <header>
          <h4><StatusDot status={st} size={12} />{st ? STATUS[st].label : '—'}</h4>
          <SubconChip subcon={subconById(subId)} />
        </header>
        <div className="body">
          <dl className="kv">
            <div><dt>Installation</dt><dd>{WORK_LABEL[work]}{disc === 'MMS' && work === 'ongoing' ? ` (${t.mms_pct}%)` : ''}</dd></div>
            <div><dt>QA/QC</dt><dd>{QA_LABEL[qa]}</dd></div>
            <div><dt>Target start / finish</dt><dd className="small">{fmtDate(disc === 'MMS' ? t.mms_target_start : t.pv_target_start)} – {fmtDate(disc === 'MMS' ? t.mms_target_finish : t.pv_target_finish)}</dd></div>
            <div><dt>Actual start / finish</dt><dd className="small">{fmtDate(disc === 'MMS' ? t.mms_actual_start : t.pv_actual_start)} – {fmtDate(disc === 'MMS' ? t.mms_actual_finish : t.pv_actual_finish)}</dd></div>
          </dl>
          {work === 'on_hold' && <div className="flag">On hold: {disc === 'MMS' ? t.mms_hold_reason : t.pv_hold_reason}</div>}
          {disc === 'PV' && <ModuleGrid mask={t.pv_mask || 0} total={t.modules_required} rows={t.module_rows} cols={t.module_cols} />}
          {blockedByDependency && <div className="flag">The mounting structure is not complete, so PV progress can’t be recorded (Mounting Structure → PV Modules).
            {can(role, 'exception.record') && <> <button className="linkbtn" onClick={() => setModal('exception')}>Record an approved exception</button></>}</div>}
        </div>
      </div>

      {pending.length > 0 && <PendingReports t={t} disc={disc} reports={pending} reload={reload} />}

      {qa !== 'approved' && !blockedByDependency && (canUpdate || canSubmit) &&
        <ProgressForm t={t} disc={disc} work={work} submitMode={!canUpdate} reload={reload} />}
      {qa === 'approved' && <div className="flag ok">{(disc === 'MMS' ? t.mms_approved_at : t.pv_approved_at) ? `Approved ${fmtDate(disc === 'MMS' ? t.mms_approved_at : t.pv_approved_at)}.` : `Approved per the ${disc === 'MMS' ? 'MMS APPROVED 2.0' : 'APPROVED PV'} drawing (CAD baseline; approval date not in the drawing).`} Approved work is locked; QA/QC can reopen it if a defect is found.</div>}

      <section className="stack tight">
        <h4>Inspection and approval</h4>
        <div className="row wrap">
          {work === 'completed' && (qa === 'none' || (qa === 'for_rectification' && !openPunch.length)) && can(role, 'inspection.request') && (!isSub || mine) &&
            <button className="btn" onClick={() => setModal('request')}>{qa === 'for_rectification' ? 'Request reinspection' : isSub ? 'Submit for inspection' : 'Request inspection'}</button>}
          {requests.length > 0 && can(role, 'inspection.schedule') && qa === 'ready_for_inspection' &&
            <button className="btn" onClick={async () => { const date = today(); await act(() => rpc('schedule_inspection', { p_request_ids: requests.map((r) => r.id), p_date: date }), 'Inspection scheduled for today', t.id, reload); }}>Schedule for today</button>}
          {work === 'completed' && qa !== 'approved' && can(role, 'inspection.record') && <button className="btn primary" onClick={() => setModal('inspect')}>Record inspection result</button>}
          {qa === 'for_approval' && can(role, 'approval.record') && <button className="btn primary" onClick={() => setModal('approve')}>Record approval</button>}
          {qa === 'approved' && can(role, 'approval.reopen') && <button className="btn danger" onClick={() => setModal('reopen')}>Reopen approval</button>}
          {work === 'completed' && qa !== 'approved' && can(role, 'punch.raise') && <button className="btn" onClick={() => setModal('punch')}>Add punch-list item</button>}
          {isSub && work === 'completed' && mine && can(role, 'inspection.contractor') && <button className="btn quiet" onClick={() => setModal('inspect')}>Log our own inspection</button>}
        </div>
        {requests.map((r) => <div key={r.id} className="small muted">Inspection {r.status === 'scheduled' ? `scheduled for ${fmtDate(r.scheduled_for)}` : 'requested'} {fmtDateTime(r.requested_at)} by {personName(r.requested_by)}{r.is_reinspection ? ' (reinspection)' : ''}</div>)}
        {qa === 'none' && work !== 'completed' && <span className="small faint">Inspection can be requested once the work is complete.</span>}
      </section>

      {punch.length > 0 && <PunchList t={t} items={punch} reload={reload} />}

      <section className="stack tight">
        <h4>Planning and assignment</h4>
        <div className="row wrap">
          {can(role, 'plan.dates') && <button className="btn sm" onClick={() => setModal('dates')}>Set target dates</button>}
          {can(role, 'assign') && <button className="btn sm" onClick={() => setModal('assign')}>Change subcontractor</button>}
          {disc === 'PV' && !mmsDone && t.has_exception && <span className="small muted">Dependency exception on record.</span>}
        </div>
      </section>

      {modal === 'request' && <RequestModal t={t} disc={disc} onClose={() => setModal(null)} reload={reload} />}
      {modal === 'inspect' && <InspectModal t={t} disc={disc} contractorOnly={!can(role, 'inspection.record')} onClose={() => setModal(null)} reload={reload} />}
      {modal === 'approve' && <ApproveModal t={t} disc={disc} onClose={() => setModal(null)} reload={reload} />}
      {modal === 'reopen' && <TextModal title="Reopen approval" label="What defect was found?" action="Reopen approval" onClose={() => setModal(null)}
        onSave={(txt) => act(() => rpc('reopen_approval', { p_table: t.id, p_discipline: disc, p_reason: txt }), 'Approval reopened: For Rectification', t.id, reload)} />}
      {modal === 'punch' && <TextModal title="Add punch-list item" label="Item to rectify" action="Add item" onClose={() => setModal(null)}
        onSave={(txt) => act(() => rpc('raise_punch_item', { p_table: t.id, p_discipline: disc, p_description: txt }), 'Punch-list item added', t.id, reload)} />}
      {modal === 'exception' && <TextModal title="Record dependency exception" label="Reason PV work may start before the structure is complete" action="Record exception" onClose={() => setModal(null)}
        onSave={(txt) => act(() => rpc('record_dependency_exception', { p_tables: [t.id], p_reason: txt }), 'Exception recorded', t.id, reload)} />}
      {modal === 'dates' && <DatesModal ids={[t.id]} disc={disc} start={disc === 'MMS' ? t.mms_target_start : t.pv_target_start} finish={disc === 'MMS' ? t.mms_target_finish : t.pv_target_finish} onClose={() => setModal(null)} reload={reload} />}
      {modal === 'assign' && <AssignModal ids={[t.id]} disc={disc} current={subId} subcons={subcons} onClose={() => setModal(null)} reload={reload} />}
    </>
  );
}

function ProgressForm({ t, disc, work, submitMode, reload }: { t: TableState; disc: Discipline; work: WorkStatus; submitMode: boolean; reload: () => void }) {
  const [sel, setSel] = useState<WorkStatus>(work);
  const [pctV, setPct] = useState<number>(t.mms_pct ?? 0);
  const [mask, setMask] = useState<number>(t.pv_mask || 0);
  const [hold, setHold] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { setSel(work); setMask(t.pv_mask || 0); setPct(t.mms_pct ?? 0); }, [t.id, work, t.pv_mask, t.mms_pct]);
  const full = fullMask(t.modules_required);
  const choose = (w: WorkStatus) => { setSel(w); if (disc === 'PV') { if (w === 'completed') setMask(full); if (w === 'not_started') setMask(0); } };
  const save = async () => {
    setBusy(true);
    const args = disc === 'PV'
      ? { p_mask: sel === 'on_hold' ? null : mask }
      : { p_pct: sel === 'ongoing' ? pctV : null };
    const ok = submitMode
      ? await act(() => rpc('submit_accomplishment', { p_table: t.id, p_discipline: disc, p_work: sel, p_note: note || null, ...(disc === 'PV' ? { p_mask: mask } : { p_pct: sel === 'ongoing' ? pctV : null }) }), 'Submitted for verification', t.id, reload)
      : await act(() => rpc('update_progress', { p_tables: [t.id], p_discipline: disc, p_work: sel, p_hold_reason: sel === 'on_hold' ? hold : null, p_note: note || null, ...args }), 'Progress saved', t.id, reload);
    if (ok) setNote('');
    setBusy(false);
  };
  const statuses: WorkStatus[] = ['not_started', 'ongoing', 'on_hold', 'completed'];
  const keyOf: Record<WorkStatus, any> = { not_started: 'not_started', ongoing: 'ongoing', on_hold: 'on_hold', completed: 'completed' };
  return (
    <section className="stack">
      <h4>{submitMode ? 'Report accomplishment' : 'Update installation'}</h4>
      <div className="statusbtns" role="radiogroup" aria-label="Installation status">
        {statuses.map((w) => <button key={w} type="button" role="radio" aria-checked={sel === w} className={`statusbtn ${sel === w ? 'on' : ''}`} onClick={() => choose(w)}>
          <StatusDot status={keyOf[w]} />{WORK_LABEL[w]}</button>)}
      </div>
      {disc === 'MMS' && sel === 'ongoing' && <label className="field"><span>Estimated progress: {pctV}%</span><input type="range" min={0} max={95} step={5} value={pctV} onChange={(e) => setPct(+e.target.value)} /></label>}
      {disc === 'PV' && sel !== 'on_hold' && <ModuleGrid mask={mask} total={t.modules_required} rows={t.module_rows} cols={t.module_cols} editable onChange={(m) => { setMask(m); setSel(m === 0 ? 'not_started' : m === full ? 'completed' : 'ongoing'); }} />}
      {sel === 'on_hold' && !submitMode && <label className="field"><span>Reason for hold</span><input type="text" value={hold} onChange={(e) => setHold(e.target.value)} placeholder="e.g. Pile refusal, waiting for redesign" /></label>}
      <label className="field"><span>Note (optional)</span><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <button className="btn primary lg" disabled={busy || (sel === 'on_hold' && !submitMode && !hold.trim())} onClick={save}>{submitMode ? 'Submit for verification' : 'Save progress'}</button>
      {submitMode && <span className="xs faint">Your report counts toward official progress after a Site Engineer verifies it.</span>}
    </section>
  );
}

function PendingReports({ t, disc, reports, reload }: { t: TableState; disc: Discipline; reports: Row[]; reload: () => void }) {
  const role = useStore((s) => s.profile?.role) ?? null;
  return (
    <section className="flag info" style={{ flexDirection: 'column' }}>
      {reports.map((r) => (
        <div key={r.id} className="stack tight">
          <div className="small"><b>Waiting for verification:</b> {WORK_LABEL[r.work_status as WorkStatus]}{disc === 'PV' && r.installed_modules != null ? `, ${r.installed_modules}/${t.modules_required} modules` : ''}{r.progress_pct != null ? `, ${r.progress_pct}%` : ''} — reported {fmtDateTime(r.submitted_at)} by {personName(r.submitted_by)}{r.note ? `: “${r.note}”` : ''}</div>
          {can(role, 'report.verify') && <div className="row">
            <button className="btn sm primary" onClick={() => act(() => rpc('review_accomplishment', { p_id: r.id, p_verify: true }), 'Verified: official progress updated', t.id, reload)}>Verify</button>
            <button className="btn sm" onClick={() => act(() => rpc('review_accomplishment', { p_id: r.id, p_verify: false, p_note: 'Not as reported on site' }), 'Report rejected', t.id, reload)}>Reject</button>
          </div>}
        </div>
      ))}
    </section>
  );
}

function PunchList({ t, items, reload }: { t: TableState; items: Row[]; reload: () => void }) {
  const role = useStore((s) => s.profile?.role) ?? null;
  const open = items.filter((p) => p.status === 'open'); const resub = items.filter((p) => p.status === 'resubmitted');
  return (
    <section className="stack tight">
      <div className="row between"><h4>Rectification items</h4>
        <div className="row">
          {open.length > 0 && can(role, 'punch.resubmit') && <button className="btn sm" onClick={() => act(() => rpc('resubmit_rectification', { p_ids: open.map((p) => p.id), p_note: 'Rectified' }), 'Rectification resubmitted for reinspection', t.id, reload)}>Mark all rectified</button>}
          {resub.length > 0 && can(role, 'punch.close') && <button className="btn sm" onClick={() => act(() => rpc('close_punch_items', { p_ids: resub.map((p) => p.id), p_note: 'Verified closed' }), 'Items closed', t.id, reload)}>Close resubmitted</button>}
        </div>
      </div>
      {items.map((p) => (
        <div key={p.id} className={`flag ${p.status === 'open' ? 'error' : p.status === 'closed' ? 'ok' : 'info'}`}>
          <div className="grow small"><b>{p.status === 'open' ? 'Open' : p.status === 'resubmitted' ? 'Resubmitted' : 'Closed'}</b> — {p.description}
            <div className="xs faint">Raised {fmtDate(p.raised_at)} by {personName(p.raised_by)}{p.resubmitted_at ? ` · resubmitted ${fmtDate(p.resubmitted_at)}` : ''}{p.closed_at ? ` · closed ${fmtDate(p.closed_at)}` : ''}</div></div>
        </div>
      ))}
    </section>
  );
}

function RequestModal({ t, disc, onClose, reload }: { t: TableState; disc: Discipline; onClose: () => void; reload: () => void }) {
  const role = useStore((s) => s.profile?.role) ?? null;
  const [note, setNote] = useState(''); const [date, setDate] = useState('');
  return (
    <Modal title={role === 'subcontractor' ? 'Submit work for inspection' : 'Request inspection'} onClose={onClose}
      footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => { if (await act(() => rpc('request_inspection', { p_tables: [t.id], p_discipline: disc, p_note: note || null, p_scheduled: role === 'subcontractor' ? null : date || null }), 'Inspection requested', t.id, reload)) onClose(); }}>Send request</button></>}>
      <div className="stack">
        <p className="small muted">{label(t)} {disc === 'MMS' ? 'mounting structure' : 'PV modules'} will show as {role === 'subcontractor' ? 'Ready for Inspection until QA/QC schedules it' : 'For Inspection'}.</p>
        {role !== 'subcontractor' && <label className="field"><span>Scheduled date (optional)</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}
        <label className="field"><span>Note to QA/QC (optional)</span><textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

function InspectModal({ t, disc, contractorOnly, onClose, reload }: { t: TableState; disc: Discipline; contractorOnly: boolean; onClose: () => void; reload: () => void }) {
  const [stage, setStage] = useState<'qaqc' | 'client' | 'contractor'>(contractorOnly ? 'contractor' : 'qaqc');
  const [result, setResult] = useState<'passed' | 'failed'>('passed');
  const [comments, setComments] = useState(''); const [nc, setNc] = useState(''); const [items, setItems] = useState(''); const [who, setWho] = useState('');
  const save = async () => {
    const ok = await act(() => rpc('record_inspection', {
      p_table: t.id, p_discipline: disc, p_stage: stage, p_result: result, p_comments: comments || null, p_nonconformities: nc || null,
      p_punch: result === 'failed' ? items.split('\n').map((s) => s.trim()).filter(Boolean) : null, p_inspector_name: who || null,
    }), result === 'passed' ? 'Inspection passed' : 'Inspection failed: For Rectification', t.id, reload);
    if (ok) onClose();
  };
  return (
    <Modal title={`Inspection result — ${label(t)} ${disc === 'MMS' ? 'mounting structure' : 'PV modules'}`} onClose={onClose}
      footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Record result</button></>}>
      <div className="stack">
        {!contractorOnly && <label className="field"><span>Inspection step</span>
          <select value={stage} onChange={(e) => setStage(e.target.value as any)}>
            <option value="qaqc">Internal QA/QC verification</option><option value="client">Client inspection (records approval when passed)</option><option value="contractor">Contractor inspection (record only)</option>
          </select></label>}
        <div className="statusbtns">
          <button type="button" className={`statusbtn ${result === 'passed' ? 'on' : ''}`} onClick={() => setResult('passed')}><StatusDot status="approved" />Passed</button>
          <button type="button" className={`statusbtn ${result === 'failed' ? 'on' : ''}`} onClick={() => setResult('failed')}><StatusDot status="for_rectification" />Failed</button>
        </div>
        {stage === 'client' && <label className="field"><span>Client representative</span><input type="text" value={who} onChange={(e) => setWho(e.target.value)} /></label>}
        <label className="field"><span>Comments</span><textarea value={comments} onChange={(e) => setComments(e.target.value)} /></label>
        {result === 'failed' && <>
          <label className="field"><span>Nonconformities observed</span><textarea value={nc} onChange={(e) => setNc(e.target.value)} /></label>
          {stage !== 'contractor' && <label className="field"><span>Rectification items, one per line</span><textarea value={items} onChange={(e) => setItems(e.target.value)} placeholder={'Re-torque purlin bolts\nReplace damaged clamp'} /></label>}
        </>}
        {stage === 'qaqc' && result === 'passed' && <p className="xs faint">Passing QA/QC moves the table to For Approval when the project requires client approval.</p>}
      </div>
    </Modal>
  );
}

function ApproveModal({ t, disc, onClose, reload }: { t: TableState; disc: Discipline; onClose: () => void; reload: () => void }) {
  const [stage, setStage] = useState<'client' | 'final'>('client'); const [who, setWho] = useState(''); const [ref, setRef] = useState(''); const [note, setNote] = useState('');
  return (
    <Modal title={`Record approval — ${label(t)}`} onClose={onClose}
      footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => { if (await act(() => rpc('record_approval', { p_tables: [t.id], p_discipline: disc, p_stage: stage, p_approver_name: who || null, p_reference: ref || null, p_note: note || null }), 'Approval recorded', t.id, reload)) onClose(); }}>Record approval</button></>}>
      <div className="stack">
        <label className="field"><span>Approval</span><select value={stage} onChange={(e) => setStage(e.target.value as any)}><option value="client">Client approval</option><option value="final">Final approval</option></select></label>
        <label className="field"><span>Approved by</span><input type="text" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Name of the approving representative" /></label>
        <label className="field"><span>Reference (inspection request or form number)</span><input type="text" value={ref} onChange={(e) => setRef(e.target.value)} /></label>
        <label className="field"><span>Note</span><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

export function TextModal({ title, label: lab, action, onClose, onSave }: { title: string; label: string; action: string; onClose: () => void; onSave: (t: string) => Promise<boolean> }) {
  const [v, setV] = useState('');
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!v.trim()} onClick={async () => { if (await onSave(v.trim())) onClose(); }}>{action}</button></>}>
      <label className="field"><span>{lab}</span><textarea value={v} onChange={(e) => setV(e.target.value)} /></label>
    </Modal>
  );
}

export function DatesModal({ ids, disc, start, finish, onClose, reload }: { ids: string[]; disc: Discipline; start?: string | null; finish?: string | null; onClose: () => void; reload?: () => void }) {
  const [s, setS] = useState(start || ''); const [f, setF] = useState(finish || '');
  return (
    <Modal title={`Target dates — ${ids.length} table${ids.length > 1 ? 's' : ''}, ${disc === 'MMS' ? 'mounting structure' : 'PV modules'}`} onClose={onClose}
      footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => {
        try { await rpc('set_target_dates', { p_tables: ids, p_discipline: disc, p_start: s || null, p_finish: f || null }); toast('Target dates saved'); await refreshTables(ids); reload?.(); onClose(); } catch (e) { toast(errText(e), 'error'); }
      }}>Save dates</button></>}>
      <div className="grid cols-2"><label className="field"><span>Target start</span><input type="date" value={s} onChange={(e) => setS(e.target.value)} /></label><label className="field"><span>Target completion</span><input type="date" value={f} onChange={(e) => setF(e.target.value)} /></label></div>
    </Modal>
  );
}

export function AssignModal({ ids, disc, current, subcons, onClose, reload }: { ids: string[]; disc: Discipline; current?: string | null; subcons: { id: string; code: string; color: string }[]; onClose: () => void; reload?: () => void }) {
  const [v, setV] = useState(current || '');
  return (
    <Modal title={`${disc === 'MMS' ? 'MMS' : 'PV'} subcontractor — ${ids.length} table${ids.length > 1 ? 's' : ''}`} onClose={onClose}
      footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => {
        try { await rpc('set_assignment', { p_tables: ids, p_discipline: disc, p_subcon: v || null }); toast('Assignment saved'); await refreshTables(ids); reload?.(); onClose(); } catch (e) { toast(errText(e), 'error'); }
      }}>Save assignment</button></>}>
      <div className="stack tight" role="radiogroup">
        {subcons.map((s) => <label key={s.id} className="check"><input type="radio" name="sc" checked={v === s.id} onChange={() => setV(s.id)} /><span className="swatch" style={{ background: s.color }} />{s.code}</label>)}
        <label className="check"><input type="radio" name="sc" checked={v === ''} onChange={() => setV('')} />Assignment not specified</label>
        <p className="xs faint">MMS and PV assignments are stored separately; this changes only the {disc} assignment.</p>
      </div>
    </Modal>
  );
}

function QaHistory({ t, d, reload }: { t: TableState; d: Detail; reload: () => void }) {
  const rows = [
    ...d.inspections.map((i) => ({ at: i.inspected_at, kind: 'Inspection', disc: i.discipline, text: `${i.stage === 'qaqc' ? 'Internal QA/QC' : i.stage === 'client' ? 'Client' : i.stage === 'contractor' ? 'Contractor' : 'Final'} inspection ${i.result}${i.comments ? ` — ${i.comments}` : ''}${i.nonconformities ? ` (NC: ${i.nonconformities})` : ''}`, who: i.inspector_name || personName(i.inspector_id) })),
    ...d.approvals.map((a) => ({ at: a.approved_at, kind: 'Approval', disc: a.discipline, text: `${a.stage === 'qaqc' ? 'QA/QC' : a.stage === 'client' ? 'Client' : 'Final'} approval${a.reference ? ` · ${a.reference}` : ''}${a.source !== 'manual' && a.source !== 'inspection' ? ` (${a.source})` : ''}`, who: a.approver_name || personName(a.approved_by) })),
    ...d.requests.map((r) => ({ at: r.requested_at, kind: 'Request', disc: r.discipline, text: `${r.is_reinspection ? 'Reinspection' : 'Inspection'} requested — ${r.status}${r.scheduled_for ? `, scheduled ${fmtDate(r.scheduled_for)}` : ''}`, who: personName(r.requested_by) })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (!rows.length && !d.punch.length) return <div className="empty"><h3>No inspections yet</h3><p>Inspection requests, results and approvals for {label(t)} will appear here.</p></div>;
  return (
    <>
      <ul className="timeline">{rows.map((r, i) => <li key={i}><b>{r.disc}</b> · {r.text}<div className="when">{fmtDateTime(r.at)} — {r.who}</div></li>)}</ul>
      {d.punch.length > 0 && <PunchList t={t} items={d.punch} reload={reload} />}
    </>
  );
}

const EVENT_TEXT: Record<string, string> = {
  baseline: 'Imported from CAD baseline', progress: 'Progress updated', submitted: 'Accomplishment submitted', verified: 'Accomplishment verified', rejected: 'Accomplishment rejected',
  inspection_requested: 'Inspection requested', inspection_scheduled: 'Inspection scheduled', inspected: 'Inspection recorded', rectification_raised: 'Rectification raised',
  rectification_resubmitted: 'Rectification resubmitted', rectification_closed: 'Rectification closed', approved: 'Approved', assigned: 'Subcontractor assignment changed', exception: 'Dependency exception',
};
function History({ d }: { d: Detail }) {
  if (!d.events.length) return <div className="empty"><h3>No history yet</h3></div>;
  return (
    <ul className="timeline">
      {d.events.map((e) => (
        <li key={e.id}>
          <b>{e.discipline}</b> · {EVENT_TEXT[e.event] || e.event}
          {e.from_work !== e.to_work && e.to_work ? ` · ${e.from_work ? WORK_LABEL[e.from_work as WorkStatus] : '—'} → ${WORK_LABEL[e.to_work as WorkStatus]}` : ''}
          {e.from_qa !== e.to_qa && e.to_qa ? ` · QA ${QA_LABEL[(e.from_qa || 'none') as QaStatus]} → ${QA_LABEL[e.to_qa as QaStatus]}` : ''}
          {e.modules_delta ? ` · ${e.modules_delta > 0 ? '+' : ''}${e.modules_delta} modules (${e.installed_modules})` : ''}
          {e.note ? <div className="small muted">{e.note}</div> : null}
          <div className="when">{fmtDateTime(e.at)} — {e.actor ? personName(e.actor) : 'System import'}{e.actor_role ? ` (${e.actor_role.replace(/_/g, ' ')})` : ''}</div>
        </li>
      ))}
    </ul>
  );
}

function Files({ t, d, reload }: { t: TableState; d: Detail; reload: () => void }) {
  const role = useStore((s) => s.profile?.role) ?? null;
  const uid = useStore((s) => s.session?.user.id);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [disc, setDisc] = useState<'' | Discipline>('');
  const [caption, setCaption] = useState('');
  useEffect(() => {
    const paths = d.files.map((f) => f.storage_path);
    if (!paths.length) return;
    supabase.storage.from('attachments').createSignedUrls(paths, 3600).then(({ data }) => {
      const m: Record<string, string> = {}; (data || []).forEach((x) => { if (x.signedUrl && x.path) m[x.path] = x.signedUrl; }); setUrls(m);
    });
  }, [d.files]);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const f of Array.from(files)) {
      const path = `${t.id}/${Date.now()}-${f.name.replace(/[^\w.-]+/g, '_')}`;
      const up = await supabase.storage.from('attachments').upload(path, f, { contentType: f.type || undefined });
      if (up.error) { toast(errText(up.error), 'error'); continue; }
      const ins = await supabase.from('attachments').insert({ table_id: t.id, discipline: disc || null, storage_path: path, file_name: f.name, mime: f.type, size_bytes: f.size, caption: caption || null, uploaded_by: uid });
      if (ins.error) toast(errText(ins.error), 'error'); else toast(`Uploaded ${f.name}`);
    }
    setBusy(false); setCaption(''); reload(); refreshTables([t.id]);
  };
  const remove = async (f: Row) => {
    const r = await supabase.storage.from('attachments').remove([f.storage_path]);
    if (r.error) return toast(errText(r.error), 'error');
    await supabase.from('attachments').delete().eq('id', f.id); toast('File removed'); reload();
  };
  return (
    <>
      {can(role, 'attach') && (
        <section className="stack tight">
          <div className="row wrap">
            <label className="field" style={{ width: 150 }}><span>For</span><select value={disc} onChange={(e) => setDisc(e.target.value as any)}><option value="">Whole table</option><option value="MMS">Mounting structure</option><option value="PV">PV modules</option></select></label>
            <label className="field grow"><span>Caption (optional)</span><input type="text" value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
          </div>
          <div className="row wrap">
            <label className="btn primary">{Icon.camera}Take photo<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => upload(e.target.files)} /></label>
            <label className="btn">Add files<input type="file" multiple hidden accept="image/*,application/pdf,.xlsx,.docx,.csv,.txt" onChange={(e) => upload(e.target.files)} /></label>
            {busy && <span className="small muted">Uploading…</span>}
          </div>
        </section>
      )}
      {!d.files.length ? <div className="empty"><h3>No photos or documents</h3><p>Site photos and inspection documents for {label(t)} appear here.</p></div> :
        <div className="grid cols-2">{d.files.map((f) => (
          <figure key={f.id} className="sheet" style={{ margin: 0, overflow: 'hidden' }}>
            {f.mime?.startsWith('image/') && urls[f.storage_path]
              ? <a href={urls[f.storage_path]} target="_blank" rel="noreferrer"><img src={urls[f.storage_path]} alt={f.caption || f.file_name} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', display: 'block' }} /></a>
              : <a href={urls[f.storage_path]} target="_blank" rel="noreferrer" className="row" style={{ padding: 12, minHeight: 80 }}>{Icon.download}<span className="small">{f.file_name}</span></a>}
            <figcaption className="xs" style={{ padding: '6px 8px' }}>
              {f.caption || f.file_name}<div className="faint">{f.discipline || 'Table'} · {fmtDate(f.uploaded_at)} · {personName(f.uploaded_by)}</div>
              {(f.uploaded_by === uid || role === 'admin') && <button className="linkbtn" onClick={() => remove(f)}>Remove</button>}
            </figcaption>
          </figure>))}
        </div>}
    </>
  );
}

export function useNames() { const [, set] = useState(0); useEffect(() => { loadNames().then(() => set((x) => x + 1)); }, []); return personName; }
