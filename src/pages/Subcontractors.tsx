import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { GroupedBars } from '../components/Charts';
import { Empty, Figures, fmtDate, Meter } from '../components/ui';
import { COUNT_RULES, countTables, fmtPct, matchCount, type Counts, type Discipline } from '../lib/model';
import { dailyCompletions, useDashData } from '../lib/stats';
import { setState, useStore } from '../lib/store';
import { SubconComparison } from './Dashboard';

export default function Subcontractors() {
  const { code } = useParams();
  return code ? <SubconDetail code={code} /> : (
    <div className="page">
      <div className="page-head"><div><h1>Subcontractors</h1><p>Project-wide comparison from verified records. Completed and approved quantities are kept apart, so a subcontractor may have completed work that is still waiting for inspection.</p></div></div>
      <div className="stack loose"><SubconComparison /><SubconComparisonPV /></div>
    </div>
  );
}
function SubconComparisonPV() { return null; }

function SubconDetail({ code }: { code: string }) {
  const subcons = useStore((s) => s.subcons); const tables = useStore((s) => s.tables); const blocks = useStore((s) => s.blocks);
  const nav = useNavigate(); const data = useDashData(30);
  const s = subcons.find((x) => x.code === code);
  const daily = useMemo(() => (s ? dailyCompletions(data.events, 14, s.id) : null), [data, s]);
  if (!s) return <div className="page"><Empty title={`No subcontractor called ${code}`} /></div>;
  const show = (d: Discipline, k: keyof Counts, lab: string) => {
    setState({ focus: { ids: new Set(tables.filter((t) => (d === 'MMS' ? t.mms_subcon : t.pv_subcon) === s.id && matchCount(t, d, k)).map((t) => t.id)), label: `${s.code} — ${lab}`, discipline: d } });
    nav('/keyplan');
  };
  const figs = (d: Discipline) => { const c = countTables(tables, d, s.id); return [
    { key: 'total', value: c.total.toLocaleString(), label: 'Total assigned tables' }, { key: 'installed', value: c.installed.toLocaleString(), label: 'Installed', sub: fmtPct(c.installed, c.total) },
    { key: 'rectification', value: c.rectification.toLocaleString(), label: 'Requiring rectification' }, { key: 'inspected', value: c.inspected.toLocaleString(), label: 'Inspected' },
    { key: 'approved', value: c.approved.toLocaleString(), label: 'Approved', sub: fmtPct(c.approved, c.total) }, { key: 'forInspection', value: c.forInspection.toLocaleString(), label: 'For inspection' },
    { key: 'onHold', value: c.onHold.toLocaleString(), label: 'On hold' }, { key: 'remaining', value: c.remaining.toLocaleString(), label: 'Remaining' },
  ].map((f) => ({ ...f, title: COUNT_RULES[f.key as keyof Counts], onClick: () => show(d, f.key as keyof Counts, f.label) })); };
  const openPunch = data.punch.filter((p) => p.subcontractor_id === s.id && p.status !== 'closed');
  return (
    <div className="page">
      <div className="page-head">
        <div className="row" style={{ alignItems: 'center', gap: 14 }}><span className="swatch" style={{ background: s.color, width: 28, height: 28, borderRadius: 6 }} />
          <div><h1>{s.code}</h1><p>{s.aliases.length ? `Also written in the drawings as ${s.aliases.join(', ')}. ` : ''}Assigned-table counts per discipline. Select a count to see those tables on the keyplan.</p></div></div>
        <div className="row"><button className="btn" onClick={() => nav('/subcontractors')}>All subcontractors</button><button className="btn primary" onClick={() => { setState({ focus: { ids: new Set(tables.filter((t) => t.mms_subcon === s.id || t.pv_subcon === s.id).map((t) => t.id)), label: `${s.code} assigned tables` } }); nav('/keyplan?mode=pv_subcon'); }}>Show on keyplan</button></div>
      </div>
      <div className="stack loose">
        <section className="stack tight"><h3>Mounting structure</h3><Figures items={figs('MMS')} /></section>
        <section className="stack tight"><h3>PV modules</h3><Figures items={figs('PV')} /></section>
        <div className="grid cols-2">
          <section className="sheet"><header><h3>Assigned blocks and areas</h3></header><div className="body">
            <div className="tablewrap"><table className="data"><thead><tr><th>Block</th><th className="n">MMS tables</th><th style={{ width: '24%' }}>MMS installed</th><th className="n">PV tables</th><th style={{ width: '24%' }}>PV installed</th></tr></thead>
              <tbody>{blocks.map((b) => { const ts = tables.filter((t) => t.block_code === b.code); const m = countTables(ts, 'MMS', s.id), p = countTables(ts, 'PV', s.id); if (!m.total && !p.total) return null; return (
                <tr key={b.code}><td><b>{b.code}</b></td><td className="n">{m.total}</td><td><Meter a={m.approved} b={m.installed} total={m.total} color="var(--series-mms)" /></td><td className="n">{p.total}</td><td><Meter a={p.approved} b={p.installed} total={p.total} color="var(--series-pv)" /></td></tr>); })}</tbody></table></div>
          </div></section>
          <section className="sheet"><header><h3>Daily accomplishment, last 14 days</h3></header><div className="body">
            {daily && (daily.mms.some(Boolean) || daily.pv.some(Boolean)) ? <GroupedBars ariaLabel={`${s.code} tables completed per day`} categories={daily.cats} series={[{ key: 'm', label: 'Mounting structure', color: 'var(--series-mms)', values: daily.mms }, { key: 'p', label: 'PV modules', color: 'var(--series-pv)', values: daily.pv }]} />
              : <Empty title="No verified completions in the last 14 days" />}
          </div></section>
        </div>
        <section className="sheet"><header><h3>Open rectification items ({openPunch.length})</h3></header><div className="body">
          {!openPunch.length ? <span className="small faint">None open.</span> : <div className="tablewrap"><table className="data"><thead><tr><th>Raised</th><th>Table</th><th>Discipline</th><th>Item</th><th>Status</th></tr></thead>
            <tbody>{openPunch.map((p) => { const t = tables.find((x) => x.id === p.table_id); return <tr key={p.id}><td>{fmtDate(p.raised_at)}</td><td className="mono">{t?.table_code || t?.sys_key}</td><td>{p.discipline}</td><td>{p.description}</td><td>{p.status}</td></tr>; })}</tbody></table></div>}
        </div></section>
      </div>
    </div>
  );
}
