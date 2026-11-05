import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import { personName, useNames } from '../components/TablePanel';
import { Empty, fmtDate, fmtDateTime, Modal, Tabs } from '../components/ui';
import { PERMISSION_MATRIX, ROLE_LABEL, type Action, type Profile, type Role } from '../lib/model';
import { errText, fetchAll, loadAll, rpc, SUPABASE_ANON_KEY, SUPABASE_URL, supabase, toast, useStore } from '../lib/store';

type Tab = 'users' | 'subcontractors' | 'drawings' | 'drone' | 'settings' | 'audit' | 'roles';
const ROLES: Role[] = ['admin', 'ceo', 'project_manager', 'construction_manager', 'pic_engineer', 'qaqc_engineer', 'site_engineer', 'project_planner', 'subcontractor'];

export default function Admin() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'users';
  useNames();
  return (
    <div className="page">
      <div className="page-head"><div><h1>Administration</h1><p>Users and roles, subcontractor colours, the drawing import, the drone layer and the audit trail.</p></div></div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} items={[
        { key: 'users', label: 'Users and roles' }, { key: 'subcontractors', label: 'Subcontractors' }, { key: 'drawings', label: 'Drawings and import' },
        { key: 'drone', label: 'Drone layer' }, { key: 'settings', label: 'Project settings' }, { key: 'audit', label: 'Audit trail' }, { key: 'roles', label: 'Permissions' },
      ]} />
      <div style={{ marginTop: 14 }}>
        {tab === 'users' && <Users />}{tab === 'subcontractors' && <Subcons />}{tab === 'drawings' && <Drawings />}
        {tab === 'drone' && <Drone />}{tab === 'settings' && <Settings />}{tab === 'audit' && <Audit />}{tab === 'roles' && <Roles />}
      </div>
    </div>
  );
}

function Users() {
  const subcons = useStore((s) => s.subcons); const blocks = useStore((s) => s.blocks);
  const [rows, setRows] = useState<Profile[]>([]); const [edit, setEdit] = useState<Profile | null>(null); const [adding, setAdding] = useState(false);
  const load = () => supabase.from('profiles').select('*').order('created_at').then(({ data }) => setRows((data as Profile[]) || []));
  useEffect(() => { load(); }, []);
  const pending = rows.filter((r) => !r.role);
  return (
    <div className="stack">
      {pending.length > 0 && <div className="flag">{pending.length} account{pending.length > 1 ? 's are' : ' is'} waiting for a role. Until a role is assigned they can’t see any project data.</div>}
      <section className="sheet">
        <header><h3>Users ({rows.length})</h3><button className="btn sm primary" onClick={() => setAdding(true)}>Add user</button></header>
        <div className="tablewrap"><table className="data">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Subcontractor</th><th>Blocks</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((p) => <tr key={p.id}><td><b>{p.full_name}</b></td><td>{p.email}</td><td>{p.role ? ROLE_LABEL[p.role] : <b style={{ color: 'var(--danger)' }}>Waiting for role</b>}</td>
            <td>{subcons.find((s) => s.id === p.subcontractor_id)?.code ?? '—'}</td><td>{p.assigned_blocks?.join(', ') || (p.role === 'site_engineer' ? 'All' : '—')}</td><td>{p.active ? 'Active' : 'Disabled'}</td>
            <td className="n"><button className="btn sm" onClick={() => setEdit(p)}>Edit</button></td></tr>)}</tbody>
        </table></div>
      </section>
      {edit && <EditUser p={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} subcons={subcons} blocks={blocks.map((b) => b.code)} />}
      {adding && <AddUser onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
    </div>
  );
}
function EditUser({ p, onClose, onSaved, subcons, blocks }: { p: Profile; onClose: () => void; onSaved: () => void; subcons: { id: string; code: string }[]; blocks: string[] }) {
  const [role, setRole] = useState<Role | ''>(p.role || ''); const [sub, setSub] = useState(p.subcontractor_id || ''); const [bl, setBl] = useState<string[]>(p.assigned_blocks || []);
  const [active, setActive] = useState(p.active); const [name, setName] = useState(p.full_name || '');
  const save = async () => {
    try { await rpc('admin_update_profile', { p_user: p.id, p_role: role || null, p_subcon: sub || null, p_blocks: bl.length ? bl : null, p_active: active, p_full_name: name }); toast('User updated'); onSaved(); }
    catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <Modal title={`Edit ${p.email}`} onClose={onClose} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!role} onClick={save}>Save user</button></>}>
      <div className="stack">
        <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Role</span><select value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="">Choose a role</option>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
        {role === 'subcontractor' && <label className="field"><span>Subcontractor company</span><select value={sub} onChange={(e) => setSub(e.target.value)}><option value="">Choose</option>{subcons.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select></label>}
        {role === 'site_engineer' && <div className="field"><span>Assigned blocks (none ticked = all blocks)</span><div className="row wrap">{blocks.map((b) => <label key={b} className="check"><input type="checkbox" checked={bl.includes(b)} onChange={(e) => setBl(e.target.checked ? [...bl, b] : bl.filter((x) => x !== b))} />{b}</label>)}</div></div>}
        <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Account active</label>
      </div>
    </Modal>
  );
}
function AddUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    // a separate client so the administrator stays signed in
    const iso = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'iso-signup' } });
    const { data, error } = await iso.auth.signUp({ email, password: pw, options: { data: { full_name: name } } });
    setBusy(false);
    if (error) return toast(errText(error), 'error');
    toast(data.session ? 'Account created. Assign a role to give access.' : 'Account created. The user must confirm their email, then you assign a role.');
    onDone();
  };
  return (
    <Modal title="Add user" onClose={onClose} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !email || pw.length < 8} onClick={create}>Create account</button></>}>
      <div className="stack">
        <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>Temporary password (8+ characters)</span><input type="text" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <p className="xs faint">New accounts start without a role; choose it in the user list. Share the temporary password privately and ask the user to change it.</p>
      </div>
    </Modal>
  );
}

function Subcons() {
  const subcons = useStore((s) => s.subcons);
  const [draft, setDraft] = useState<Record<string, { name: string; color: string; aliases: string; active: boolean }>>({});
  const [adding, setAdding] = useState(false); const [nc, setNc] = useState({ code: '', name: '', color: '#888888' });
  const val = (id: string) => draft[id] || (() => { const s = subcons.find((x) => x.id === id)!; return { name: s.name, color: s.color, aliases: s.aliases.join(', '), active: s.active }; })();
  const save = async (id: string) => {
    const v = val(id);
    const { error } = await supabase.from('subcontractors').update({ name: v.name, color: v.color, aliases: v.aliases.split(',').map((a) => a.trim()).filter(Boolean), active: v.active }).eq('id', id);
    if (error) return toast(errText(error), 'error');
    toast('Subcontractor saved'); setDraft((d) => { const n = { ...d }; delete n[id]; return n; }); loadAll();
  };
  return (
    <section className="sheet">
      <header><div><h3>Subcontractors and keyplan colours</h3><div className="xs faint">Colours start from the CAD legends and show assignment only.</div></div><button className="btn sm primary" onClick={() => setAdding(true)}>Add subcontractor</button></header>
      <div className="tablewrap"><table className="data"><thead><tr><th>Code</th><th>Name</th><th>Other spellings in drawings</th><th>Colour</th><th>Active</th><th /></tr></thead>
        <tbody>{subcons.map((s) => { const v = val(s.id); const set = (p: Partial<typeof v>) => setDraft((d) => ({ ...d, [s.id]: { ...v, ...p } })); return (
          <tr key={s.id}><td><b>{s.code}</b></td><td><input type="text" value={v.name} onChange={(e) => set({ name: e.target.value })} aria-label={`${s.code} name`} /></td>
            <td><input type="text" value={v.aliases} onChange={(e) => set({ aliases: e.target.value })} aria-label={`${s.code} aliases`} /></td>
            <td><input type="color" value={v.color} onChange={(e) => set({ color: e.target.value })} aria-label={`${s.code} colour`} style={{ width: 52, height: 34, padding: 2 }} /></td>
            <td><input type="checkbox" checked={v.active} onChange={(e) => set({ active: e.target.checked })} aria-label={`${s.code} active`} /></td>
            <td className="n"><button className="btn sm" disabled={!draft[s.id]} onClick={() => save(s.id)}>Save</button></td></tr>); })}</tbody></table></div>
      {adding && <Modal title="Add subcontractor" onClose={() => setAdding(false)} footer={<><button className="btn quiet" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" disabled={!nc.code.trim()} onClick={async () => {
        const { error } = await supabase.from('subcontractors').insert({ code: nc.code.trim().toUpperCase(), name: nc.name || nc.code, color: nc.color });
        if (error) return toast(errText(error), 'error'); toast('Subcontractor added'); setAdding(false); loadAll();
      }}>Add</button></>}>
        <div className="grid cols-3"><label className="field"><span>Code</span><input type="text" value={nc.code} onChange={(e) => setNc({ ...nc, code: e.target.value })} /></label>
          <label className="field"><span>Name</span><input type="text" value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></label>
          <label className="field"><span>Colour</span><input type="color" value={nc.color} onChange={(e) => setNc({ ...nc, color: e.target.value })} style={{ height: 38 }} /></label></div>
      </Modal>}
    </section>
  );
}

function Drawings() {
  const [drawings, setDrawings] = useState<any[]>([]); const [issues, setIssues] = useState<any[]>([]); const [code, setCode] = useState(''); const byId = useStore((s) => s.byId);
  const load = () => { supabase.from('drawings').select('*').order('imported_at').then(({ data }) => setDrawings(data || [])); fetchAll<any>('import_issues', '*', (q) => q.order('id')).then(setIssues); };
  useEffect(() => { load(); }, []);
  const summary = issues.find((i) => i.code === 'IMPORT_SUMMARY');
  const list = issues.filter((i) => i.code !== 'IMPORT_SUMMARY' && (!code || i.code === code));
  const codes = useMemo(() => [...new Set(issues.filter((i) => i.code !== 'IMPORT_SUMMARY').map((i) => i.code))].sort(), [issues]);
  const mark = async (i: any, status: string) => {
    const { error } = await supabase.from('import_issues').update({ status, resolution: status === 'accepted' ? 'Accepted as drawn' : 'Corrected', resolved_at: new Date().toISOString() }).eq('id', i.id);
    if (error) toast(errText(error), 'error'); else load();
  };
  const R = summary?.details;
  return (
    <div className="stack loose">
      <section className="sheet"><header><h3>Imported drawings</h3></header>
        <div className="tablewrap"><table className="data"><thead><tr><th>File</th><th>Used for</th><th>Status</th><th className="n">Outlines</th><th className="n">Unique tables</th><th>Notes</th></tr></thead>
          <tbody>{drawings.map((d) => <tr key={d.id}><td><b>{d.file_name}</b><div className="xs faint mono">{d.sha256?.slice(0, 16)}</div></td><td>{d.purpose.replace(/_/g, ' ').replace(',', ', ')}</td><td>{d.status}</td>
            <td className="n">{d.stats?.outlines?.toLocaleString() ?? '—'}</td><td className="n">{d.stats?.unique_tables?.toLocaleString() ?? '—'}</td><td className="small">{d.notes}</td></tr>)}</tbody></table></div>
      </section>
      {R && <section className="sheet"><header><h3>Import summary</h3></header><div className="body small">
        <p>Baseline: <b>{R.tables?.total?.toLocaleString()}</b> unique tables from {R.baseline?.outlines?.toLocaleString()} outlines in MMS APPROVED 2.0 ({R.baseline?.duplicate_outlines?.toLocaleString()} stacked duplicate outlines collapsed). Table IDs found for <b>{R.tables?.with_table_id?.toLocaleString()}</b>; {R.tables?.without_table_id} without, {R.tables?.duplicate_id_tables} sharing a duplicated ID.</p>
        <p style={{ marginTop: 6 }}>MMS approved {R.mms?.approved?.toLocaleString()} (previous revision {R.mms?.approved_previous_revision?.toLocaleString()}); MMS assigned {R.mms?.assigned?.toLocaleString()}. PV approved {R.pv?.approved?.toLocaleString()}; PV assigned {R.pv?.assigned?.toLocaleString()}; {R.pv?.pv_approved_without_mms_approval} PV-approved tables without MMS approval.</p>
        <p style={{ marginTop: 6 }}>The PV per-subcon drawing’s own totals text says: {(R.pv?.drawing_totals_text || []).map((t: string) => t.split('\n')[0]).join('; ')}. Counts here come from the per-table fills.</p>
      </div></section>}
      <section className="sheet">
        <header><div><h3>Import issues ({list.length})</h3><div className="xs faint">Nothing was silently fixed. Review each item and mark it accepted or corrected.</div></div>
          <select value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 'auto' }} aria-label="Issue type"><option value="">All issue types</option>{codes.map((c) => <option key={c}>{c}</option>)}</select></header>
        <div className="tablewrap" style={{ maxHeight: 520 }}><table className="data"><thead><tr><th>Severity</th><th>Type</th><th>Detail</th><th>Table</th><th>Drawing</th><th>Status</th><th /></tr></thead>
          <tbody>{list.map((i) => { const t = i.table_id ? byId.get(i.table_id) : null; return (
            <tr key={i.id}><td><b style={{ color: i.severity === 'error' ? 'var(--danger)' : i.severity === 'warning' ? 'var(--warn)' : 'var(--ink-2)' }}>{i.severity}</b></td><td className="xs mono">{i.code}</td><td className="small">{i.message}</td>
              <td className="mono">{t ? t.table_code || t.sys_key : ''}</td><td className="xs">{i.drawing}</td><td>{i.status}</td>
              <td className="n">{i.status === 'open' && <span className="row" style={{ justifyContent: 'end' }}><button className="btn sm" onClick={() => mark(i, 'accepted')}>Accept</button><button className="btn sm" onClick={() => mark(i, 'resolved')}>Corrected</button></span>}</td></tr>); })}</tbody></table></div>
      </section>
    </div>
  );
}

function Drone() {
  const drone = useStore((s) => s.drone);
  if (!drone) return <Empty title="No drone layer loaded" />;
  const f = drone.meta.fit; const ev = (f.evidence || {}) as Record<string, number>;
  return (
    <section className="sheet"><header><h3>Drone image {fmtDate(drone.capture_date)}</h3></header><div className="body stack">
      <dl className="kv" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div><dt>Source file</dt><dd className="small">{drone.source_file}</dd></div><div><dt>Ground resolution</dt><dd>{f.gsd_m.toFixed(3)} m per pixel</dd></div>
        <div><dt>Rotation to drawing</dt><dd>{f.rotation_deg.toFixed(2)}°</dd></div><div><dt>Shear</dt><dd>{f.shear.toFixed(4)} (≈ none)</dd></div>
        <div><dt>Registration score</dt><dd>{f.ecc.join(' / ')}</dd></div><div><dt>Tiles</dt><dd>{(drone.meta as any).tiles?.count ?? '—'} WebP tiles, private bucket</dd></div>
      </dl>
      <div className="flag info"><div className="small">The image was positioned on the CAD tables by automatic registration (scale, rotation and offset fitted to the detected modules). The CAD geometry is unchanged.
        {' '}{ev.pv_approved_with_modules_visible?.toLocaleString()} of {ev.pv_approved_total?.toLocaleString()} PV-approved tables show modules at their CAD position; {ev.modules_visible_not_pv_approved?.toLocaleString()} tables show modules but are not PV-approved in the drawing.</div></div>
      <div className="flag"><div className="small"><b>Limitations.</b> Mosaic stitching seams shift the image locally by up to about 1 m; tables are not distorted to hide this. The north-west tail has no installed tables to check against. Module detection misses some glare-lit modules, so the evidence is a lower bound. A new flight needs the same registration step (pipeline/drone.py) or a georeferenced GeoTIFF plus CAD in the same coordinate system.</div></div>
    </div></section>
  );
}

function Settings() {
  const settings = useStore((s) => s.settings); const tables = useStore((s) => s.tables);
  const [client, setClient] = useState(settings?.requires_client_approval ?? true); const [op, setOp] = useState(settings?.status_opacity ?? 0.45);
  const [ids, setIds] = useState(''); const [mods, setMods] = useState(28);
  const save = async () => {
    const { error } = await supabase.from('project').update({ settings: { ...settings, requires_client_approval: client, status_opacity: op }, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) return toast(errText(error), 'error'); toast('Settings saved'); loadAll();
  };
  const applyMods = async () => {
    const codes = ids.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    const found = tables.filter((t) => codes.includes((t.table_code || '').toUpperCase()) || codes.includes(t.sys_key));
    if (!found.length) return toast('No tables match those IDs', 'error');
    try { await rpc('update_table_config', { p_tables: found.map((t) => t.id), p_modules: mods }); toast(`${found.length} table${found.length > 1 ? 's' : ''} updated`); loadAll(); } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <div className="grid cols-2">
      <section className="sheet"><header><h3>Quality process</h3></header><div className="body stack">
        <label className="check"><input type="checkbox" checked={client} onChange={(e) => setClient(e.target.checked)} /><span>Client approval required after QA/QC inspection<br /><span className="xs faint">On: passing QA/QC moves a table to For Approval until the client approval is recorded. Off: passing QA/QC approves it.</span></span></label>
        <label className="field"><span>Default status colour opacity on the keyplan: {Math.round(op * 100)}%</span><input type="range" min={0.1} max={1} step={0.05} value={op} onChange={(e) => setOp(+e.target.value)} /></label>
        <button className="btn primary" onClick={save}>Save settings</button>
      </div></section>
      <section className="sheet"><header><h3>Approved design quantity</h3></header><div className="body stack">
        <p className="small muted">Each table needs {settings?.modules_per_table ?? 28} modules ({settings?.module_rows ?? 4} rows × {settings?.module_cols ?? 7} columns of {settings?.module_size_m?.join(' × ')} m) unless set here. {settings?.module_numbering}</p>
        <label className="field"><span>Table IDs (separate with spaces or commas)</span><textarea value={ids} onChange={(e) => setIds(e.target.value)} className="mono" /></label>
        <label className="field" style={{ width: 200 }}><span>Modules required</span><input type="number" min={1} max={31} value={mods} onChange={(e) => setMods(+e.target.value)} /></label>
        <button className="btn" onClick={applyMods}>Apply to tables</button>
      </div></section>
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState<any[]>([]); const [tbl, setTbl] = useState('');
  useEffect(() => { let q = supabase.from('audit_log').select('*').order('id', { ascending: false }).limit(300); if (tbl) q = q.eq('table_name', tbl); q.then(({ data }) => setRows(data || [])); }, [tbl]);
  return (
    <section className="sheet">
      <header><div><h3>Audit trail</h3><div className="xs faint">Who created or changed each record, previous and new values, and when (latest 300).</div></div>
        <select value={tbl} onChange={(e) => setTbl(e.target.value)} style={{ width: 'auto' }} aria-label="Record type"><option value="">All records</option>{['progress', 'assignments', 'accomplishments', 'inspections', 'approvals', 'punch_items', 'inspection_requests', 'attachments', 'site_constraints', 'profiles', 'subcontractors', 'targets', 'milestones', 'dependency_exceptions'].map((t) => <option key={t}>{t}</option>)}</select></header>
      {!rows.length ? <Empty title="No changes recorded yet" /> :
        <div className="tablewrap" style={{ maxHeight: 600 }}><table className="data"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Changes</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td className="small">{fmtDateTime(r.at)}</td><td>{r.actor ? personName(r.actor) : 'System'}<div className="xs faint">{r.actor_role ? ROLE_LABEL[r.actor_role as Role] : ''}</div></td>
            <td>{r.action}</td><td className="small">{r.table_name}</td>
            <td className="xs mono" style={{ maxWidth: 520 }}>{r.action === 'update' ? (r.changed || []).filter((k: string) => !['updated_at', 'verified_at'].includes(k)).map((k: string) => `${k}: ${fmt(r.old_data?.[k])} → ${fmt(r.new_data?.[k])}`).join('; ') : r.action === 'insert' ? summarise(r.new_data) : summarise(r.old_data)}</td></tr>)}</tbody></table></div>}
    </section>
  );
}
const fmt = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const summarise = (o: any) => (o ? Object.entries(o).filter(([k, v]) => v !== null && !/(^id$|_at$|_by$)/.test(k)).slice(0, 6).map(([k, v]) => `${k}: ${fmt(v)}`).join('; ') : '');

function Roles() {
  const actions = Object.keys(PERMISSION_MATRIX) as Action[];
  const text: Record<Action, string> = {
    'progress.update': 'Record verified installation progress', 'progress.submit': 'Submit accomplishment for verification', 'report.verify': 'Verify or reject submitted accomplishments',
    'inspection.request': 'Request inspection', 'inspection.schedule': 'Schedule inspections', 'inspection.record': 'Record QA/QC and client inspection results', 'inspection.contractor': 'Log a contractor inspection',
    'approval.record': 'Record client/final approval', 'approval.reopen': 'Reopen approved work', 'punch.raise': 'Raise punch-list items', 'punch.resubmit': 'Resubmit rectified work', 'punch.close': 'Close punch-list items',
    assign: 'Assign tables to subcontractors', 'plan.dates': 'Set target dates', 'plan.targets': 'Set daily/weekly targets', 'plan.milestones': 'Manage milestones', 'plan.dependencies': 'Edit dependency rules',
    'exception.record': 'Approve dependency exceptions', 'constraint.raise': 'Record site constraints', 'constraint.resolve': 'Resolve constraints', attach: 'Upload photos and documents',
    admin: 'Administration', 'view.audit': 'View audit trail', 'view.comparison': 'Compare subcontractors', 'view.all': 'See every table’s records',
  };
  return (
    <section className="sheet"><header><div><h3>Permissions by role</h3><div className="xs faint">Enforced in the database (row-level security and workflow procedures), not only in the screens. Subcontractors see records for their own tables only.</div></div></header>
      <div className="tablewrap"><table className="data"><thead><tr><th>Permission</th>{ROLES.map((r) => <th key={r} className="n" style={{ whiteSpace: 'normal', minWidth: 70 }}>{ROLE_LABEL[r]}</th>)}</tr></thead>
        <tbody>{actions.map((a) => <tr key={a}><td>{text[a]}</td>{ROLES.map((r) => <td key={r} className="n">{PERMISSION_MATRIX[a].includes(r) ? '●' : ''}</td>)}</tr>)}</tbody></table></div>
    </section>
  );
}
