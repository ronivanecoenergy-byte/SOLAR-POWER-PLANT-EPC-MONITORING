import { fullMask, popcount } from '../lib/model';

/** 4 x 7 module grid. Module n (1-28) runs row by row from the table's top-left (north-west) corner. */
export function ModuleGrid({ mask, rows = 4, cols = 7, total = 28, editable, onChange }: {
  mask: number; rows?: number; cols?: number; total?: number; editable?: boolean; onChange?: (m: number) => void;
}) {
  const cells = [];
  for (let n = 0; n < rows * cols; n++) {
    const on = !!(mask & (1 << n));
    const exists = n < total;
    cells.push(
      <button key={n} type="button" className={`mod ${on ? 'on' : ''}`} disabled={!editable || !exists} aria-pressed={on}
        aria-label={`Module ${n + 1}, row ${Math.floor(n / cols) + 1}, column ${(n % cols) + 1}: ${on ? 'installed' : 'not installed'}`}
        onClick={() => onChange?.(mask ^ (1 << n))} style={exists ? undefined : { visibility: 'hidden' }}>
        {n + 1}
      </button>,
    );
  }
  return (
    <div className="stack tight">
      <div className="modgrid" role="group" aria-label="PV modules on this table">{cells}</div>
      <div className="row between modgrid-note">
        <span>{popcount(mask)}/{total} installed. Module 1 is the top-left (north-west) corner; numbering runs row by row.</span>
        {editable && <span className="row" style={{ gap: 4 }}>
          <button type="button" className="btn sm quiet" onClick={() => onChange?.(fullMask(total))}>All {total}</button>
          <button type="button" className="btn sm quiet" onClick={() => onChange?.(0)}>Clear</button>
        </span>}
      </div>
    </div>
  );
}
