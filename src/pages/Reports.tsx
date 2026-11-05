import { useMemo, useState } from 'react';
import { Empty, Icon, today } from '../components/ui';
import { personName } from '../components/TablePanel';
import { countTables, fmtPct, label, type Discipline, type QaStatus } from '../lib/model';
import { exportPdf, exportXlsx, type PdfSection } from '../lib/exports';
import { addDays, mondayOf, turnaroundDays, useDashData } from '../lib/stats';
import { toast, useStore, getState } from '../lib/store';

type Kind = 'daily' | 'weekly' | 'subcon' | 'qa' | 'punch';
const KINDS: { key: Kind; label: string; desc: string }[] = [
  { key: 'daily', label: 'Daily construction progress report', desc: 'Verified completions, modules installed, inspections, approvals and constraints for one day' },
  { key: 'weekly', label: 'Weekly progress report', desc: 'The same figures for a Monday-to-Sunday week, with cumulative status' },
  { key: 'subcon', label: 'Subcontractor accomplishment report', desc: 'Assigned, completed, approved and outstanding work per subcontractor' },
  { key: 'qa', label: 'QA/QC inspection status report', desc: 'Inspection pipeline, results in the period, turnaround and open items' },
  { key: 'punch', label: 'Punch-list register', desc: 'Every rectification item with its table, owner and status' },
];

export default function Reports() {
  const role = useStore((s) => s.profile?.role);
  const subId = useStore((s) => s.profile?.subcontractor_id);
  const tables = useStore((s) => s.tables); const subcons = useStore((s) => s.subcons); const projectName = useStore((s) => s.projectName);
  const [kind, setKind] = useState<Kind>(role === 'subcontractor' ? 'subcon' : role === 'qaqc_engineer' ? 'qa' : 'daily');
  const [day, setDay] = useState(today());
  const data = useDashData(70);
  const range = useMemo(() => {
    if (kind === 'weekly') { const from = mondayOf(new Date(day)); return { from: from.toISOString().slice(0, 10), to: addDays(from, 6).toISOString().slice(0, 10) }; }
    if (kind === 'daily') return { from: day, to: day };
    return { from: addDays(new Date(day), -29).toISOString().slice(0, 10), to: day };
  }, [kind, day]);
  const inRange = (ts: string) => { const k = String(ts).slice(0, 10); return k >= range.from && k <= range.to; };
  const byId = getState().byId;
  const code = (id: string) => { const t = byId.get(id); return t ? label(t) : id; };
  const subName = (id: string | null) => subcons.find((s) => s.id === id)?.code ?? '—';
  const subOf = (tid: string, d: Discipline) => { const t = byId.get(tid); return t ? (d === 'MMS' ? t.mms_subcon : t.pv_subcon) : null; };

  const sections: PdfSection[] = useMemo(() => {
    if (!data.loaded) return [];
    const ev = data.events.filter((e) => inRange(e.at));
    const done = ev.filter((e) => (e.event === 'progress' || e.event === 'verified') && e.to_work === 'completed' && e.from_work !== 'completed');
    const insp = data.inspections.filter((i) => inRange(i.inspected_at) && i.stage !== 'contractor');
    const appr = ev.filter((e) => e.event === 'approved');
    const cons = data.constraints.filter((c) => inRange(c.raised_at));
    const status = (['MMS', 'PV'] as Discipline[]).map((d) => { const c = countTables(tables, d); return [d === 'MMS' ? 'Mounting structure' : 'PV modules', c.total, c.installed, fmtPct(c.installed, c.total), c.forInspection, c.rectification, c.forApproval, c.approved, fmtPct(c.approved, c.total), c.onHold, c.remaining]; });
    const statusSec: PdfSection = { heading: 'Cumulative status (all tables, as of now)', note: 'Counts overlap and are not added together. Installed is not the same as approved.', columns: ['Discipline', 'Tables', 'Installed', '%', 'For inspection', 'For rectification', 'For approval', 'Approved', '%', 'On hold', 'Remaining'], rows: status };
    const perSubPeriod = subcons.map((s) => [s.code, done.filter((e) => e.discipline === 'MMS' && subOf(e.table_id, 'MMS') === s.id).length, done.filter((e) => e.discipline === 'PV' && subOf(e.table_id, 'PV') === s.id).length,
      ev.filter((e) => e.discipline === 'PV' && e.modules_delta > 0 && (e.event === 'progress' || e.event === 'verified') && subOf(e.table_id, 'PV') === s.id).reduce((a, e) => a + e.modules_delta, 0),
      insp.filter((i) => subOf(i.table_id, i.discipline) === s.id && i.result === 'passed').length, insp.filter((i) => subOf(i.table_id, i.discipline) === s.id && i.result === 'failed').length]);
    if (kind === 'daily' || kind === 'weekly') return [
      { heading: 'Accomplishment in the period by subcontractor', note: 'Verified progress only.', columns: ['Subcontractor', 'MMS tables completed', 'PV tables completed', 'PV modules installed', 'Inspections passed', 'Inspections failed'], rows: perSubPeriod },
      statusSec,
      { heading: 'Tables completed in the period', columns: ['Date', 'Table ID', 'Discipline', 'Subcontractor', 'Recorded by'], rows: done.map((e) => [String(e.at).slice(0, 10), code(e.table_id), e.discipline, subName(subOf(e.table_id, e.discipline)), personName(e.actor)]) },
      { heading: 'Inspections and approvals in the period', columns: ['Date', 'Table ID', 'Discipline', 'Step', 'Result', 'Comments'], rows: [...insp.map((i) => [String(i.inspected_at).slice(0, 10), code(i.table_id), i.discipline, i.stage, i.result, i.comments || '']), ...appr.map((a) => [String(a.at).slice(0, 10), code(a.table_id), a.discipline, 'approval', 'approved', a.note || ''])] },
      { heading: 'Constraints raised in the period', columns: ['Date', 'Table / block', 'Category', 'Description', 'Status'], rows: cons.map((c) => [String(c.raised_at).slice(0, 10), c.table_id ? code(c.table_id) : c.block_code || '—', c.category, c.description, c.status]) },
    ];
    if (kind === 'subcon') {
      const list = role === 'subcontractor' ? subcons.filter((s) => s.id === subId) : subcons;
      return (['MMS', 'PV'] as Discipline[]).map((d) => ({
        heading: d === 'MMS' ? 'Mounting structure' : 'PV modules', note: 'Completed and approved are kept separate; a subcontractor may have completed work still awaiting inspection.',
        columns: ['Subcontractor', 'Assigned', 'Completed', 'Approved', 'For inspection', 'For rectification', 'On hold', 'Remaining', 'Progress'],
        rows: list.map((s) => { const c = countTables(tables, d, s.id); return [s.code, c.total, c.installed, c.approved, c.forInspection, c.rectification, c.onHold, c.remaining, fmtPct(c.installed, c.total)]; }),
      }));
    }
    if (kind === 'qa') {
      const reqs = data.requests.filter((r) => inRange(r.requested_at));
      const open = data.requests.filter((r) => r.status === 'open' || r.status === 'scheduled');
      const ta = turnaroundDays(data.requests, data.inspections);
      return [
        { heading: 'Inspection pipeline (now)', columns: ['Discipline', 'Ready for inspection', 'For inspection', 'For rectification', 'For approval', 'Approved'], rows: (['MMS', 'PV'] as Discipline[]).map((d) => { const q = (s: QaStatus) => tables.filter((t) => (d === 'MMS' ? t.mms_qa : t.pv_qa) === s).length; return [d, q('ready_for_inspection'), q('for_inspection'), q('for_rectification'), q('for_approval'), q('approved')]; }) },
        { heading: `Requests and results, ${range.from} to ${range.to}`, note: `Average turnaround from request to result: ${ta === null ? 'no completed requests yet' : `${ta.toFixed(1)} days`}.`, columns: ['Measure', 'Count'], rows: [['Requests received', reqs.length], ['Inspections recorded', insp.length], ['Passed', insp.filter((i) => i.result === 'passed').length], ['Failed (defects found)', insp.filter((i) => i.result === 'failed').length], ['Reinspection backlog', open.filter((r) => r.is_reinspection).length]] },
        { heading: 'Open inspection requests', columns: ['Requested', 'Table ID', 'Discipline', 'Status', 'Scheduled', 'Reinspection'], rows: open.map((r) => [String(r.requested_at).slice(0, 10), code(r.table_id), r.discipline, r.status, r.scheduled_for || '', r.is_reinspection ? 'yes' : '']) },
      ];
    }
    return [{ heading: 'Punch-list register', columns: ['Raised', 'Table ID', 'Discipline', 'Subcontractor', 'Item', 'Status', 'Resubmitted', 'Closed'],
      rows: data.punch.map((p) => [String(p.raised_at).slice(0, 10), code(p.table_id), p.discipline, subName(p.subcontractor_id), p.description, p.status, p.resubmitted_at ? String(p.resubmitted_at).slice(0, 10) : '', p.closed_at ? String(p.closed_at).slice(0, 10) : '']) }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, kind, range, tables, subcons]);

  const title = KINDS.find((k) => k.key === kind)!.label;
  const sub = `${projectName} · ${kind === 'daily' ? range.from : kind === 'weekly' ? `Week ${range.from} to ${range.to}` : kind === 'qa' ? `Period ${range.from} to ${range.to}` : `As of ${today()}`}`;
  const fname = `${title.replace(/[^\w]+/g, '-')}-${range.to}`;
  const toXlsx = () => exportXlsx(fname, sections.map((s) => ({ name: s.heading.slice(0, 31).replace(/[\\/?*[\]:]/g, ''), rows: s.rows.map((r) => Object.fromEntries(s.columns.map((c, i) => [c, r[i]]))) }))).then(() => toast('Excel file downloaded')).catch((e) => toast(String(e), 'error'));
  const toPdf = () => exportPdf(fname, title, sub, sections).then(() => toast('PDF downloaded')).catch((e) => toast(String(e), 'error'));
  const kinds = role === 'subcontractor' ? KINDS.filter((k) => k.key === 'subcon' || k.key === 'punch') : KINDS;

  return (
    <div className="stack loose">
      <div className="sheet"><div className="body">
        <div className="row wrap" style={{ alignItems: 'end', gap: 12 }}>
          <label className="field" style={{ minWidth: 280 }}><span>Report</span><select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select></label>
          {kind !== 'subcon' && kind !== 'punch' && <label className="field" style={{ width: 180 }}><span>{kind === 'weekly' ? 'Any day in the week' : kind === 'qa' ? 'Period ending' : 'Date'}</span><input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value || today())} /></label>}
          <div className="grow" />
          <button className="btn" disabled={!sections.length} onClick={toXlsx}>{Icon.download}Excel</button>
          <button className="btn primary" disabled={!sections.length} onClick={toPdf}>{Icon.download}PDF</button>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>{KINDS.find((k) => k.key === kind)!.desc}. Generated from the same records as the keyplan and dashboards.</p>
      </div></div>
      {!data.loaded ? <Empty title="Loading records…" /> : sections.map((s) => (
        <section key={s.heading} className="sheet">
          <header><div><h3>{s.heading}</h3>{s.note && <div className="xs faint">{s.note}</div>}</div><span className="xs faint">{s.rows.length} row{s.rows.length === 1 ? '' : 's'}</span></header>
          <div className="tablewrap" style={{ maxHeight: 420 }}>
            {s.rows.length ? <table className="data"><thead><tr>{s.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{s.rows.slice(0, 300).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === 'number' ? 'n' : undefined}>{typeof c === 'number' ? c.toLocaleString() : c}</td>)}</tr>)}</tbody></table>
              : <Empty title="No records in this period" />}
          </div>
        </section>
      ))}
    </div>
  );
}
