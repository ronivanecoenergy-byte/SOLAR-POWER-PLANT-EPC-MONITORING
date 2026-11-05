// End-to-end API tests for role-based access and the construction workflow.
// Runs against any Supabase project that has the migrations, seed and demo accounts.
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... DEMO_USERS=data/secrets/demo_users.json node scripts/api-tests.mjs [--readonly]
// --readonly skips tests that change records (used against production).
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
const users = JSON.parse(fs.readFileSync(process.env.DEMO_USERS || 'data/secrets/demo_users.json', 'utf8'));
const readonly = process.argv.includes('--readonly');
const pw = (email) => users.find((u) => u.email === email).password;
let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name]); console.log('  ✓', name); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); console.log('  ✗', name, '—', e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const clients = {};
async function as(email) {
  if (clients[email]) return clients[email];
  const c = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: pw(email) });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return (clients[email] = c);
}
async function all(q, keys = ['id']) { // page through PostgREST's 1000-row limit with a unique sort key
  const out = [];
  for (let from = 0; ; from += 1000) {
    let qq = q(); for (const k of keys) qq = qq.order(k);
    const { data, error } = await qq.range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
const denied = (error) => error && (error.code === '42501' || /not|only|cannot|denied|permission|row-level/i.test(error.message));

console.log(`API tests against ${url}${readonly ? ' (read-only)' : ''}`);
const admin = await as('admin@example.com');
const subs = Object.fromEntries((await admin.from('subcontractors').select('id, code')).data.map((s) => [s.code, s.id]));

// ---------------- visibility
await test('anonymous visitors cannot read project data', async () => {
  const c = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await c.from('pv_tables').select('id').limit(1);
  assert(error || data.length === 0, 'anonymous read returned rows');
});
await test('admin sees all 3,512 tables and both disciplines of progress', async () => {
  const t = await all(() => admin.from('pv_tables').select('id'));
  assert(t.length === 3512 && new Set(t.map((r) => r.id)).size === 3512, `got ${t.length}`);
  const p = await all(() => admin.from('progress').select('table_id'), ['table_id', 'discipline']);
  assert(p.length === 7024, `progress rows ${p.length}`);
});
await test('CEO can read dashboards data (v_table_state) for every table', async () => {
  const ceo = await as('ceo@example.com');
  const v = await all(() => ceo.from('v_table_state').select('id, mms_work, pv_work'));
  assert(v.length === 3512 && v.filter((r) => r.mms_work).length === 3512, 'missing rows');
});
await test('subcontractor TECHNO sees table outlines but only its own records', async () => {
  const t = await as('techno@example.com');
  const tables = await all(() => t.from('pv_tables').select('id'));
  assert(tables.length === 3512, 'outlines hidden');
  const asg = await all(() => t.from('assignments').select('subcontractor_id, discipline'), ['table_id', 'discipline']);
  assert(asg.length > 0 && asg.every((a) => a.subcontractor_id === subs.TECHNO), 'foreign assignments visible');
  const prog = await all(() => t.from('progress').select('table_id, discipline'), ['table_id', 'discipline']);
  assert(prog.length === asg.length, `progress ${prog.length} vs assignments ${asg.length}`);
  const v = await all(() => t.from('v_table_state').select('mms_subcon, pv_subcon, mms_work, pv_work'));
  const leaked = v.filter((r) => (r.mms_work && r.mms_subcon !== subs.TECHNO) || (r.pv_work && r.pv_subcon !== subs.TECHNO));
  assert(leaked.length === 0, `${leaked.length} foreign rows visible`);
  const { data: audit } = await t.from('audit_log').select('id').limit(1);
  assert(audit.length === 0, 'audit log visible to subcontractor');
});
if (!readonly) await test('a user without a role sees nothing', async () => {
  const c = createClient(url, anon, { auth: { persistSession: false } });
  const email = `pending-${Date.now()}@example.com`;
  const { error: se } = await c.auth.signUp({ email, password: 'Pending-Account-1' });
  assert(!se, se?.message);
  const { data } = await c.from('pv_tables').select('id').limit(5);
  assert(data.length === 0, 'pending user can read tables');
  const { error } = await c.rpc('update_progress', { p_tables: [], p_discipline: 'MMS', p_work: 'ongoing' });
  assert(denied(error), 'pending user could call update_progress');
});
await test('baseline counts match the CAD import (from append-only records, so later work does not change them)', async () => {
  const tables = await all(() => admin.from('pv_tables').select('id'));
  assert(tables.length === 3512, `tables ${tables.length}`);
  // approvals imported from the drawings are never deleted (a reopened approval adds a punch item instead)
  const appr = await all(() => admin.from('approvals').select('id, discipline').eq('source', 'CAD baseline'));
  const a = (d) => appr.filter((r) => r.discipline === d).length;
  assert(a('MMS') === 2299 && a('PV') === 2166, `CAD approvals MMS ${a('MMS')}, PV ${a('PV')}`);
  // assignments: rows still from the drawings + rows changed in the app whose first change was away from a CAD subcontractor
  const asg = await all(() => admin.from('assignments').select('table_id, discipline, source'), ['table_id', 'discipline']);
  const ev = await all(() => admin.from('status_events').select('id, table_id, discipline, note, at').eq('event', 'assigned'));
  const first = new Map();
  for (const e of ev.sort((x, y) => x.id - y.id)) { const k = e.table_id + e.discipline; if (!first.has(k)) first.set(k, e); }
  const imported = (d) => asg.filter((r) => r.discipline === d && r.source.startsWith('CAD:')).length
    + [...first.values()].filter((e) => e.discipline === d && !/^unassigned/.test(e.note || '')).length;
  assert(imported('MMS') === 2348 && imported('PV') === 2325, `imported assignments MMS ${imported('MMS')}, PV ${imported('PV')}`);
});
await test('drone tiles are private: members can read, anonymous cannot', async () => {
  const site = await as('site@example.com');
  const { data, error } = await site.storage.from('drone').download('2026-10-26/meta.json');
  assert(!error && data, error?.message);
  const c = createClient(url, anon, { auth: { persistSession: false } });
  const r = await c.storage.from('drone').download('2026-10-26/meta.json');
  assert(r.error, 'anonymous download worked');
});

if (readonly) {
  // production smoke test: permission checks that are refused, so nothing is written
  const v = await all(() => admin.from('v_table_state').select('id, mms_subcon, mms_work, mms_qa, pv_subcon'));
  const mineApproved = v.find((r) => r.mms_subcon === subs.TECHNO && r.mms_qa === 'approved');
  const other = v.find((r) => r.mms_subcon === subs.JJC && r.pv_subcon !== subs.TECHNO); // TECHNO has no part in this table
  const techno = await as('techno@example.com'), site = await as('site@example.com'), planner = await as('planner@example.com'), ceo = await as('ceo@example.com'), pm = await as('pm@example.com');
  await test('subcontractor cannot record verified progress (refused)', async () => {
    const { error } = await techno.rpc('update_progress', { p_tables: [mineApproved.id], p_discipline: 'MMS', p_work: 'ongoing' });
    assert(denied(error), 'not refused');
  });
  await test('subcontractor cannot report on another company’s table (refused)', async () => {
    const { error } = await techno.rpc('submit_accomplishment', { p_table: other.id, p_discipline: 'MMS', p_work: 'completed' });
    assert(denied(error), 'not refused');
  });
  await test('subcontractor cannot inspect or approve (refused)', async () => {
    const a = await techno.rpc('record_inspection', { p_table: mineApproved.id, p_discipline: 'MMS', p_stage: 'qaqc', p_result: 'passed' });
    const b = await techno.rpc('record_approval', { p_tables: [mineApproved.id], p_discipline: 'MMS' });
    assert(denied(a.error) && denied(b.error), 'not refused');
  });
  await test('CEO and Project Planner cannot change installation status (refused)', async () => {
    const a = await ceo.rpc('update_progress', { p_tables: [mineApproved.id], p_discipline: 'MMS', p_work: 'ongoing' });
    const b = await planner.rpc('update_progress', { p_tables: [mineApproved.id], p_discipline: 'MMS', p_work: 'ongoing' });
    assert(denied(a.error) && denied(b.error), 'not refused');
  });
  await test('approved work is protected from engineers (refused)', async () => {
    const { error } = await site.rpc('update_progress', { p_tables: [mineApproved.id], p_discipline: 'MMS', p_work: 'ongoing' });
    assert(error && /approved/.test(error.message), error?.message || 'changed');
  });
  await test('only PIC/CM/admin can reassign tables (refused for PM and subcontractor)', async () => {
    const a = await pm.rpc('set_assignment', { p_tables: [other.id], p_discipline: 'MMS', p_subcon: subs.TECHNO });
    const b = await techno.rpc('set_assignment', { p_tables: [other.id], p_discipline: 'MMS', p_subcon: subs.TECHNO });
    assert(denied(a.error) && denied(b.error), 'not refused');
  });
  await test('direct writes to records are blocked by row-level security', async () => {
    await techno.from('progress').update({ qa_status: 'approved' }).eq('table_id', other.id);
    const { data } = await admin.from('progress').select('qa_status').eq('table_id', other.id).eq('discipline', 'MMS').single();
    const before = v.find((r) => r.id === other.id).mms_qa;
    assert(data.qa_status === before, 'record changed');
  });
  await test('subcontractor cannot upload to another company’s table (refused)', async () => {
    const path = `${other.id}/smoke-test-${Date.now()}.png`;
    const r = await techno.storage.from('attachments').upload(path, Buffer.from('x'), { contentType: 'image/png' });
    if (!r.error) await admin.storage.from('attachments').remove([path]); // never leave a file behind
    assert(r.error, 'upload accepted');
  });
}

if (!readonly) {
  // pick a TECHNO table whose MMS is not started (and a JJC one for cross-checks)
  const v = await all(() => admin.from('v_table_state').select('id, table_code, mms_subcon, pv_subcon, mms_work, pv_work, mms_qa'));
  assert(new Set(v.map((r) => r.id)).size === v.length, 'duplicate rows across pages');
  const mine = v.find((r) => r.mms_subcon === subs.TECHNO && r.mms_work === 'not_started' && r.pv_subcon === subs.TECHNO);
  const mine2 = v.find((r) => r.mms_subcon === subs.TECHNO && r.mms_work === 'not_started' && r.id !== mine?.id);
  const other = v.find((r) => r.mms_subcon === subs.JJC && r.mms_work === 'not_started');
  const approvedMine = v.find((r) => r.mms_subcon === subs.TECHNO && r.mms_qa === 'approved');
  const techno = await as('techno@example.com'), site = await as('site@example.com'), qa = await as('qaqc@example.com');
  const cm = await as('cm@example.com'), planner = await as('planner@example.com'), ceo = await as('ceo@example.com'), pm = await as('pm@example.com');
  const state = async (id, d) => (await admin.from('progress').select('*').eq('table_id', id).eq('discipline', d).single()).data;

  await test('fixtures found (TECHNO not-started MMS table, JJC table, approved TECHNO table)', async () => {
    assert(mine && mine2 && other && approvedMine, 'fixtures missing');
  });
  await test('subcontractor cannot record verified progress directly', async () => {
    const { error } = await techno.rpc('update_progress', { p_tables: [mine.id], p_discipline: 'MMS', p_work: 'completed' });
    assert(denied(error), 'not denied');
  });
  await test('subcontractor cannot submit for another company’s table', async () => {
    const { error } = await techno.rpc('submit_accomplishment', { p_table: other.id, p_discipline: 'MMS', p_work: 'completed' });
    assert(denied(error), 'not denied');
  });
  let reportId;
  await test('subcontractor submission does not change official progress', async () => {
    const { data, error } = await techno.rpc('submit_accomplishment', { p_table: mine.id, p_discipline: 'MMS', p_work: 'completed', p_note: 'Structure complete' });
    assert(!error, error?.message); reportId = data;
    assert((await state(mine.id, 'MMS')).work_status === 'not_started', 'status changed before verification');
  });
  await test('CEO cannot verify or update (decision-making role only)', async () => {
    const { error } = await ceo.rpc('review_accomplishment', { p_id: reportId, p_verify: true });
    assert(denied(error), 'not denied');
  });
  await test('Site Engineer verifies → official progress Completed, history and audit written', async () => {
    const { error } = await site.rpc('review_accomplishment', { p_id: reportId, p_verify: true, p_note: 'Checked on site' });
    assert(!error, error?.message);
    const s = await state(mine.id, 'MMS');
    assert(s.work_status === 'completed' && s.progress_pct === 100 && s.verified_by, JSON.stringify(s));
    const { data: ev } = await admin.from('status_events').select('event').eq('table_id', mine.id).eq('event', 'verified');
    assert(ev.length === 1, 'no verified event');
    const { data: au } = await admin.from('audit_log').select('id, actor, old_data, new_data').eq('table_name', 'progress').eq('record_id', `${mine.id}:MMS`).order('id', { ascending: false }).limit(1);
    assert(au.length === 1 && au[0].old_data.work_status === 'not_started' && au[0].new_data.work_status === 'completed', 'audit missing old/new');
  });
  await test('PV cannot start before the structure is complete (dependency rule)', async () => {
    const { error } = await site.rpc('update_progress', { p_tables: [mine2.id], p_discipline: 'PV', p_mask: 15 });
    assert(error && /mounting structure/.test(error.message), error?.message || 'allowed');
  });
  await test('Construction Manager records a dependency exception → PV progress allowed, modules tracked individually', async () => {
    const { error } = await cm.rpc('record_dependency_exception', { p_tables: [mine2.id], p_reason: 'Test: approved early start' });
    assert(!error, error?.message);
    const { error: e2 } = await site.rpc('update_progress', { p_tables: [mine2.id], p_discipline: 'PV', p_mask: (1 << 7) - 1 });
    assert(!e2, e2?.message);
    const s = await state(mine2.id, 'PV');
    assert(s.installed_modules === 7 && s.work_status === 'ongoing' && s.module_mask === 127, JSON.stringify(s));
  });
  await test('On Hold needs a reason', async () => {
    const { error } = await site.rpc('update_progress', { p_tables: [mine2.id], p_discipline: 'MMS', p_work: 'on_hold' });
    assert(error, 'accepted without reason');
    const { error: e2 } = await site.rpc('update_progress', { p_tables: [mine2.id], p_discipline: 'MMS', p_work: 'on_hold', p_hold_reason: 'Pile refusal at this table' });
    assert(!e2, e2?.message);
  });
  await test('inspection workflow: request → schedule → fail → rectify → reinspect → client approval', async () => {
    let r = await techno.rpc('request_inspection', { p_tables: [mine.id], p_discipline: 'MMS', p_note: 'Ready' });
    assert(!r.error, r.error?.message);
    assert((await state(mine.id, 'MMS')).qa_status === 'ready_for_inspection', 'not ready');
    const { data: req } = await qa.from('inspection_requests').select('id').eq('table_id', mine.id).eq('status', 'open');
    r = await qa.rpc('schedule_inspection', { p_request_ids: [req[0].id], p_date: new Date().toISOString().slice(0, 10) });
    assert(!r.error, r.error?.message);
    assert((await state(mine.id, 'MMS')).qa_status === 'for_inspection', 'not for inspection');
    r = await qa.rpc('record_inspection', { p_table: mine.id, p_discipline: 'MMS', p_stage: 'qaqc', p_result: 'failed', p_comments: 'Torque check failed', p_punch: ['Re-torque purlin bolts', 'Replace damaged clamp'] });
    assert(!r.error, r.error?.message);
    assert((await state(mine.id, 'MMS')).qa_status === 'for_rectification', 'not for rectification');
    const { data: punch } = await techno.from('punch_items').select('id, status').eq('table_id', mine.id);
    assert(punch.length === 2 && punch.every((p) => p.status === 'open'), 'subcontractor cannot see its punch items');
    r = await techno.rpc('request_inspection', { p_tables: [mine.id], p_discipline: 'MMS' });
    assert(r.error, 'reinspection allowed with open items');
    r = await techno.rpc('resubmit_rectification', { p_ids: punch.map((p) => p.id), p_note: 'Fixed' });
    assert(!r.error, r.error?.message);
    assert((await state(mine.id, 'MMS')).qa_status === 'ready_for_inspection', 'not ready after rectification');
    r = await qa.rpc('record_inspection', { p_table: mine.id, p_discipline: 'MMS', p_stage: 'qaqc', p_result: 'passed', p_comments: 'OK at reinspection' });
    assert(!r.error, r.error?.message);
    assert((await state(mine.id, 'MMS')).qa_status === 'for_approval', 'not for approval');
    r = await techno.rpc('record_approval', { p_tables: [mine.id], p_discipline: 'MMS', p_approver_name: 'self' });
    assert(denied(r.error), 'subcontractor approved own work');
    r = await qa.rpc('record_approval', { p_tables: [mine.id], p_discipline: 'MMS', p_stage: 'client', p_approver_name: 'Client representative', p_reference: 'IR-TEST-001' });
    assert(!r.error, r.error?.message);
    const s = await state(mine.id, 'MMS');
    assert(s.qa_status === 'approved' && s.approved_by, 'not approved');
    const { data: closed } = await admin.from('punch_items').select('status').eq('table_id', mine.id);
    assert(closed.every((p) => p.status === 'closed'), 'punch items not closed');
  });
  await test('approved work is protected from changes (engineers and subcontractors)', async () => {
    const { error } = await site.rpc('update_progress', { p_tables: [approvedMine.id], p_discipline: 'MMS', p_work: 'ongoing' });
    assert(error && /approved/.test(error.message), error?.message || 'changed');
  });
  await test('subcontractor cannot change QA/QC results or inspect', async () => {
    const { error } = await techno.rpc('record_inspection', { p_table: approvedMine.id, p_discipline: 'MMS', p_stage: 'qaqc', p_result: 'passed' });
    assert(denied(error), 'not denied');
    const { error: e2 } = await techno.from('progress').update({ qa_status: 'approved' }).eq('table_id', mine2.id);
    const s = await state(mine2.id, 'MMS');
    assert(s.qa_status !== 'approved', 'direct table write succeeded');
  });
  await test('Project Planner edits targets and milestones but not statuses', async () => {
    let r = await planner.rpc('set_target_dates', { p_tables: [mine2.id], p_discipline: 'PV', p_start: '2026-11-10', p_finish: '2026-11-20' });
    assert(!r.error, r.error?.message);
    r = await planner.from('targets').insert({ discipline: 'PV', subcontractor_id: subs.TECHNO, period: 'week', period_start: '2026-11-09', quantity: 40 });
    assert(!r.error, r.error?.message);
    r = await planner.from('milestones').insert({ name: 'Test milestone', discipline: 'PV', planned_date: '2026-12-15' }).select('id').single();
    assert(!r.error, r.error?.message);
    r = await planner.rpc('update_progress', { p_tables: [mine2.id], p_discipline: 'MMS', p_work: 'ongoing' });
    assert(denied(r.error), 'planner changed status');
  });
  await test('subcontractor reassignment needs PIC/CM/admin', async () => {
    let r = await techno.rpc('set_assignment', { p_tables: [other.id], p_discipline: 'MMS', p_subcon: subs.TECHNO });
    assert(denied(r.error), 'subcontractor reassigned');
    r = await pm.rpc('set_assignment', { p_tables: [other.id], p_discipline: 'MMS', p_subcon: subs.TECHNO });
    assert(denied(r.error), 'PM reassigned (not in brief)');
  });
  await test('photos: subcontractor can attach to own table only; staff can read', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    let r = await techno.storage.from('attachments').upload(`${mine.id}/test-photo.png`, png, { contentType: 'image/png', upsert: true });
    assert(!r.error, r.error?.message);
    r = await techno.storage.from('attachments').upload(`${other.id}/test-photo.png`, png, { contentType: 'image/png', upsert: true });
    assert(r.error, 'uploaded to another company’s table');
    const d = await qa.storage.from('attachments').download(`${mine.id}/test-photo.png`);
    assert(!d.error, d.error?.message);
    const ins = await techno.from('attachments').insert({ table_id: mine.id, discipline: 'MMS', storage_path: `${mine.id}/test-photo.png`, file_name: 'test-photo.png', mime: 'image/png' });
    assert(!ins.error, ins.error?.message);
  });
  await test('constraints: subcontractor records one on its own table; staff resolve it', async () => {
    const { data, error } = await techno.from('site_constraints').insert({ table_id: mine2.id, discipline: 'MMS', category: 'material', description: 'Waiting for purlins' }).select('id').single();
    assert(!error, error?.message);
    const r = await cm.from('site_constraints').update({ status: 'resolved', resolved_by: (await cm.auth.getUser()).data.user.id, resolved_at: new Date().toISOString(), resolution: 'Delivered' }).eq('id', data.id);
    assert(!r.error, r.error?.message);
  });
}
console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(process.env.API_TEST_REPORT || 'api-test-report.json', JSON.stringify({ url, readonly, pass, fail, results }, null, 1));
process.exit(fail ? 1 : 0);
