import { useMemo, useRef, useState } from 'react';

interface Series { key: string; label: string; color: string; values: number[]; dashed?: boolean }
function niceMax(v: number) {
  if (v <= 0) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; html: React.ReactNode } | null>(null);
  return { tip, show: (e: { clientX: number; clientY: number }, html: React.ReactNode) => setTip({ x: e.clientX + 14, y: e.clientY + 14, html }), hide: () => setTip(null) };
}
function Tip({ tip }: { tip: { x: number; y: number; html: React.ReactNode } | null }) {
  if (!tip) return null;
  const x = Math.min(tip.x, window.innerWidth - 200);
  return <div className="tip" style={{ left: x, top: tip.y }}>{tip.html}</div>;
}
export function Legend({ series }: { series: { label: string; color: string; dashed?: boolean }[] }) {
  return <div className="legend-inline">{series.map((s) => <span key={s.label}><svg width="18" height="10" aria-hidden="true">{s.dashed
    ? <line x1="1" y1="5" x2="17" y2="5" stroke={s.color} strokeWidth="2" strokeDasharray="4 3" /> : <rect x="1" y="1" width="16" height="8" rx="2" fill={s.color} />}</svg>{s.label}</span>)}</div>;
}

/** Grouped vertical bars over categories (days/weeks). */
export function GroupedBars({ categories, series, height = 190, unit = 'tables', ariaLabel }: { categories: string[]; series: Series[]; height?: number; unit?: string; ariaLabel: string }) {
  const { tip, show, hide } = useTip();
  const W = 640, H = height, L = 34, R = 6, T = 10, B = 26;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const band = (W - L - R) / Math.max(1, categories.length);
  const gap = 2; const bw = Math.max(3, Math.min(16, (band * 0.72 - gap * (series.length - 1)) / series.length));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const every = Math.ceil(categories.length / 8);
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseLeave={hide}>
        {ticks.map((t) => <g key={t}><line className="gridline" x1={L} x2={W - R} y1={y(t)} y2={y(t)} /><text x={L - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
        {categories.map((c, i) => {
          const x0 = L + i * band + (band - (bw * series.length + gap * (series.length - 1))) / 2;
          return (
            <g key={c}>
              {series.map((s, j) => {
                const v = s.values[i] || 0; const h = (H - T - B) * (v / max); const x = x0 + j * (bw + gap);
                return v > 0 ? <path key={s.key} d={`M${x},${y(0)} V${y(0) - Math.max(h - 4, 0)} q0,-4 4,-4 h${bw - 8 > 0 ? bw - 8 : 0} q4,0 4,4 V${y(0)} Z`} fill={s.color} /> : null;
              })}
              <rect x={L + i * band} y={T} width={band} height={H - T - B} fill="transparent"
                onMouseMove={(e) => show(e, <div><b>{c}</b>{series.map((s) => <div key={s.key} className="row" style={{ gap: 6 }}><span className="swatch" style={{ background: s.color, width: 10, height: 10 }} />{s.label}: <b className="num">{s.values[i] || 0}</b> {unit}</div>)}</div>)} />
              {i % every === 0 && <text x={L + i * band + band / 2} y={H - 8} textAnchor="middle">{c}</text>}
            </g>
          );
        })}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--rule-strong)" />
      </svg>
      <Legend series={series} />
      <Tip tip={tip} />
    </div>
  );
}

/** Lines over categories with a crosshair tooltip. */
export function Lines({ categories, series, height = 210, unit = 'tables', ariaLabel, max: maxIn }: { categories: string[]; series: Series[]; height?: number; unit?: string; ariaLabel: string; max?: number }) {
  const { tip, show, hide } = useTip();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, L = 44, R = 70, T = 10, B = 26;
  const max = niceMax(maxIn ?? Math.max(1, ...series.flatMap((s) => s.values.filter((v) => Number.isFinite(v)))));
  const n = categories.length; const x = (i: number) => L + (n <= 1 ? 0 : ((W - L - R) * i) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const paths = useMemo(() => series.map((s) => {
    let d = ''; s.values.forEach((v, i) => { if (!Number.isFinite(v)) return; d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; }); return d;
  }), [series, n, max]);
  const every = Math.ceil(n / 7);
  const onMove = (e: React.MouseEvent) => {
    const box = ref.current!.getBoundingClientRect(); const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
    setHover(i);
    show(e, <div><b>{categories[i]}</b>{series.map((s) => <div key={s.key}>{s.label}: <b className="num">{Number.isFinite(s.values[i]) ? s.values[i].toLocaleString() : '—'}</b> {unit}</div>)}</div>);
  };
  return (
    <div>
      <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseMove={onMove} onMouseLeave={() => { hide(); setHover(null); }}>
        {[0, max / 2, max].map((t) => <g key={t}><line className="gridline" x1={L} x2={W - R} y1={y(t)} y2={y(t)} /><text x={L - 6} y={y(t) + 4} textAnchor="end">{t.toLocaleString()}</text></g>)}
        {categories.map((c, i) => i % every === 0 ? <text key={c} x={x(i)} y={H - 8} textAnchor="middle">{c}</text> : null)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--rule-strong)" />}
        {series.map((s, k) => <path key={s.key} d={paths[k]} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" />)}
        {series.map((s) => { // direct label at the line end
          let i = s.values.length - 1; while (i >= 0 && !Number.isFinite(s.values[i])) i--;
          return i >= 0 ? <g key={s.key}><circle cx={x(i)} cy={y(s.values[i])} r={4} fill={s.color} stroke="var(--sheet)" strokeWidth={2} /><text className="lbl" x={x(i) + 8} y={y(s.values[i]) + 4}>{s.values[i].toLocaleString()}</text></g> : null;
        })}
        {hover !== null && series.map((s) => Number.isFinite(s.values[hover]) ? <circle key={s.key} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} stroke="var(--sheet)" strokeWidth={2} /> : null)}
      </svg>
      <Legend series={series} />
      <Tip tip={tip} />
    </div>
  );
}
