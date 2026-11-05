import { useEffect, useRef, useState, type ReactNode } from 'react';
import { STATUS, type StatusKey, type Subcon, type Counts, COUNT_RULES } from '../lib/model';
import { useStore } from '../lib/store';

export function BrandMark({ size = 28, light = false }: { size?: number; light?: boolean }) {
  // a PV table: 7 x 4 modules, one highlighted (the selected table idea)
  const cells = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 7; c++) {
    const on = r === 1 && c === 4;
    cells.push(<rect key={`${r}-${c}`} x={1 + c * 4.4} y={4 + r * 4.6} width={3.8} height={4} rx={0.6}
      fill={on ? '#5B9BFF' : light ? '#E6ECF1' : 'currentColor'} opacity={on ? 1 : 0.92} />);
  }
  return <svg width={size} height={size} viewBox="0 0 32 26" aria-hidden="true" style={{ flex: 'none' }}>{cells}</svg>;
}

export const Icon = {
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  layers: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  minus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14" /></svg>,
  fit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>,
  info: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>,
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3 11 12 4l9 7v9h-6v-6H9v6H3z" /></svg>,
  map: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="1" /><path d="M3 10h18M9 5v14M15 5v14" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3 8-8" /><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10" /></svg>,
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>,
  more: <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>,
  camera: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>,
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg>,
};

export function StatusDot({ status, size = 10 }: { status: StatusKey | null; size?: number }) {
  return <span className="dot" style={{ background: status ? STATUS[status].color : 'transparent', width: size, height: size, border: status ? undefined : '1px dashed var(--rule-strong)' }} />;
}
export function StatusPill({ status, children }: { status: StatusKey | null; children?: ReactNode }) {
  return <span className="pill"><StatusDot status={status} />{children ?? (status ? STATUS[status].label : 'Not assigned to you')}</span>;
}
export function SubconChip({ subcon, fallback = 'Assignment not specified' }: { subcon: Subcon | null; fallback?: string }) {
  if (!subcon) return <span className="faint">{fallback}</span>;
  return <span className="row" style={{ gap: 6, display: 'inline-flex' }}><span className="swatch" style={{ background: subcon.color }} /><b>{subcon.code}</b></span>;
}

export function Modal({ title, children, footer, onClose, wide }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" ref={ref} style={wide ? { width: 'min(860px, 100%)' } : undefined}>
        <header className="row between"><h3>{title}</h3><button className="iconbtn" aria-label="Close" onClick={onClose} style={{ border: 0 }}>{Icon.close}</button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: ReactNode }[] }) {
  return <div className="tabs" role="tablist">{items.map((i) => <button key={i.key} role="tab" aria-selected={value === i.key} className={value === i.key ? 'on' : ''} onClick={() => onChange(i.key)}>{i.label}</button>)}</div>;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children && <div className="small">{children}</div>}</div>;
}
export function Spinner({ label }: { label?: string }) {
  return <div className="loading"><div className="stack" style={{ alignItems: 'center' }}><div className="spinner" />{label && <span className="small">{label}</span>}</div></div>;
}

export type FigureItem = { key: string; value: ReactNode; label: string; sub?: ReactNode; title?: string; onClick?: () => void };
export function Figures({ items }: { items: FigureItem[] }) {
  return (
    <div className="figures">
      {items.map((f) => f.onClick
        ? <button key={f.key} className="figure" onClick={f.onClick} title={f.title}><div className="v">{f.value}</div><div className="k">{f.label}</div>{f.sub && <div className="s">{f.sub}</div>}</button>
        : <div key={f.key} className="figure" title={f.title}><div className="v">{f.value}</div><div className="k">{f.label}</div>{f.sub && <div className="s">{f.sub}</div>}</div>)}
    </div>
  );
}
export const ruleOf = (k: keyof Counts) => COUNT_RULES[k];

export function Meter({ a, b, total, color }: { a: number; b?: number; total: number; color: string }) {
  const pa = total ? (100 * a) / total : 0; const pb = total && b !== undefined ? (100 * b) / total : 0;
  return <div className="meter" role="img" aria-label={`${Math.round(pa)}%`}>{b !== undefined && <i className="b" style={{ width: `${pb}%`, background: color }} />}<i style={{ width: `${pa}%`, background: color }} /></div>;
}

export function useDebounced<T>(value: T, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export const fmtDate = (s?: string | null) => (s ? new Date(s.length <= 10 ? s + 'T00:00:00' : s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const today = () => new Date().toISOString().slice(0, 10);
