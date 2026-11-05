import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, fmtDate, Icon, StatusDot } from '../components/ui';
import { label, STATUS, STATUSES, statusOf, type StatusKey, type TableState } from '../lib/model';
import { exportXlsx } from '../lib/exports';
import { setState, subconById, toast, useStore } from '../lib/store';

/** Mechanical Works: the table register (MMS and PV kept as separate columns, linked by Table ID). */
export function Mechanical() {
  const tables = useStore((s) => s.tables); const subcons = useStore((s) => s.subcons); const blocks = useStore((s) => s.blocks);
  const role = useStore((s) => s.profile?.role); const nav = useNavigate();
  const [f, setF] = useState({ q: '', block: '', sub: '', mms: '', pv: '', flag: '' });
  const [page, setPage] = useState(0); const PAGE = 150;
  const rows = useMemo(() => tables.filter((t) => {
    if (role === 'subcontractor' && !t.mms_work && !t.pv_work) return false;
    if (f.q && !(t.table_code || t.sys_key).toUpperCase().includes(f.q.toUpperCase().trim())) return false;
    if (f.block && t.block_code !== f.block) return false;
    if (f.sub && t.mms_subcon !== f.sub && t.pv_subcon !== f.sub) return false;
    if (f.mms && statusOf(t, 'MMS') !== f.mms) return false;
    if (f.pv && statusOf(t, 'PV') !== f.pv) return false;
    if (f.flag === 'punch' && !(t.mms_open_punch + t.pv_open_punch)) return false;
    if (f.flag === 'pending' && !t.pending_reports) return false;
    if (f.flag === 'id' && !t.id_flags.length) return false;
    return true;
  }), [tables, f, role]);
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);
  const exportRows = () => exportXlsx(`Table-register-${new Date().toISOString().slice(0, 10)}`, [{ name: 'Tables', rows: rows.map((t) => ({
    'Table ID': t.table_code || '', 'System ID': t.sys_key, Block: t.block_code, Row: t.id_row, Column: t.id_col,
    'MMS subcontractor': subconById(t.mms_subcon)?.code || '', 'MMS installation': t.mms_work || '', 'MMS QA/QC': t.mms_qa || '', 'MMS status': statusOf(t, 'MMS') ? STATUS[statusOf(t, 'MMS')!].label : '',
    'MMS target finish': t.mms_target_finish || '', 'MMS actual finish': t.mms_actual_finish || '',
    'PV subcontractor': subconById(t.pv_subcon)?.code || '', 'PV modules installed': t.pv_modules ?? '', 'Modules required': t.modules_required, 'PV status': statusOf(t, 'PV') ? STATUS[statusOf(t, 'PV')!].label : '',
    'PV target finish': t.pv_target_finish || '', 'PV actual finish': t.pv_actual_finish || '', 'Open rectification items': t.mms_open_punch + t.pv_open_punch,
    'Drone module cover': t.drone_cover ?? '', 'ID notes': t.id_flags.join(', '),
  })) }]).then(() => toast('Excel file downloaded'));
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Mechanical works</h1><p>Mounting structure and PV module records per table. Both disciplines share the Table ID but keep separate assignments, progress, inspections and approvals.</p></div>
        <div className="row"><button className="btn" onClick={() => { setState({ focus: { ids: new Set(rows.map((r) => r.id)), label: 'Register filter' } }); nav('/keyplan'); }}>{Icon.map}Show {rows.length.toLocaleString()} on keyplan</button><button className="btn" onClick={exportRows}>{Icon.download}Excel</button></div>
      </div>
      <div className="sheet" style={{ marginBottom: 12 }}><div className="body">
        <div className="grid cols-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <label className="field"><span>Table ID</span><input type="search" value={f.q} onChange={(e) => { setF({ ...f, q: e.target.value }); setPage(0); }} placeholder="M04-11" className="mono" /></label>
          <label className="field"><span>Block</span><select value={f.block} onChange={(e) => { setF({ ...f, block: e.target.value }); setPage(0); }}><option value="">All</option>{blocks.map((b) => <option key={b.code}>{b.code}</option>)}</select></label>
          {role !== 'subcontractor' && <label className="field"><span>Subcontractor</span><select value={f.sub} onChange={(e) => { setF({ ...f, sub: e.target.value }); setPage(0); }}><option value="">All</option>{subcons.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select></label>}
          <label className="field"><span>MMS status</span><select value={f.mms} onChange={(e) => { setF({ ...f, mms: e.target.value }); setPage(0); }}><option value="">All</option>{STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          <label className="field"><span>PV status</span><select value={f.pv} onChange={(e) => { setF({ ...f, pv: e.target.value }); setPage(0); }}><option value="">All</option>{STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          <label className="field"><span>Show only</span><select value={f.flag} onChange={(e) => { setF({ ...f, flag: e.target.value }); setPage(0); }}><option value="">All</option><option value="punch">Open rectification</option><option value="pending">Reports to verify</option><option value="id">Table ID issues</option></select></label>
        </div>
      </div></div>
      <div className="sheet">
        <div className="tablewrap" style={{ maxHeight: 'calc(100vh - 330px)', minHeight: 300 }}>
          {!rows.length ? <Empty title="No tables match these filters">Clear a filter to see more tables.</Empty> :
            <table className="data">
              <thead><tr><th>Table ID</th><th>Block</th><th>MMS subcon</th><th>Mounting structure</th><th>PV subcon</th><th className="n">Modules</th><th>PV modules</th><th className="n">Open items</th><th>Target (PV)</th></tr></thead>
              <tbody>{shown.map((t) => <Row key={t.id} t={t} onOpen={() => nav(`/keyplan?table=${t.table_code || t.sys_key}`)} />)}</tbody>
            </table>}
        </div>
        {rows.length > PAGE && <div className="row between" style={{ padding: '10px 16px', borderTop: '1px solid var(--rule)' }}>
          <span className="small muted">{(page * PAGE + 1).toLocaleString()}–{Math.min(rows.length, (page + 1) * PAGE).toLocaleString()} of {rows.length.toLocaleString()}</span>
          <div className="row"><button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><button className="btn sm" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(page + 1)}>Next</button></div>
        </div>}
      </div>
    </div>
  );
}
function Row({ t, onOpen }: { t: TableState; onOpen: () => void }) {
  const ms = statusOf(t, 'MMS') as StatusKey | null; const ps = statusOf(t, 'PV') as StatusKey | null;
  return (
    <tr className="clickable" onClick={onOpen}>
      <td className="mono"><b>{label(t)}</b>{t.id_flags.length ? <span title={t.id_flags.join(', ')} style={{ color: 'var(--danger)' }}> *</span> : null}</td>
      <td>{t.block_code}</td>
      <td>{subconById(t.mms_subcon)?.code ?? <span className="faint">—</span>}</td>
      <td>{ms ? <span className="row" style={{ gap: 6 }}><StatusDot status={ms} />{STATUS[ms].label}</span> : <span className="faint">—</span>}</td>
      <td>{subconById(t.pv_subcon)?.code ?? <span className="faint">—</span>}</td>
      <td className="n mono">{t.pv_work ? `${t.pv_modules ?? 0}/${t.modules_required}` : '—'}</td>
      <td>{ps ? <span className="row" style={{ gap: 6 }}><StatusDot status={ps} />{STATUS[ps].label}</span> : <span className="faint">—</span>}</td>
      <td className="n">{t.mms_open_punch + t.pv_open_punch || ''}</td>
      <td>{fmtDate(t.pv_target_finish)}</td>
    </tr>
  );
}

export function Electrical() {
  const items = [
    ['Inverter locations', 'Inverter positions and IDs', 'Inverter association per table/string'],
    ['MVPS units', 'MVPS 1–4 positions (the PV per-subcon drawing lists MVPS 1–4 table counts)', 'MVPS layer and block-to-MVPS mapping'],
    ['DC strings', 'String IDs per table, with table-to-string mapping', 'String ID, cable status, testing (IV curve / insulation) per table'],
    ['Cable routes', 'DC/AC cable route drawing (DWG/DXF)', 'Cable route layer and circuit links'],
    ['Earthing system', 'Earthing layout drawing', 'Earthing layer and test records'],
  ];
  return (
    <div className="page">
      <div className="page-head"><div><h1>Electrical works</h1><p>Electrical tracking was not in the first release: no electrical drawings were provided. The table details already show DC connections as outstanding, so records can be added without changing how tables are identified.</p></div></div>
      <div className="sheet"><header><h3>Source files needed to switch this on</h3></header>
        <div className="tablewrap"><table className="data"><thead><tr><th>Layer</th><th>Drawing or data needed</th><th>What it enables</th></tr></thead>
          <tbody>{items.map(([a, b, c]) => <tr key={a}><td><b>{a}</b></td><td>{b}</td><td>{c}</td></tr>)}</tbody></table></div>
        <div className="body"><p className="small muted">Send the drawings in the same coordinate system as MMS APPROVED 2.0 (or the General Layout). Element IDs as text or block attributes let each item link to its records, as the Table IDs do.</p></div>
      </div>
    </div>
  );
}
