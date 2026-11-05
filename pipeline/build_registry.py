#!/usr/bin/env python3
"""Build the PV table registry from the parsed project drawings.

Inputs  (data/parsed/*.json, produced by pipeline/parse_dwg.mjs from the DWGs):
  EXPANSION_PV_FARM_GENERAL_LAYOUT  Table IDs (TEXT labels centred in each table)
  MMS_APPROVED_2.0                  baseline geometry + MMS approved (green fills)
  MMS_APPROVED                      previous MMS revision (comparison only)
  APPROVED_PV                       PV approved (green fills)
  MS_APPROVED_PER_SUBCON            MMS subcontractor assignment (fill colour)
  PV_ACCOMP_1_PER_SUBCON            PV subcontractor assignment (right-hand keyplan)

Outputs (data/build/):
  registry.json        one record per unique table on the baseline
  import_report.json   counts + every anomaly found (nothing is silently fixed)

Rules applied (agreed with the project owner):
  * Geometry comes from MMS_APPROVED_2.0. Exact duplicate outlines are collapsed.
  * Green fills in MMS_APPROVED_2.0 / APPROVED_PV = installed AND QA/QC approved.
  * Fill colours in the *per subcon* drawings = subcontractor assignment only.
  * JJ, JJC and JJCES are one company (JJC); AAPSI and AAPCI are one company (AAPCI).
  * Red "For checking" in the PV per-subcon drawing is a review flag, not a company.
  * Records from different drawings are joined through the Table ID.
"""
import json, re, sys, collections, math, os
import numpy as np
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARSED = os.path.join(ROOT, 'data', 'parsed')
OUT = os.path.join(ROOT, 'data', 'build')
os.makedirs(OUT, exist_ok=True)

TW, TH = 16.808, 5.272
LAYER_BLOCK = {'PV Panels-1': 'M01', 'PV Panels-2': 'M02', 'pv panels-3': 'M03', 'pv panels-4': 'M04'}
MMS_SUBCON_ACI = {5: 'TECHNO', 3: 'JJ', 2: 'SAL', 4: 'RMS', 6: 'AAPSI'}
PV_SUBCON_ACI = {5: 'TECHNO', 3: 'JJC', 2: 'SAL', 4: 'RMS', 6: 'AAPCI', 1: 'FOR_CHECKING'}
CANON = {'TECHNO': 'TECHNO', 'JJ': 'JJC', 'JJC': 'JJC', 'JJCES': 'JJC', 'SAL': 'SAL', 'RMS': 'RMS', 'AAPSI': 'AAPCI', 'AAPCI': 'AAPCI'}
ID_STD = re.compile(r'^M(\d{2})-(\d{2})-(0[1-9]|0\d{2}|[1-9]\d{2})$')
ID_ANY = re.compile(r'^M(\d{2})-(\d{2})-(\d{1,3})$')


def load(name):
    with open(os.path.join(PARSED, name + '.json')) as f:
        return json.load(f)['entities']


def rects_of(ents, xfilter=None):
    out = []
    for e in ents:
        if e['type'] != 'LWPOLYLINE':
            continue
        xs = [v['x'] for v in e['vertices']]; ys = [v['y'] for v in e['vertices']]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if abs(h - TH) < 0.03 and abs(w - TW) < 0.05:
            r = dict(x0=min(xs), y0=min(ys), x1=max(xs), y1=max(ys), layer=e['layer'], handle=e['handle'])
            if xfilter is None or xfilter(r['x0']):
                out.append(r)
    return out


def fills_of(ents, xfilter=None):
    out = []
    for order, e in enumerate(ents):
        if e['type'] != 'HATCH':
            continue
        for p in e.get('boundaryPaths', []):
            vs = p.get('vertices')
            if not vs:
                continue
            xs = [v['x'] for v in vs]; ys = [v['y'] for v in vs]
            r = dict(x0=min(xs), y0=min(ys), x1=max(xs), y1=max(ys), aci=e['colorIndex'], layer=e['layer'], order=order, handle=e['handle'])
            if xfilter is None or xfilter(r['x0']):
                out.append(r)
    return out


def texts_of(ents):
    out = []
    for e in ents:
        if e['type'] == 'TEXT':
            ap = e.get('endPoint') if (e.get('halign') or e.get('valign')) else e.get('startPoint')
            out.append(dict(text=(e.get('text') or '').strip(), x=ap['x'], y=ap['y'], layer=e['layer'], handle=e['handle']))
    return out


def dedupe(rects):
    """Collapse outlines drawn on top of each other. Returns unique rects with dup counts."""
    groups = collections.OrderedDict()
    for r in rects:
        k = (round(r['x0'], 2), round(r['y0'], 2))
        if k in groups:
            groups[k]['dups'] += 1
            groups[k]['handles'].append(r['handle'])
            if r['layer'] != groups[k]['layer']:
                groups[k].setdefault('other_layers', []).append(r['layer'])
        else:
            groups[k] = dict(r, dups=1, handles=[r['handle']])
    return list(groups.values())


def find_offset(src, dst_tree, dst_pts):
    """Translation that maps src lower-left corners onto dst (robust mode of pairwise shifts)."""
    P = np.array([[r['x0'], r['y0']] for r in src])
    cnt = collections.Counter()
    step = max(1, len(P) // 120)
    for i in range(0, len(P), step):
        for d in np.round(dst_pts - P[i], 2):
            cnt[(d[0], d[1])] += 1
    (dx, dy), _ = cnt.most_common(1)[0]
    dd, ii = dst_tree.query(P + [dx, dy])
    ok = dd < 0.2
    off = np.median(dst_pts[ii[ok]] - P[ok], axis=0)
    return off


def centre(r):
    return ((r['x0'] + r['x1']) / 2, (r['y0'] + r['y1']) / 2)


report = collections.OrderedDict()
issues = []  # (severity, code, message, table_key or None, extra)


def issue(sev, code, msg, key=None, **extra):
    issues.append(dict(severity=sev, code=code, message=msg, table=key, **extra))


# ---------------------------------------------------------------- baseline
base_ents = load('MMS_APPROVED_2.0')
base_raw = rects_of(base_ents)
base = dedupe(base_raw)
# near-overlaps (outlines within 1 m that are not exact duplicates)
BC = np.array([centre(r) for r in base])
near = cKDTree(BC).query_pairs(1.0)
for a, b in sorted(near):
    issue('warning', 'NEAR_DUPLICATE_OUTLINE', 'Two table outlines overlap but are not identical (%.2f m apart).' % math.dist(BC[a], BC[b]), None, a=a, b=b)
base.sort(key=lambda r: (LAYER_BLOCK.get(r['layer'], 'Z'), -round(r['y0'], 1), r['x0']))
for i, r in enumerate(base):
    r['idx'] = i
BP = np.array([[r['x0'], r['y0']] for r in base]); btree = cKDTree(BP)
BCT = cKDTree(np.array([centre(r) for r in base]))
report['baseline'] = dict(drawing='MMS_APPROVED_2.0.dwg', outlines=len(base_raw), unique_tables=len(base),
                          duplicate_outlines=len(base_raw) - len(base),
                          per_block=dict(collections.Counter(LAYER_BLOCK.get(r['layer'], r['layer']) for r in base)))


def table_at_point(x, y, tol=0.3):
    d, i = BCT.query([x, y])
    r = base[i]
    if r['x0'] - tol <= x <= r['x1'] + tol and r['y0'] - tol <= y <= r['y1'] + tol:
        return i
    return None


# ---------------------------------------------------------------- general layout + IDs
gl_ents = load('EXPANSION_PV_FARM_GENERAL_LAYOUT')
gl_raw = rects_of(gl_ents)
gl = dedupe(gl_raw)
gl_off = find_offset(gl, btree, BP)
GLP = np.array([[r['x0'], r['y0']] for r in gl]); gltree = cKDTree(GLP)
GLC = cKDTree(np.array([centre(r) for r in gl]))
texts = texts_of(gl_ents)
id_labels, other_text = [], []
for t in texts:
    (id_labels if ID_ANY.match(t['text']) else other_text).append(t)
for t in other_text:
    issue('warning', 'NON_ID_TEXT', 'Text in the General Layout that is not a Table ID: "%s"' % t['text'], None, text=t['text'])

# labels -> GL tables
gl_label = collections.defaultdict(list); gl_orphans = []
for t in id_labels:
    d, j = GLC.query([t['x'], t['y']])
    r = gl[j]
    if r['x0'] - 0.3 <= t['x'] <= r['x1'] + 0.3 and r['y0'] - 0.3 <= t['y'] <= r['y1'] + 0.3:
        gl_label[j].append(t)
    else:
        gl_orphans.append(t)
# GL tables -> baseline tables
dd, ii = btree.query(GLP + gl_off)
gl_to_base = {j: int(ii[j]) for j in range(len(gl)) if dd[j] < 0.1}
base_from_gl = {v: k for k, v in gl_to_base.items()}

ids_by_base = collections.defaultdict(list)
for j, labs in gl_label.items():
    if j in gl_to_base:
        for t in labs:
            ids_by_base[gl_to_base[j]].append((t['text'], 'general_layout_table'))
    else:
        for t in labs:
            gl_orphans.append(t)  # its GL table does not exist on the baseline -> try by position
moved_labels = []
for t in gl_orphans:
    x, y = t['x'] + gl_off[0], t['y'] + gl_off[1]
    k = table_at_point(x, y)
    if k is not None and k not in base_from_gl:
        ids_by_base[k].append((t['text'], 'general_layout_label_position'))
    else:
        moved_labels.append(t)

report['general_layout'] = dict(drawing='EXPANSION PV FARM - GEENRAL LAYOUT.dwg', outlines=len(gl_raw), unique_tables=len(gl),
                                duplicate_outlines=len(gl_raw) - len(gl), id_labels=len(id_labels), other_text=len(other_text),
                                offset_to_baseline_m=[round(float(v), 4) for v in gl_off],
                                tables_matching_baseline=len(gl_to_base), tables_not_on_baseline=len(gl) - len(gl_to_base))
for j in range(len(gl)):
    if j not in gl_to_base:
        labs = [t['text'] for t in gl_label.get(j, [])]
        issue('warning', 'GL_TABLE_NOT_ON_BASELINE', 'General Layout table %s is not at the same position on MMS_APPROVED_2.0 (moved or removed in revision 2.0).' % (labs[0] if labs else '(unlabelled)'),
              None, label=labs[0] if labs else None, gl_xy=[round(gl[j]['x0'] + gl_off[0], 3), round(gl[j]['y0'] + gl_off[1], 3)])
for t in moved_labels:
    x, y = t['x'] + gl_off[0], t['y'] + gl_off[1]
    d, k = BCT.query([x, y])
    issue('error', 'ID_WITHOUT_TABLE', 'Table ID %s has no table outline at its position on the baseline (nearest table %.1f m away).' % (t['text'], d), None, label=t['text'], nearest_m=round(float(d), 1))

# ---------------------------------------------------------------- per-table ID resolution
id_count = collections.Counter()
for k, lst in ids_by_base.items():
    for (s, _) in lst:
        id_count[s] += 1
records = []
for r in base:
    k = r['idx']
    cx, cy = centre(r)
    rec = collections.OrderedDict()
    rec['key'] = 'T%04d' % (k + 1)
    rec['block'] = LAYER_BLOCK.get(r['layer'])
    rec['layer'] = r['layer']
    rec['x0'], rec['y0'], rec['x1'], rec['y1'] = [round(v, 4) for v in (r['x0'], r['y0'], r['x1'], r['y1'])]
    rec['cad_outlines'] = r['dups']
    rec['table_code'] = None
    rec['id_source'] = None
    rec['id_flags'] = []
    lst = ids_by_base.get(k, [])
    if len(lst) == 1:
        rec['table_code'], rec['id_source'] = lst[0]
        if rec['id_source'] == 'general_layout_label_position':
            rec['id_flags'].append('ID_BY_LABEL_POSITION')
    elif len(lst) > 1:
        rec['id_flags'].append('MULTIPLE_LABELS')
        issue('error', 'MULTIPLE_IDS', 'Table %s carries more than one ID label: %s' % (rec['key'], ', '.join(s for s, _ in lst)), rec['key'])
        rec['table_code'], rec['id_source'] = lst[0]
    else:
        rec['id_flags'].append('NO_ID')
    code = rec['table_code']
    if code:
        if id_count[code] > 1:
            rec['id_flags'].append('DUPLICATE_ID')
        if not ID_STD.match(code):
            rec['id_flags'].append('NONSTANDARD_FORMAT')
        m = ID_ANY.match(code)
        rec['id_block'], rec['id_col'], rec['id_row'] = 'M' + m.group(1), m.group(2), m.group(3)
        if rec['id_block'] != rec['block']:
            rec['id_flags'].append('BLOCK_MISMATCH')
    else:
        rec['id_block'] = rec['id_col'] = rec['id_row'] = None
    records.append(rec)

for code, n in id_count.items():
    if n > 1:
        keys = [rec['key'] for rec in records if rec['table_code'] == code]
        issue('error', 'DUPLICATE_ID', 'Table ID %s is used by %d different tables (%s).' % (code, n, ', '.join(keys)), None, label=code, tables=keys)
for rec in records:
    if 'NONSTANDARD_FORMAT' in rec['id_flags']:
        issue('warning', 'NONSTANDARD_ID', 'Table ID %s does not follow the drawing\'s usual row format (01-09, 010-099, 100+).' % rec['table_code'], rec['key'], label=rec['table_code'])
    if 'ID_BY_LABEL_POSITION' in rec['id_flags'] and 'DUPLICATE_ID' not in rec['id_flags']:
        issue('info', 'ID_BY_LABEL_POSITION', 'Table ID %s was matched by its label position because the table outline moved between the General Layout and MMS_APPROVED_2.0.' % rec['table_code'], rec['key'], label=rec['table_code'])
    if 'BLOCK_MISMATCH' in rec['id_flags']:
        issue('error', 'BLOCK_MISMATCH', 'Table ID %s is on CAD layer %s (block %s).' % (rec['table_code'], rec['layer'], rec['block']), rec['key'])
missing_id = [rec for rec in records if 'NO_ID' in rec['id_flags']]
for rec in missing_id:
    issue('error', 'MISSING_ID', 'Baseline table %s has no Table ID in the General Layout.' % rec['key'], rec['key'], block=rec['block'], xy=[rec['x0'], rec['y0']])

# geometric consistency of the ID grid: within a block, larger row number -> further south; larger column -> further east
by_block_col = collections.defaultdict(list); by_block_row = collections.defaultdict(list)
for rec in records:
    if rec['table_code'] and ID_ANY.match(rec['table_code']):
        by_block_col[(rec['id_block'], rec['id_col'])].append(rec)
        by_block_row[(rec['id_block'], rec['id_row'])].append(rec)
order_violations = 0
for (blk, col), lst in by_block_col.items():
    lst.sort(key=lambda r: int(r['id_row']))
    for a, b in zip(lst, lst[1:]):
        if not (b['y0'] < a['y0'] - 0.5):
            order_violations += 1
            issue('warning', 'ROW_ORDER', '%s and %s: row numbers do not increase southward.' % (a['table_code'], b['table_code']), b['key'])
for (blk, row), lst in by_block_row.items():
    lst.sort(key=lambda r: int(r['id_col']))
    for a, b in zip(lst, lst[1:]):
        if not (b['x0'] > a['x0'] + 0.5):
            order_violations += 1
            issue('warning', 'COLUMN_ORDER', '%s and %s: column numbers do not increase eastward.' % (a['table_code'], b['table_code']), b['key'])

# ---------------------------------------------------------------- status / assignment sources


def map_source(name, ents, xfilter=None):
    """Map a drawing's tables onto the baseline: by position, else through its General Layout ID."""
    raw = rects_of(ents, xfilter)
    uniq = dedupe(raw)
    off_b = find_offset(uniq, btree, BP)
    off_g = find_offset(uniq, gltree, GLP)
    P = np.array([[r['x0'], r['y0']] for r in uniq])
    db, ib = btree.query(P + off_b)
    dg, ig = gltree.query(P + off_g)
    code_to_base = {rec['table_code']: i for i, rec in enumerate(records) if rec['table_code'] and 'DUPLICATE_ID' not in rec['id_flags']}
    mapping = {}
    via_id = unresolved = 0
    for j in range(len(uniq)):
        if db[j] < 0.1:
            mapping[j] = int(ib[j])
        elif dg[j] < 0.1:
            labs = gl_label.get(int(ig[j]), [])
            if len(labs) == 1 and labs[0]['text'] in code_to_base:
                mapping[j] = code_to_base[labs[0]['text']]; via_id += 1
            else:
                unresolved += 1
                issue('warning', 'UNMAPPED_SOURCE_TABLE', '%s: table at (%.2f, %.2f) has no counterpart on the baseline.' % (name, uniq[j]['x0'], uniq[j]['y0']), None, drawing=name)
        else:
            unresolved += 1
            issue('warning', 'UNMAPPED_SOURCE_TABLE', '%s: table at (%.2f, %.2f) matches neither the baseline nor the General Layout.' % (name, uniq[j]['x0'], uniq[j]['y0']), None, drawing=name)
    UC = cKDTree(np.array([centre(r) for r in uniq]))
    return dict(raw=raw, uniq=uniq, off_b=off_b, mapping=mapping, via_id=via_id, unresolved=unresolved, UC=UC)


def fills_to_tables(name, src, fills, aci_filter=None):
    """Return {baseline_idx: [fill,...]} using fill centre containment in the source drawing's own tables."""
    out = collections.defaultdict(list); stray = []
    for f in fills:
        if aci_filter and f['aci'] not in aci_filter:
            continue
        cx, cy = (f['x0'] + f['x1']) / 2, (f['y0'] + f['y1']) / 2
        if (f['x1'] - f['x0']) > 40:  # legend swatches
            continue
        d, j = src['UC'].query([cx, cy])
        r = src['uniq'][j]
        if r['x0'] - 0.2 <= cx <= r['x1'] + 0.2 and r['y0'] - 0.2 <= cy <= r['y1'] + 0.2:
            area = (f['x1'] - f['x0']) * (f['y1'] - f['y0'])
            f = dict(f, partial=area < 0.9 * TW * TH)
            if j in src['mapping']:
                out[src['mapping'][j]].append(f)
            else:
                stray.append(f)
        else:
            stray.append(f)
    return out, stray


def summarise_stray(name, stray, label):
    if stray:
        c = collections.Counter(f['aci'] for f in stray)
        issue('warning', 'FILL_WITHOUT_TABLE', '%s: %d %s fill(s) do not sit on a baseline table outline (colours %s).' % (name, len(stray), label, dict(c)), None, drawing=name, count=len(stray))


# MMS approved (baseline drawing itself)
src_mms2 = map_source('MMS_APPROVED_2.0', base_ents)
mms_fill, stray = fills_to_tables('MMS_APPROVED_2.0', src_mms2, fills_of(base_ents), {3})
summarise_stray('MMS_APPROVED_2.0.dwg', stray, 'green')
# previous revision for comparison
mms1_ents = load('MMS_APPROVED')
src_mms1 = map_source('MMS_APPROVED', mms1_ents)
mms1_fill, _ = fills_to_tables('MMS_APPROVED', src_mms1, fills_of(mms1_ents), {3})
# PV approved
pv_ents = load('APPROVED_PV')
src_pv = map_source('APPROVED_PV', pv_ents)
pv_fill, stray = fills_to_tables('APPROVED_PV', src_pv, fills_of(pv_ents), {3})
summarise_stray('APPROVED_PV.dwg', stray, 'green')
# MMS per subcon
ms_ents = load('MS_APPROVED_PER_SUBCON')
src_ms = map_source('MS_APPROVED_PER_SUBCON', ms_ents)
ms_fill, stray = fills_to_tables('MS_APPROVED_PER_SUBCON', src_ms, fills_of(ms_ents), set(MMS_SUBCON_ACI))
summarise_stray('MS_APPROVED_PER_SUBCON.dwg', stray, 'subcontractor')
# PV per subcon (right-hand keyplan = the one in the brief)
acc_ents = load('PV_ACCOMP_1_PER_SUBCON')
right = lambda x: x > 4200
src_acc = map_source('PV_ACCOMP_1 (right)', acc_ents, right)
acc_all, stray = fills_to_tables('PV_ACCOMP_1 (right)', src_acc, fills_of(acc_ents, right))
summarise_stray('PV_ACCOMP_1._PER_SUBCON.dwg (right keyplan)', [f for f in stray if f['aci'] in PV_SUBCON_ACI], 'subcontractor')
acc_mtext = [e['text'] for e in acc_ents if e['type'] == 'MTEXT' and e['insertionPoint']['x'] > 5700]

for name, src in [('MMS_APPROVED_2.0', src_mms2), ('MMS_APPROVED', src_mms1), ('APPROVED_PV', src_pv), ('MS_APPROVED_PER_SUBCON', src_ms), ('PV_ACCOMP_1 (right)', src_acc)]:
    report.setdefault('sources', collections.OrderedDict())[name] = dict(outlines=len(src['raw']), unique_tables=len(src['uniq']),
                                                                         duplicate_outlines=len(src['raw']) - len(src['uniq']),
                                                                         mapped_by_position=len(src['mapping']) - src['via_id'], mapped_via_table_id=src['via_id'],
                                                                         unmapped=src['unresolved'], offset_to_baseline_m=[round(float(v), 4) for v in src['off_b']])

# ---------------------------------------------------------------- per-table attributes


def topmost(fl):
    return max(fl, key=lambda f: f['order']) if fl else None


subcon_conflicts = 0
for i, rec in enumerate(records):
    rec['mms_approved'] = i in mms_fill
    rec['mms_approved_prev_rev'] = i in mms1_fill
    rec['pv_approved'] = i in pv_fill
    if i in pv_fill and len(pv_fill[i]) > 1:
        rec['id_flags'] = rec['id_flags']  # duplicate green fill is harmless; counted in report
    # MMS subcontractor
    f = ms_fill.get(i, [])
    cols = {MMS_SUBCON_ACI[x['aci']] for x in f}
    rec['mms_subcon_label'] = None; rec['mms_subcon'] = None
    if len(cols) > 1:
        issue('error', 'MMS_ASSIGNMENT_CONFLICT', '%s has fills for several MMS subcontractors: %s' % (rec['table_code'] or rec['key'], sorted(cols)), rec['key'])
    if f:
        lab = MMS_SUBCON_ACI[topmost(f)['aci']]
        rec['mms_subcon_label'] = lab; rec['mms_subcon'] = CANON[lab]
    # PV subcontractor (only legend colours; ACI 112 base fill is reported separately)
    fa = acc_all.get(i, [])
    leg = [x for x in fa if x['aci'] in PV_SUBCON_ACI]
    rec['pv_subcon_label'] = None; rec['pv_subcon'] = None; rec['pv_for_checking'] = False
    rec['pv_base_fill_112'] = any(x['aci'] == 112 for x in fa)
    if leg:
        names = {PV_SUBCON_ACI[x['aci']] for x in leg}
        top = PV_SUBCON_ACI[topmost(leg)['aci']]
        comp = names - {'FOR_CHECKING'}
        if len(comp) > 1:
            subcon_conflicts += 1
            issue('error', 'PV_ASSIGNMENT_CONFLICT', '%s has fills for several PV subcontractors: %s (top-most %s used)' % (rec['table_code'] or rec['key'], sorted(comp), top), rec['key'])
        if 'FOR_CHECKING' in names:
            rec['pv_for_checking'] = True
        if top != 'FOR_CHECKING':
            rec['pv_subcon_label'] = top; rec['pv_subcon'] = CANON[top]
        elif comp:
            lab = sorted(comp)[0]; rec['pv_subcon_label'] = lab; rec['pv_subcon'] = CANON[lab]
    # dependency check: PV approved but MMS not approved on the baseline
    rec['dependency_exception'] = rec['pv_approved'] and not rec['mms_approved']
    if rec['dependency_exception']:
        issue('warning', 'PV_BEFORE_MMS', '%s is PV-approved but its mounting structure is not approved in MMS_APPROVED_2.0.' % (rec['table_code'] or rec['key']), rec['key'])

# ---------------------------------------------------------------- summary counts
def cnt(pred):
    return sum(1 for r in records if pred(r))

report['tables'] = dict(total=len(records), with_table_id=cnt(lambda r: r['table_code']), without_table_id=len(missing_id),
                        duplicate_id_tables=cnt(lambda r: 'DUPLICATE_ID' in r['id_flags']),
                        nonstandard_id=cnt(lambda r: 'NONSTANDARD_FORMAT' in r['id_flags']),
                        id_grid_order_warnings=order_violations)
report['mms'] = dict(approved=cnt(lambda r: r['mms_approved']), approved_previous_revision=cnt(lambda r: r['mms_approved_prev_rev']),
                     newly_approved_in_rev_2_0=cnt(lambda r: r['mms_approved'] and not r['mms_approved_prev_rev']),
                     approved_in_previous_only=cnt(lambda r: r['mms_approved_prev_rev'] and not r['mms_approved']),
                     assigned=cnt(lambda r: r['mms_subcon']),
                     assigned_by_subcon=dict(collections.Counter(r['mms_subcon'] for r in records if r['mms_subcon'])),
                     assigned_by_drawing_label=dict(collections.Counter(r['mms_subcon_label'] for r in records if r['mms_subcon_label'])),
                     assigned_not_approved=cnt(lambda r: r['mms_subcon'] and not r['mms_approved']),
                     approved_not_assigned=cnt(lambda r: r['mms_approved'] and not r['mms_subcon']))
report['pv'] = dict(approved=cnt(lambda r: r['pv_approved']), assigned=cnt(lambda r: r['pv_subcon']),
                    assigned_by_subcon=dict(collections.Counter(r['pv_subcon'] for r in records if r['pv_subcon'])),
                    assigned_by_drawing_label=dict(collections.Counter(r['pv_subcon_label'] for r in records if r['pv_subcon_label'])),
                    for_checking=cnt(lambda r: r['pv_for_checking']), assigned_not_approved=cnt(lambda r: r['pv_subcon'] and not r['pv_approved']),
                    approved_not_assigned=cnt(lambda r: r['pv_approved'] and not r['pv_subcon']),
                    base_fill_aci112=cnt(lambda r: r['pv_base_fill_112']),
                    base_fill_aci112_and_pv_approved=cnt(lambda r: r['pv_base_fill_112'] and r['pv_approved']),
                    drawing_totals_text=acc_mtext,
                    pv_approved_without_mms_approval=cnt(lambda r: r['dependency_exception']))
report['issue_counts'] = dict(collections.Counter(i['code'] for i in issues))

with open(os.path.join(OUT, 'registry.json'), 'w') as f:
    json.dump(records, f)
with open(os.path.join(OUT, 'import_report.json'), 'w') as f:
    json.dump(dict(report=report, issues=issues), f, indent=1)
print(json.dumps(report, indent=1))
