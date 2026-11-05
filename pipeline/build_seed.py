#!/usr/bin/env python3
"""Generate idempotent seed SQL from the registry, import report and drone evidence.

Writes data/build/seed/NN_*.sql. Each file is one transaction with app.bulk_import=on (the audit
trigger skips bulk rows; provenance is recorded in status_events / drawings / import_issues instead).
"""
import json, os, uuid, hashlib, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.path.join(ROOT, 'data', 'build')
OUT = os.path.join(B, 'seed'); os.makedirs(OUT, exist_ok=True)
NS = uuid.UUID('6f1c2a8e-3b7d-4c55-9a0e-5d1e2b3c4f60')
uid = lambda *parts: str(uuid.uuid5(NS, '/'.join(parts)))
reg = json.load(open(os.path.join(B, 'registry.json')))
rep = json.load(open(os.path.join(B, 'import_report.json')))
meta = json.load(open(os.path.join(B, 'drone_meta.json')))
evidence = json.load(open(os.path.join(B, 'drone_evidence.json')))
SRC = os.path.join(ROOT, 'data', 'source')


def q(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return "array[%s]::text[]" % ','.join(q(x) for x in v) if v else "'{}'::text[]"
    if isinstance(v, (dict,)):
        return q(json.dumps(v)) + '::jsonb'
    return "'" + str(v).replace("'", "''") + "'"


def write(name, body):
    with open(os.path.join(OUT, name), 'w') as f:
        f.write("begin;\nset local app.bulk_import = 'on';\n" + body + "\ncommit;\n")


CHUNK = 900


def write_rows(prefix, head, rows, tail=''):
    """One file per chunk so each request to the Supabase SQL API stays small."""
    for i in range(0, len(rows), CHUNK):
        write('%s_%02d.sql' % (prefix, i // CHUNK), head + ',\n'.join(rows[i:i + CHUNK]) + (tail or '') + ';\n')


for old in os.listdir(OUT):
    if old.endswith('.sql'):
        os.remove(os.path.join(OUT, old))


def sha(fn):
    p = os.path.join(SRC, fn)
    return hashlib.sha256(open(p, 'rb').read()).hexdigest() if os.path.exists(p) else None


SUBCONS = [
    ('TECHNO', 'TECHNO', [], '#0000FF'),
    ('JJC', 'JJC', ['JJ', 'JJCES'], '#00FF00'),
    ('SAL', 'SAL', [], '#FFFF00'),
    ('RMS', 'RMS', [], '#00FFFF'),
    ('AAPCI', 'AAPCI', ['AAPSI'], '#FF00FF'),
]
SUB_ID = {c: uid('subcon', c) for c, *_ in SUBCONS}
settings = {
    'modules_per_table': 28, 'module_rows': 4, 'module_cols': 7,
    'module_size_m': [2.384, 1.303], 'module_gap_m': 0.02, 'table_size_m': [16.808, 5.272],
    'module_numbering': 'Modules 1-28 row by row from the north-west corner: row 1 is the northernmost row, column 1 the westernmost (module = (row-1)*7 + column).',
    'requires_client_approval': True,
    'status_opacity': 0.45,
    'cad_crs': 'MMS_APPROVED_2.0 model space (metres)',
    'baseline_rules': {
        'green_fill': 'Installed and QA/QC approved (MMS_APPROVED_2.0.dwg, APPROVED_PV.dwg)',
        'per_subcon_fill': 'Subcontractor assignment only (MS_APPROVED_PER_SUBCON.dwg, PV_ACCOMP_1._PER_SUBCON.dwg right-hand keyplan)',
        'aliases': 'JJ, JJC and JJCES are one company (JJC); AAPSI and AAPCI are one company (AAPCI)',
        'for_checking': 'Red "For checking" in the PV per-subcon drawing is stored as a review flag',
        'east_section': 'The 1,500-table eastern section in the left-hand keyplan of PV_ACCOMP_1 is not imported yet',
    },
}
parts = []
parts.append("insert into public.project (id, name, settings) values (1, %s, %s) on conflict (id) do update set settings = excluded.settings, name = excluded.name;"
             % (q('Expansion PV Farm'), q(settings)))
for i, code in enumerate(['M01', 'M02', 'M03', 'M04']):
    layer = {'M01': 'PV Panels-1', 'M02': 'PV Panels-2', 'M03': 'pv panels-3', 'M04': 'pv panels-4'}[code]
    parts.append("insert into public.blocks (code, name, cad_layer, sort) values (%s, %s, %s, %d) on conflict (code) do nothing;" % (q(code), q('Block ' + code), q(layer), i))
for code, name, aliases, color in SUBCONS:
    parts.append("insert into public.subcontractors (id, code, name, aliases, color) values (%s, %s, %s, %s, %s) on conflict (code) do nothing;"
                 % (q(SUB_ID[code]), q(code), q(name), q(aliases), q(color)))
R = rep['report']
drawings = [
    ('EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg', 'EXPANSION PV FARM - GEENRAL LAYOUT', 'table_ids', 'active', R['general_layout']),
    ('MMS_APPROVED_2.0.dwg', 'MMS APPROVED 2.0', 'baseline_geometry,mms_status', 'active', R['sources'].get('MMS_APPROVED_2.0')),
    ('MMS_APPROVED.dwg', 'MMS APPROVED', 'mms_status', 'superseded', R['sources'].get('MMS_APPROVED')),
    ('APPROVED_PV.dwg', 'APPROVED PV', 'pv_status', 'active', R['sources'].get('APPROVED_PV')),
    ('MS_APPROVED_PER_SUBCON.dwg', 'MS APPROVED PER SUBCON', 'mms_assignment', 'active', R['sources'].get('MS_APPROVED_PER_SUBCON')),
    ('PV_ACCOMP_1._PER_SUBCON.dwg', 'PV ACCOMP_1. PER SUBCON', 'pv_assignment', 'active', R['sources'].get('PV_ACCOMP_1 (right)')),
]
for fn, title, purpose, status, stats in drawings:
    note = {'MMS_APPROVED.dwg': 'Superseded by MMS_APPROVED_2.0 (36 more outlines, 10 more approvals).',
            'PV_ACCOMP_1._PER_SUBCON.dwg': 'Right-hand keyplan imported. The left-hand keyplan (with a 1,500-table eastern section) is kept for reference only.',
            'EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg': 'Source of Table IDs (text labels centred in each table).'}.get(fn)
    parts.append("insert into public.drawings (id, file_name, title, purpose, status, sha256, stats, notes) values (%s, %s, %s, %s, %s, %s, %s, %s) on conflict (id) do nothing;"
                 % (q(uid('drawing', fn)), q(fn), q(title), q(purpose), q(status), q(sha(fn)), q(stats or {}), q(note)))
parts.append("insert into public.dependency_rules (predecessor, successor, rule, enforced) values ('MMS','PV','PV modules may be installed only on a completed mounting structure', true) on conflict do nothing;")
write('01_reference.sql', '\n'.join(parts))

# tables
rows = []
for t in reg:
    rows.append("(%s,%s,%s,%s,%s,%s,%s,%r,%r,%r,%r,%d,%s)" % (
        q(uid('table', t['key'])), q(t['key']), q(t['table_code']), q(t['block']), q(t['id_col']), q(t['id_row']), q(t['layer']),
        t['x0'], t['y0'], t['x1'], t['y1'], t['cad_outlines'], q(t['id_flags'])))
write_rows('02_tables', "insert into public.pv_tables (id, sys_key, table_code, block_code, id_col, id_row, cad_layer, x0, y0, x1, y1, cad_outlines, id_flags) values\n", rows, "\non conflict (sys_key) do nothing")

# assignments + progress + approvals + exceptions + events
asg, prog, appr, exc, ev = [], [], [], [], []
for t in reg:
    tid = uid('table', t['key'])
    for disc, sub, lab, src in (('MMS', t['mms_subcon'], t['mms_subcon_label'], 'MS_APPROVED_PER_SUBCON.dwg'), ('PV', t['pv_subcon'], t['pv_subcon_label'], 'PV_ACCOMP_1._PER_SUBCON.dwg')):
        if sub:
            asg.append("(%s,'%s',%s,%s)" % (q(tid), disc, q(SUB_ID[sub]), q('CAD: %s (legend %s)' % (src, lab))))
    for disc, ok, src in (('MMS', t['mms_approved'], 'MMS_APPROVED_2.0.dwg'), ('PV', t['pv_approved'], 'APPROVED_PV.dwg')):
        if ok:
            prog.append("(%s,'%s','completed','approved',100,%d,%d,null,%s)" % (q(tid), disc, 28 if disc == 'PV' else 0, (1 << 28) - 1 if disc == 'PV' else 0, q('CAD baseline: ' + src)))
            appr.append("(%s,'%s','qaqc',%s,%s,%s)" % (q(tid), disc, q('QA/QC (CAD baseline)'), q(src), q('CAD baseline')))
            ev.append("(%s,'%s','baseline','not_started','completed','none','approved',%d,%s)" % (q(tid), disc, 28 if disc == 'PV' else 0, q('Imported from %s: green = installed and QA/QC approved' % src)))
        else:
            prog.append("(%s,'%s','not_started','none',0,0,0,null,'CAD baseline')" % (q(tid), disc))
    if t['dependency_exception']:
        exc.append("(%s,'PV',%s,'CAD baseline')" % (q(tid), q('PV approved in APPROVED_PV.dwg while the mounting structure is not approved in MMS_APPROVED_2.0.dwg — recorded at import for review')))
write_rows('03a_assignments', "insert into public.assignments (table_id, discipline, subcontractor_id, source) values\n", asg, "\non conflict do nothing")
write_rows('03b_progress', "insert into public.progress (table_id, discipline, work_status, qa_status, progress_pct, installed_modules, module_mask, approved_at, source) values\n", prog, "\non conflict do nothing")
write_rows('03c_approvals', "insert into public.approvals (table_id, discipline, stage, approver_name, reference, source) values\n", appr)
if exc:
    write_rows('03d_exceptions', "insert into public.dependency_exceptions (table_id, successor, reason, source) values\n", exc)
write_rows('03e_events', "insert into public.status_events (table_id, discipline, event, from_work, to_work, from_qa, to_qa, installed_modules, note) values\n", ev)
body = ''
for t in reg:
    if t['pv_for_checking']:
        body += "insert into public.import_issues (drawing, severity, code, message, table_id) values ('PV_ACCOMP_1._PER_SUBCON.dwg','info','FOR_CHECKING',%s,%s);\n" % (
            q('%s is marked red "For checking" in the PV per-subcon drawing.' % (t['table_code'] or t['key'])), q(uid('table', t['key'])))
write('03f_for_checking.sql', body)

# drone
layer_id = uid('drone', meta['capture_date'])
prefix = meta['capture_date'] + '/'
body = "insert into public.drone_layers (id, capture_date, source_file, bucket, prefix, meta, is_active) values (%s,%s,%s,'drone',%s,%s,true) on conflict (id) do update set meta = excluded.meta;\n" % (
    q(layer_id), q(meta['capture_date']), q(meta['source']), q(prefix), q(meta))
write('04a_drone_layer.sql', body)
ev_rows = ["(%s,%s,%r)" % (q(uid('table', k)), q(layer_id), v) for k, v in evidence.items()]
write_rows('04b_drone_evidence', "insert into public.drone_evidence (table_id, layer_id, module_cover) values\n", ev_rows, "\non conflict do nothing")

# import issues
key2id = {t['key']: uid('table', t['key']) for t in reg}
rows = []
DRAW = {'NEAR_DUPLICATE_OUTLINE': 'MMS_APPROVED_2.0.dwg', 'GL_TABLE_NOT_ON_BASELINE': 'EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg', 'ID_WITHOUT_TABLE': 'EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg',
        'DUPLICATE_ID': 'EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg', 'NONSTANDARD_ID': 'EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg', 'ID_BY_LABEL_POSITION': 'EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg',
        'MISSING_ID': 'EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg', 'ROW_ORDER': 'EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg', 'COLUMN_ORDER': 'EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg',
        'PV_ASSIGNMENT_CONFLICT': 'PV_ACCOMP_1._PER_SUBCON.dwg', 'MMS_ASSIGNMENT_CONFLICT': 'MS_APPROVED_PER_SUBCON.dwg', 'PV_BEFORE_MMS': 'APPROVED_PV.dwg'}
for i in rep['issues']:
    extra = {k: v for k, v in i.items() if k not in ('severity', 'code', 'message', 'table')}
    drawing = extra.get('drawing') or DRAW.get(i['code'])
    rows.append("(%s,%s,%s,%s,%s,%s)" % (q(drawing), q(i['severity']), q(i['code']), q(i['message']), q(key2id.get(i['table'])), q(extra)))
write_rows('05_issues', "insert into public.import_issues (drawing, severity, code, message, table_id, details) values\n", rows)
summary = dict(R)
body = "insert into public.import_issues (drawing, severity, code, message, details, status) values ('ALL','info','IMPORT_SUMMARY','Counts from the CAD import', %s, 'accepted');\n" % q(summary)
write('05z_summary.sql', body)
print('seed written', {f: os.path.getsize(os.path.join(OUT, f)) for f in sorted(os.listdir(OUT))})
