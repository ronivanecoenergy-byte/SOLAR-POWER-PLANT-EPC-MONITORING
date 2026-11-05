import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { personName, useNames } from '../components/TablePanel';
import { Empty, fmtDate, fmtDateTime, Modal, Tabs, today } from '../components/ui';
import { can, label, QA_LABEL, type Discipline, type QaStatus } from '../lib/model';
import { useDashData, type Row } from '../lib/stats';
import { errText, getState, refreshTables, rpc, setState, toast, useStore } from '../lib/store';

type Tab = 'requests' | 'approval' | 'punch' | 'log' | 'reinspection';
export default function QaQc() {
  const role = useStore((s) => s.profile?.role) ?? null; const byId = useStore((s) => s.byId); const tables = useStore((s) => s.tables);
  const subcons = useStore((s) => s.subcons); const nav = useNavigate();
  const data = useDashData(90); useNames();
  const [tab, setTab] = useState<Tab>('requests');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [disc, setDisc] = useState<'' | Discipline>(''); const [sub, setSub] = useState('');
  const [modal, setModal] = useState<null | 'schedule' | 'approve'>(null); const [date, setDate] = useState(today()); const [who, setWho] = useState(''); const [refNo, setRefNo] = useState('');
  const code = (id: string) => { const t = byId.get(id); return t ? label(t) : '—'; };
  const subOf = (id: string, d: Discipline) => { const t = byId.get(id); return t ? (d === 'MMS' ? t.mms_subcon : t.pv_subcon) : null; };
  const keep = (r: Row) => (!disc || r.discipline === disc) && (!sub || subOf(r.table_id, r.discipline) === sub);
  const open = data.requests.filter((r) => (r.status === 'open' || r.status === 'scheduled') && keep(r));
  const approvalRows = useMemo(() => tables.flatMap((t) => (['MMS', 'PV'] as Discipline[]).filter((d) => (d === 'MMS' ? t.mms_qa : t.pv_qa) === 'for_approval').map((d) => ({ id: `${t.id}:${d}`, table_id: t.id, discipline: d }))).filter(keep), [tables, disc, sub]);
  const punch = data.punch.filter(keep);
  const log = data.inspections.filter(keep).slice().reverse();
  const reinsp = open.filter((r) => r.is_reinspection);
  const goTable = (id: string) => { const t = byId.get(id); nav(`/keyplan?table=${t?.table_code || t?.sys_key}`); };
  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const run = async (fn: () => Promise<unknown>, ok: string, ids: string[]) => { try { await fn(); toast(ok); setSel(new Set()); setModal(null); await refreshTables(ids); setState((s) => ({ dataVersion: s.dataVersion + 1 })); } catch (e) { toast(errText(e), 'error'); } };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>QA/QC</h1><p>Inspection requests, results, approvals and rectification. Contractor inspection, internal QA/QC verification, client inspection and final approval are recorded as separate steps.</p></div>
        <div className="row wrap">
          <select value={disc} onChange={(e) => setDisc(e.target.value as any)} aria-label="Discipline" style={{ width: 'auto' }}><option value="">Both disciplines</option><option value="MMS">Mounting structure</option><option value="PV">PV modules</option></select>
          <select value={sub} onChange={(e) => setSub(e.target.value)} aria-label="Subcontractor" style={{ width: 'auto' }}><option value="">All subcontractors</option>{subcons.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select>
        </div>
      </div>
      <Tabs value={tab} onChange={(t) => { setTab(t); setSel(new Set()); }} items={[
        { key: 'requests', label: `Inspection requests (${open.length})` }, { key: 'approval', label: `Awaiting approval (${approvalRows.length})` },
        { key: 'punch', label: `Punch list (${punch.filter((p) => p.status !== 'closed').length} open)` }, { key: 'reinspection', label: `Reinspection backlog (${reinsp.length})` }, { key: 'log', label: 'Inspection log' },
      ]} />
      <div className="sheet" style={{ marginTop: 12 }}>
        {(tab === 'requests' || tab === 'reinspection') && <>
          <header><span className="small muted">Select requests to schedule them, or open a table to record the result.</span>
            {can(role, 'inspection.schedule') && <button className="btn sm primary" disabled={!sel.size} onClick={() => setModal('schedule')}>Schedule {sel.size || ''}</button>}</header>
          <ReqTable rows={tab === 'reinspection' ? reinsp : open} sel={sel} toggle={toggle} code={code} goTable={goTable} subName={(r) => subcons.find((s) => s.id === subOf(r.table_id, r.discipline))?.code ?? '—'} />
        </>}
        {tab === 'approval' && <>
          <header><span className="small muted">Inspected and passed; the client or final approval is outstanding.</span>
            {can(role, 'approval.record') && <button className="btn sm primary" disabled={!sel.size} onClick={() => setModal('approve')}>Record approval {sel.size || ''}</button>}</header>
          {!approvalRows.length ? <Empty title="Nothing awaiting approval" /> :
            <div className="tablewrap"><table className="data"><thead><tr><th style={{ width: 36 }} /><th>Table ID</th><th>Discipline</th><th>Subcontractor</th></tr></thead>
              <tbody>{approvalRows.map((r) => <tr key={r.id} className={sel.has(r.id) ? 'sel' : ''}><td><input type="checkbox" aria-label={`Select ${code(r.table_id)} ${r.discipline}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td><button className="linkbtn mono" onClick={() => goTable(r.table_id)}>{code(r.table_id)}</button></td><td>{r.discipline}</td><td>{subcons.find((s) => s.id === subOf(r.table_id, r.discipline))?.code ?? '—'}</td></tr>)}</tbody></table></div>}
        </>}
        {tab === 'punch' && (!punch.length ? <Empty title="No punch-list items" /> :
          <div className="tablewrap"><table className="data"><thead><tr><th>Raised</th><th>Table ID</th><th>Discipline</th><th>Subcontractor</th><th>Item</th><th>Status</th><th>Raised by</th></tr></thead>
            <tbody>{punch.slice().reverse().map((p) => <tr key={p.id}><td>{fmtDate(p.raised_at)}</td><td><button className="linkbtn mono" onClick={() => goTable(p.table_id)}>{code(p.table_id)}</button></td><td>{p.discipline}</td>
              <td>{subcons.find((s) => s.id === p.subcontractor_id)?.code ?? '—'}</td><td>{p.description}</td><td><b style={{ color: p.status === 'open' ? 'var(--danger)' : p.status === 'closed' ? 'var(--ok)' : 'var(--ink)' }}>{p.status}</b></td><td>{personName(p.raised_by)}</td></tr>)}</tbody></table></div>)}
        {tab === 'log' && (!log.length ? <Empty title="No inspections recorded in the last 90 days" /> :
          <div className="tablewrap"><table className="data"><thead><tr><th>When</th><th>Table ID</th><th>Discipline</th><th>Step</th><th>Result</th><th>Comments</th><th>Inspector</th></tr></thead>
            <tbody>{log.map((i) => <tr key={i.id}><td>{fmtDateTime(i.inspected_at)}</td><td><button className="linkbtn mono" onClick={() => goTable(i.table_id)}>{code(i.table_id)}</button></td><td>{i.discipline}</td>
              <td>{STAGE[i.stage]}</td><td><b style={{ color: i.result === 'failed' ? 'var(--danger)' : 'var(--ok)' }}>{i.result}</b></td><td>{i.comments}{i.nonconformities ? ` — NC: ${i.nonconformities}` : ''}</td><td>{i.inspector_name || personName(i.inspector_id)}</td></tr>)}</tbody></table></div>)}
      </div>
      {modal === 'schedule' && <Modal title={`Schedule ${sel.size} inspection${sel.size > 1 ? 's' : ''}`} onClose={() => setModal(null)}
        footer={<><button className="btn quiet" onClick={() => setModal(null)}>Cancel</button><button className="btn primary" onClick={() => run(() => rpc('schedule_inspection', { p_request_ids: [...sel], p_date: date }), 'Inspections scheduled', data.requests.filter((r) => sel.has(r.id)).map((r) => r.table_id))}>Schedule</button></>}>
        <label className="field"><span>Inspection date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </Modal>}
      {modal === 'approve' && <Modal title={`Record client approval — ${sel.size} item${sel.size > 1 ? 's' : ''}`} onClose={() => setModal(null)}
        footer={<><button className="btn quiet" onClick={() => setModal(null)}>Cancel</button><button className="btn primary" onClick={async () => {
          const groups: Record<string, string[]> = {}; for (const k of sel) { const [tid, d] = k.split(':'); (groups[d] ||= []).push(tid); }
          await run(async () => { for (const [d, ids] of Object.entries(groups)) await rpc('record_approval', { p_tables: ids, p_discipline: d, p_stage: 'client', p_approver_name: who || null, p_reference: refNo || null }); }, 'Approvals recorded', [...sel].map((k) => k.split(':')[0]));
        }}>Record approval</button></>}>
        <div className="stack"><label className="field"><span>Approved by</span><input type="text" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Client representative" /></label>
          <label className="field"><span>Reference</span><input type="text" value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="e.g. inspection request number" /></label></div>
      </Modal>}
    </div>
  );
}
const STAGE: Record<string, string> = { contractor: 'Contractor', qaqc: 'Internal QA/QC', client: 'Client', final: 'Final' };
function ReqTable({ rows, sel, toggle, code, goTable, subName }: { rows: Row[]; sel: Set<string>; toggle: (k: string) => void; code: (id: string) => string; goTable: (id: string) => void; subName: (r: Row) => string }) {
  if (!rows.length) return <Empty title="No open inspection requests">Requests appear when work is reported ready for inspection.</Empty>;
  const qaOf = (r: Row) => { const t = getState().byId.get(r.table_id); return ((r.discipline === 'MMS' ? t?.mms_qa : t?.pv_qa) || 'none') as QaStatus; };
  return (
    <div className="tablewrap"><table className="data"><thead><tr><th style={{ width: 36 }} /><th>Requested</th><th>Table ID</th><th>Discipline</th><th>Subcontractor</th><th>Status</th><th>Scheduled</th><th>By</th><th>Note</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id} className={sel.has(r.id) ? 'sel' : ''}><td><input type="checkbox" aria-label={`Select request for ${code(r.table_id)}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
        <td>{fmtDateTime(r.requested_at)}</td><td><button className="linkbtn mono" onClick={() => goTable(r.table_id)}>{code(r.table_id)}</button>{r.is_reinspection ? <span className="xs faint"> reinspection</span> : null}</td>
        <td>{r.discipline}</td><td>{subName(r)}</td><td>{QA_LABEL[qaOf(r)]}</td><td>{r.scheduled_for ? fmtDate(r.scheduled_for) : '—'}</td><td>{personName(r.requested_by)}</td><td className="small">{r.note}</td></tr>)}</tbody></table></div>
  );
}
