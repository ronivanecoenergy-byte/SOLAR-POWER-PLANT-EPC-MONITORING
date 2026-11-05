import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeyplanMap, type ColorMode, type MapHandle } from '../components/KeyplanMap';
import { TablePanel, AssignModal, DatesModal } from '../components/TablePanel';
import { Icon, Modal, StatusDot, fmtDate } from '../components/ui';
import {
  can, countTables, COUNT_RULES, fmtPct, label, matchCount, STATUSES, statusOf, WORK_LABEL,
  type Counts, type Discipline, type StatusKey, type TableState, type WorkStatus,
} from '../lib/model';
import { errText, findTables, refreshTables, rpc, setState, toast, useStore } from '../lib/store';

const MODES: { key: ColorMode; label: string; src: string }[] = [
  { key: 'mms_status', label: 'Mounting structure installation', src: 'MMS APPROVED 2.0' },
  { key: 'mms_subcon', label: 'Mounting structure per subcontractor', src: 'MS APPROVED PER SUBCON' },
  { key: 'pv_status', label: 'PV module installation', src: 'APPROVED PV' },
  { key: 'pv_subcon', label: 'PV modules per subcontractor', src: 'PV ACCOMP_1. PER SUBCON' },
  { key: 'outline', label: 'Outlines only', src: 'EXPANSION PV FARM – GEENRAL LAYOUT' },
];
const discOf = (m: ColorMode): Discipline => (m.startsWith('pv') ? 'PV' : 'MMS');

export default function Keyplan() {
  const tables = useStore((s) => s.tables); const byId = useStore((s) => s.byId); const subcons = useStore((s) => s.subcons);
  const drone = useStore((s) => s.drone); const dataVersion = useStore((s) => s.dataVersion); const settings = useStore((s) => s.settings);
  const profile = useStore((s) => s.profile); const storeFocus = useStore((s) => s.focus); const selected = useStore((s) => s.selected);
  const blocks = useStore((s) => s.blocks); const theme = useStore((s) => s.theme);
  const role = profile?.role ?? null; const isSub = role === 'subcontractor';
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<ColorMode>((params.get('mode') as ColorMode) || (isSub ? (subcons.find((s) => s.id === profile?.subcontractor_id) ? 'mms_status' : 'mms_status') : 'mms_status'));
  const [showDrone, setShowDrone] = useState(true); const [showCad, setShowCad] = useState(true); const [showLabels, setShowLabels] = useState(true);
  const [opacity, setOpacity] = useState(settings?.status_opacity ?? 0.45);
  const [statusFocus, setStatusFocus] = useState<StatusKey | null>(null);
  const [subFocus, setSubFocus] = useState<string | null>(null); // subcon id or 'none'
  const [flt, setFlt] = useState<{ block: string; from: string; to: string; flag: string }>({ block: '', from: '', to: '', flag: '' });
  const [multi, setMulti] = useState<Set<string>>(new Set()); const [multiMode, setMultiMode] = useState(false);
  const [railOpen, setRailOpen] = useState(false); const [panelExpanded, setPanelExpanded] = useState(false);
  const [q, setQ] = useState(''); const [sugOpen, setSugOpen] = useState(false); const [hi, setHi] = useState(0);
  const [tbOpen, setTbOpen] = useState(false); const [tbMin, setTbMin] = useState(false);
  const [scaleEl, setScaleEl] = useState<HTMLDivElement | null>(null);
  const mapRef = useRef<MapHandle>(null);
  const dark = theme === 'dark' || (theme === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches);
  const d = discOf(mode);

  // deep links: ?table=M04-11-07
  useEffect(() => {
    const code = params.get('table');
    if (!code || !tables.length) return;
    const t = tables.find((x) => x.table_code === code || x.sys_key === code || x.id === code);
    if (t) { setState({ selected: t.id }); setTimeout(() => mapRef.current?.zoomTo(t.id), 50); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.length]);
  useEffect(() => { if (storeFocus) setTimeout(() => mapRef.current?.fitIds(storeFocus.ids), 80); }, [storeFocus]);
  useEffect(() => { if (storeFocus?.discipline) setMode((m) => (m.startsWith(storeFocus.discipline === 'PV' ? 'pv' : 'mms') ? m : storeFocus.discipline === 'PV' ? 'pv_status' : 'mms_status')); }, [storeFocus]);

  // focus set = dashboard focus ∩ legend focus ∩ filters
  const focus = useMemo(() => {
    const active = storeFocus || statusFocus || subFocus || flt.block || flt.from || flt.to || flt.flag;
    if (!active) return null;
    const ids = new Set<string>();
    for (const t of tables) {
      if (storeFocus && !storeFocus.ids.has(t.id)) continue;
      if (statusFocus && statusOf(t, d) !== statusFocus) continue;
      if (subFocus) { const sid = d === 'MMS' ? t.mms_subcon : t.pv_subcon; if (subFocus === 'none' ? sid !== null || !(d === 'MMS' ? t.mms_work : t.pv_work) : sid !== subFocus) continue; }
      if (flt.block && t.block_code !== flt.block) continue;
      if (flt.from || flt.to) { const u = (d === 'MMS' ? t.mms_updated_at : t.pv_updated_at)?.slice(0, 10); if (!u || (flt.from && u < flt.from) || (flt.to && u > flt.to)) continue; }
      if (flt.flag === 'id_issue' && !t.id_flags.length) continue;
      if (flt.flag === 'punch' && !(t.mms_open_punch + t.pv_open_punch)) continue;
      if (flt.flag === 'pending' && !t.pending_reports) continue;
      if (flt.flag === 'exception' && !t.has_exception) continue;
      if (flt.flag === 'drone' && !((t.drone_cover ?? 0) > 0.6 && t.pv_work && t.pv_work !== 'completed')) continue;
      ids.add(t.id);
    }
    return ids;
  }, [tables, storeFocus, statusFocus, subFocus, flt, d]);
  const focusLabel = [storeFocus?.label, statusFocus && STATUSES.find((s) => s.key === statusFocus)?.label, subFocus && (subFocus === 'none' ? 'Assignment not specified' : subcons.find((s) => s.id === subFocus)?.code),
    flt.block && `Block ${flt.block}`, (flt.from || flt.to) && `Updated ${flt.from || '…'} to ${flt.to || '…'}`, flt.flag && FLAGS.find((f) => f[0] === flt.flag)?.[1]].filter(Boolean).join(' · ');
  const clearFocus = () => { setState({ focus: null }); setStatusFocus(null); setSubFocus(null); setFlt({ block: '', from: '', to: '', flag: '' }); };

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of tables) { const s = statusOf(t, d); if (s) c[s] = (c[s] || 0) + 1; }
    return c;
  }, [tables, d, dataVersion]);
  const counts = useMemo(() => countTables(tables, d), [tables, d, dataVersion]);
  const perSub = useMemo(() => subcons.map((s) => ({ s, c: countTables(tables, d, s.id) })), [tables, subcons, d, dataVersion]);
  const unassigned = useMemo(() => tables.filter((t) => (d === 'MMS' ? t.mms_work : t.pv_work) && !(d === 'MMS' ? t.mms_subcon : t.pv_subcon)).length, [tables, d]);

  const select = (id: string | null, additive: boolean) => {
    if (multiMode || additive) {
      if (!id) return;
      setMulti((m) => { const n = new Set(m); n.has(id) ? n.delete(id) : n.add(id); return n; });
      return;
    }
    setState({ selected: id }); setPanelExpanded(false);
    if (id) { const t = byId.get(id); if (t) setParams((p) => { p.set('table', t.table_code || t.sys_key); return p; }, { replace: true }); }
    else setParams((p) => { p.delete('table'); return p; }, { replace: true });
  };
  const sugg = useMemo(() => (q.trim() ? findTables(q, 10) : []), [q, tables]);
  const goTo = (t: TableState) => { setQ(t.table_code || t.sys_key); setSugOpen(false); select(t.id, false); mapRef.current?.zoomTo(t.id); };
  const highlightCount = (s: string | null, k: keyof Counts) => {
    const ids = new Set(tables.filter((t) => (s === null || (d === 'MMS' ? t.mms_subcon : t.pv_subcon) === s) && matchCount(t, d, k)).map((t) => t.id));
    setState({ focus: { ids, label: `${s ? subcons.find((x) => x.id === s)?.code : 'All'} — ${COUNT_LABEL[k]} (${d})`, discipline: d } });
    setStatusFocus(null); setSubFocus(null);
  };

  const rail = (
    <aside className={`kp-rail ${railOpen ? 'open' : ''}`} aria-label="Keyplan layers and legend">
      <section>
        <div className="row between"><h4>Colour tables by</h4><button className="iconbtn" style={{ display: railOpen ? 'grid' : 'none' }} aria-label="Close" onClick={() => setRailOpen(false)}>{Icon.close}</button></div>
        <div className="stack tight">
          {MODES.map((m) => <label key={m.key} className="check"><input type="radio" name="mode" checked={mode === m.key} onChange={() => { setMode(m.key); setStatusFocus(null); setSubFocus(null); }} />
            <span>{m.label}<br /><span className="xs faint">{m.src}</span></span></label>)}
        </div>
      </section>
      <section>
        <h4>Layers</h4>
        <label className="layer"><input type="checkbox" checked={showDrone} disabled={!drone} onChange={(e) => setShowDrone(e.target.checked)} />Drone image{drone ? `, ${fmtDate(drone.capture_date)}` : ''}</label>
        <label className="layer"><input type="checkbox" checked={showCad} onChange={(e) => setShowCad(e.target.checked)} />Table outlines (CAD)</label>
        <label className="layer"><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />Table IDs and counts</label>
        {['Piles', 'Inverters', 'MVPS units', 'Cable routes', 'Earthing system'].map((l) => <label key={l} className="layer faint"><input type="checkbox" disabled />{l}<span className="tag">source needed</span></label>)}
        <div className="opacity" style={{ marginTop: 10 }}><span>Status colours</span><input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} aria-label="Status colour opacity" /><b className="num" style={{ width: 38, textAlign: 'right' }}>{Math.round(opacity * 100)}%</b></div>
      </section>
      <section>
        <h4>{mode.endsWith('subcon') ? 'Subcontractors' : mode === 'outline' ? 'Legend' : 'Status legend'}</h4>
        {mode.endsWith('status') && <div className="legend">
          {STATUSES.map((s) => <button key={s.key} className={statusFocus === s.key ? 'on' : statusFocus ? 'off' : ''} title={s.meaning} onClick={() => setStatusFocus(statusFocus === s.key ? null : s.key)}>
            <StatusDot status={s.key} size={14} />{s.label}<span className="n">{(statusCounts[s.key] || 0).toLocaleString()}</span></button>)}
          <p className="xs faint" style={{ marginTop: 6 }}>Colour shows the current status; the details panel has the full history. Installed is never treated as approved.</p>
        </div>}
        {mode.endsWith('subcon') && <div className="legend">
          <button className={!subFocus ? 'on' : ''} onClick={() => setSubFocus(null)}><span className="swatch" style={{ background: 'conic-gradient(#0000FF 0 25%, #00FF00 0 50%, #FFFF00 0 75%, #00FFFF 0)' }} />All Subcontractors</button>
          {subcons.map((s) => <button key={s.id} className={subFocus === s.id ? 'on' : subFocus ? 'off' : ''} onClick={() => setSubFocus(subFocus === s.id ? null : s.id)}>
            <span className="swatch" style={{ background: s.color }} />{s.code}{s.aliases.length ? <span className="xs faint">({s.aliases.join(', ')})</span> : null}<span className="n">{countTables(tables, d, s.id).total.toLocaleString()}</span></button>)}
          <button className={subFocus === 'none' ? 'on' : subFocus ? 'off' : ''} onClick={() => setSubFocus(subFocus === 'none' ? null : 'none')}><span className="swatch" style={{ background: 'transparent', border: '1px solid var(--rule-strong)' }} />Assignment not specified<span className="n">{unassigned.toLocaleString()}</span></button>
          <p className="xs faint" style={{ marginTop: 6 }}>Colours show assignment only, not progress.</p>
        </div>}
        {mode === 'outline' && <p className="small muted">Every table at its CAD position, with its Table ID from the General Layout.</p>}
      </section>
      <section>
        <h4>Filters</h4>
        <div className="stack tight">
          <label className="field"><span>Block</span><select value={flt.block} onChange={(e) => setFlt({ ...flt, block: e.target.value })}><option value="">All blocks</option>{blocks.map((b) => <option key={b.code} value={b.code}>{b.code}</option>)}</select></label>
          <label className="field"><span>Show only</span><select value={flt.flag} onChange={(e) => setFlt({ ...flt, flag: e.target.value })}><option value="">All tables</option>{FLAGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <div className="grid cols-2" style={{ gap: 8 }}>
            <label className="field"><span>Updated from</span><input type="date" value={flt.from} onChange={(e) => setFlt({ ...flt, from: e.target.value })} /></label>
            <label className="field"><span>to</span><input type="date" value={flt.to} onChange={(e) => setFlt({ ...flt, to: e.target.value })} /></label>
          </div>
          {focus && <button className="btn sm" onClick={clearFocus}>Clear filters</button>}
        </div>
      </section>
    </aside>
  );

  const summary = (
    <div className="td-body">
      <div>
        <h3>{d === 'MMS' ? 'Mounting structure' : 'PV modules'}{isSub ? ' — your tables' : ''}</h3>
        <p className="small muted">Counts update from saved records and overlap; they are not added together. Select a count to highlight its tables.</p>
      </div>
      <div className="figures">
        {(['total', 'installed', 'remaining'] as (keyof Counts)[]).map((k) => <button key={k} className="figure" title={COUNT_RULES[k]} onClick={() => highlightCount(null, k)}><div className="v">{counts[k].toLocaleString()}</div><div className="k">{k === 'total' ? (isSub ? 'Your tables' : 'Total tables') : COUNT_LABEL[k]}</div></button>)}
        <div className="figure"><div className="v">{fmtPct(counts.installed, counts.total)}</div><div className="k">Installation complete</div><div className="s">{fmtPct(counts.approved, counts.total)} approved</div></div>
      </div>
      {!isSub && <div className="tablewrap">
        <table className="data">
          <thead><tr><th>Count</th>{perSub.map(({ s }) => <th key={s.id} className="n"><button className="linkbtn" title={`Show ${s.code} tables`} onClick={() => { setMode(d === 'MMS' ? 'mms_subcon' : 'pv_subcon'); setSubFocus(s.id); }}>
            <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}><span className="swatch" style={{ background: s.color, width: 10, height: 10 }} />{s.code}</span></button></th>)}</tr></thead>
          <tbody>
            {SUB_COLS.map((k) => <tr key={k}><td title={COUNT_RULES[k]}>{COUNT_LABEL[k]}</td>
              {perSub.map(({ s, c }) => <td key={s.id} className="n"><button className="linkbtn num" aria-label={`${s.code} ${COUNT_LABEL[k]}: ${c[k]}`} onClick={() => highlightCount(s.id, k)}>{c[k].toLocaleString()}</button></td>)}</tr>)}
          </tbody>
        </table>
      </div>}
      <p className="xs faint">Tip: Shift-drag on the map, or turn on multi-select, to update several tables at once.</p>
    </div>
  );

  return (
    <div className="kp">
      {rail}
      <div className="kp-map">
        <KeyplanMap ref={mapRef} tables={tables} byId={byId} subcons={subcons} drone={drone} dataVersion={dataVersion} mode={mode} showDrone={showDrone && !!drone} showLabels={showLabels} showCad={showCad}
          opacity={opacity} focus={focus} selected={selected} multi={multi} isSubconUser={isSub} onSelect={select} dark={dark}
          onBoxSelect={(ids) => setMulti((m) => new Set([...m, ...ids]))} scaleTarget={scaleEl} />
        <div className="kp-search">
          <button className="iconbtn kp-layers-btn" aria-label="Layers and legend" onClick={() => setRailOpen(true)} style={{ boxShadow: 'var(--shadow-float)', flex: 'none', width: 42, height: 42 }}>{Icon.layers}</button>
          <div className="searchbox">
            {Icon.search}
            <input type="search" placeholder="Search Table ID, e.g. M04-11-07" value={q} aria-label="Search by Table ID" autoComplete="off"
              onChange={(e) => { setQ(e.target.value); setSugOpen(true); setHi(0); }} onFocus={() => setSugOpen(true)} onBlur={() => setTimeout(() => setSugOpen(false), 150)}
              onKeyDown={(e) => { if (e.key === 'ArrowDown') { setHi((h) => Math.min(h + 1, sugg.length - 1)); e.preventDefault(); } if (e.key === 'ArrowUp') { setHi((h) => Math.max(h - 1, 0)); e.preventDefault(); } if (e.key === 'Enter' && sugg[hi]) goTo(sugg[hi]); }} />
            {sugOpen && q.trim() && <div className="suggest" role="listbox">
              {sugg.length ? sugg.map((t, i) => <button key={t.id} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''} onMouseDown={() => goTo(t)}>
                <b className="mono">{label(t)}</b><span className="xs faint">Block {t.block_code}</span><span className="grow" /><StatusDot status={statusOf(t, d)} /></button>)
                : <div className="small muted" style={{ padding: 12 }}>No table matches “{q}”.</div>}
            </div>}
          </div>
        </div>
        {focus && <div className="focusbar" role="status"><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{focus.size.toLocaleString()} tables · {focusLabel}</span>
          <button className="btn sm" onClick={() => mapRef.current?.fitIds(focus)}>Zoom</button><button className="btn sm quiet" onClick={clearFocus}>Clear</button></div>}
        <div className="mapbtns">
          <button className="iconbtn" aria-label="Zoom in" onClick={() => mapRef.current?.zoomBy(1)}>{Icon.plus}</button>
          <button className="iconbtn" aria-label="Zoom out" onClick={() => mapRef.current?.zoomBy(-1)}>{Icon.minus}</button>
          <button className="iconbtn" aria-label="Show whole site" onClick={() => mapRef.current?.fitAll()}>{Icon.fit}</button>
          {(can(role, 'progress.update') || can(role, 'assign') || can(role, 'plan.dates') || can(role, 'approval.record') || can(role, 'inspection.request')) &&
            <button className="iconbtn" aria-pressed={multiMode} aria-label="Select several tables" title="Select several tables" onClick={() => setMultiMode(!multiMode)} style={multiMode ? { background: 'var(--ink)', color: 'var(--sheet)' } : undefined}>{Icon.check}</button>}
          <button className="iconbtn tb-btn" aria-label="Drawing information" onClick={() => setTbOpen(!tbOpen)}>{Icon.info}</button>
        </div>
        <div className={`titleblock ${tbOpen ? 'show' : ''} ${tbMin ? 'min' : ''}`} onClick={() => setTbMin(!tbMin)} title={tbMin ? 'Show drawing information' : 'Hide drawing information'} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setTbMin(!tbMin); }}>
          <div className="wide"><span className="cap">Project</span><span className="val">Expansion PV Farm — Digital keyplan</span></div>
          <div><span className="cap">Showing</span><span className="val">{MODES.find((m) => m.key === mode)?.label}</span></div>
          <div><span className="cap">Source drawing</span><span className="val">{MODES.find((m) => m.key === mode)?.src}</span></div>
          <div><span className="cap">Geometry / IDs</span><span className="val">MMS APPROVED 2.0 / General Layout</span></div>
          <div><span className="cap">Drone image</span><span className="val">{drone ? `${fmtDate(drone.capture_date)}, ${drone.meta.fit.gsd_m.toFixed(2)} m/px` : 'not loaded'}</span></div>
          <div className="last"><span className="cap">Units</span><span className="val">Drawing metres</span></div>
          <div className="last"><span className="cap">Scale</span><div className="scale-host" ref={setScaleEl} /></div>
        </div>
      </div>
      <aside className={`kp-panel ${selected || multi.size ? '' : 'empty-panel'} ${panelExpanded ? 'expanded' : ''}`} aria-label="Table details">
        {multi.size > 0 ? <BulkPanel ids={[...multi]} disc={d} onClear={() => { setMulti(new Set()); setMultiMode(false); }} onRemove={(id) => setMulti((m) => { const n = new Set(m); n.delete(id); return n; })} />
          : selected ? <TablePanel id={selected} onClose={() => select(null, false)} onZoom={() => mapRef.current?.zoomTo(selected)} onExpand={() => setPanelExpanded(!panelExpanded)} />
            : summary}
      </aside>
      {railOpen && <div className="backdrop" style={{ background: 'rgba(10,18,28,.25)', zIndex: 29 }} onClick={() => setRailOpen(false)} />}
    </div>
  );
}

const FLAGS: [string, string][] = [['punch', 'Open rectification items'], ['pending', 'Reports waiting for verification'], ['exception', 'Dependency exceptions'],
  ['drone', 'Drone shows modules, record says PV not complete'], ['id_issue', 'Table ID issues from the import']];
const SUB_COLS: (keyof Counts)[] = ['total', 'installed', 'rectification', 'inspected', 'approved', 'forInspection'];
// per brief 3.2 / 3.4: assigned, installed, requiring rectification, inspected, approved, for inspection
const COUNT_LABEL: Record<keyof Counts, string> = { total: 'Total assigned', installed: 'Installed', remaining: 'Remaining', inspected: 'Inspected', forInspection: 'For inspection', rectification: 'Requiring rectification', approved: 'Approved', onHold: 'On hold', ongoing: 'Ongoing', notStarted: 'Not started', forApproval: 'For approval' };
const COUNT_SHORT: Record<keyof Counts, string> = { ...COUNT_LABEL, total: 'Assigned', rectification: 'Rectify', forInspection: 'For insp.' };

function BulkPanel({ ids, disc, onClear, onRemove }: { ids: string[]; disc: Discipline; onClear: () => void; onRemove: (id: string) => void }) {
  const byId = useStore((s) => s.byId); const role = useStore((s) => s.profile?.role) ?? null; const subcons = useStore((s) => s.subcons);
  const [modal, setModal] = useState<null | 'status' | 'assign' | 'dates' | 'approve'>(null);
  const [work, setWork] = useState<WorkStatus>('completed'); const [hold, setHold] = useState(''); const [busy, setBusy] = useState(false);
  const rows = ids.map((i) => byId.get(i)).filter(Boolean) as TableState[];
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast(ok); await refreshTables(ids); setModal(null); } catch (e) { toast(errText(e), 'error'); } setBusy(false); };
  const forApproval = rows.filter((t) => (disc === 'MMS' ? t.mms_qa : t.pv_qa) === 'for_approval').map((t) => t.id);
  const completedNone = rows.filter((t) => (disc === 'MMS' ? t.mms_work : t.pv_work) === 'completed' && (disc === 'MMS' ? t.mms_qa : t.pv_qa) === 'none').map((t) => t.id);
  return (
    <div className="td-body">
      <div className="row between"><h3>{ids.length} tables selected</h3><button className="btn sm quiet" onClick={onClear}>Clear selection</button></div>
      <p className="small muted">Actions apply to the {disc === 'MMS' ? 'mounting structure' : 'PV modules'} of every selected table. Switch the colour mode to work on the other discipline.</p>
      <div className="stack tight">
        {can(role, 'progress.update') && <button className="btn" onClick={() => setModal('status')}>Update installation status</button>}
        {can(role, 'inspection.request') && <button className="btn" disabled={!completedNone.length || busy} onClick={() => run(() => rpc('request_inspection', { p_tables: completedNone, p_discipline: disc }), `Inspection requested for ${completedNone.length} tables`)}>Request inspection ({completedNone.length} complete, not yet requested)</button>}
        {can(role, 'approval.record') && <button className="btn" disabled={!forApproval.length} onClick={() => setModal('approve')}>Record approval ({forApproval.length} for approval)</button>}
        {can(role, 'assign') && <button className="btn" onClick={() => setModal('assign')}>Change subcontractor</button>}
        {can(role, 'plan.dates') && <button className="btn" onClick={() => setModal('dates')}>Set target dates</button>}
      </div>
      <div className="tablewrap" style={{ maxHeight: 320 }}>
        <table className="data"><thead><tr><th>Table</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((t) => <tr key={t.id}><td className="mono">{label(t)}</td><td><span className="row" style={{ gap: 6 }}><StatusDot status={statusOf(t, disc)} />{(() => { const s = statusOf(t, disc); return s ? STATUSES.find((x) => x.key === s)!.label : '—'; })()}</span></td>
            <td className="n"><button className="btn sm quiet" aria-label={`Remove ${label(t)}`} onClick={() => onRemove(t.id)}>{Icon.close}</button></td></tr>)}</tbody></table>
      </div>
      {modal === 'status' && <Modal title={`Installation status — ${ids.length} tables`} onClose={() => setModal(null)}
        footer={<><button className="btn quiet" onClick={() => setModal(null)}>Cancel</button><button className="btn primary" disabled={busy || (work === 'on_hold' && !hold.trim())} onClick={() => run(() => rpc('update_progress', { p_tables: ids, p_discipline: disc, p_work: work, p_hold_reason: work === 'on_hold' ? hold : null }), `Saved ${ids.length} tables`)}>Save progress</button></>}>
        <div className="stack">
          <div className="statusbtns">{(['not_started', 'ongoing', 'on_hold', 'completed'] as WorkStatus[]).map((w) => <button key={w} type="button" className={`statusbtn ${work === w ? 'on' : ''}`} onClick={() => setWork(w)}><StatusDot status={w as StatusKey} />{WORK_LABEL[w]}</button>)}</div>
          {work === 'on_hold' && <label className="field"><span>Reason for hold</span><input type="text" value={hold} onChange={(e) => setHold(e.target.value)} /></label>}
          {disc === 'PV' && <p className="xs faint">Completed marks all {byId.get(ids[0])?.modules_required ?? 28} modules installed; Not Started clears them. Use the module grid on a single table for partial installation.</p>}
        </div>
      </Modal>}
      {modal === 'assign' && <AssignModal ids={ids} disc={disc} subcons={subcons} onClose={() => setModal(null)} />}
      {modal === 'dates' && <DatesModal ids={ids} disc={disc} onClose={() => setModal(null)} />}
      {modal === 'approve' && <Modal title={`Record client approval — ${forApproval.length} tables`} onClose={() => setModal(null)}
        footer={<><button className="btn quiet" onClick={() => setModal(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => rpc('record_approval', { p_tables: forApproval, p_discipline: disc, p_stage: 'client', p_approver_name: hold || null }), `Approved ${forApproval.length} tables`)}>Record approval</button></>}>
        <label className="field"><span>Approved by</span><input type="text" value={hold} onChange={(e) => setHold(e.target.value)} placeholder="Client representative" /></label>
      </Modal>}
    </div>
  );
}
