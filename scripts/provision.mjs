// Provision a Supabase project after the migrations ran: role accounts and drone tiles.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/provision.mjs [--users file.json] [--tiles dir --prefix 2026-10-26/]
// Never prints passwords or keys (CI logs of a public repository are public).
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exit(1); }
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function listAllUsers() {
  const all = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    all.push(...data.users);
    if (data.users.length < 200) break;
  }
  return all;
}

async function provisionUsers(file) {
  const users = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { data: subs, error: se } = await sb.from('subcontractors').select('id, code');
  if (se) throw se;
  const subId = Object.fromEntries(subs.map((s) => [s.code, s.id]));
  const existing = new Map((await listAllUsers()).map((u) => [u.email.toLowerCase(), u]));
  const { data: profs, error: pre } = await sb.from('profiles').select('id, role');
  if (pre) throw pre;
  const roleOf = new Map(profs.map((p) => [p.id, p.role]));
  // An account is set up once. Later runs leave it alone, so an administrator's changes
  // (role, blocks, deactivation) are never undone by a redeploy.
  let created = 0, updated = 0, kept = 0;
  for (const u of users) {
    let au = existing.get(u.email.toLowerCase());
    if (!au) {
      const { data, error } = await sb.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true, user_metadata: { full_name: u.full_name } });
      if (error) throw new Error(`create ${u.email}: ${error.message}`);
      au = data.user; created++;
    } else if (process.argv.includes('--reset-passwords')) {
      const { error } = await sb.auth.admin.updateUserById(au.id, { password: u.password });
      if (error) throw error;
    }
    if (roleOf.get(au.id) && !process.argv.includes('--reset-profiles')) { kept++; continue; }
    const { error: pe } = await sb.from('profiles').upsert({
      id: au.id, email: u.email, full_name: u.full_name, role: u.role,
      subcontractor_id: u.subcon ? subId[u.subcon] : null, assigned_blocks: u.blocks ?? null, active: true,
    });
    if (pe) throw new Error(`profile ${u.email}: ${pe.message}`);
    updated++;
  }
  console.log(`users: ${created} created, ${updated} profiles set, ${kept} already set up (left unchanged)`);
}

async function uploadTiles(dir, prefix) {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dir);
  // skip objects that are already there (re-runs are cheap)
  const have = new Set();
  const listDir = async (p) => {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await sb.storage.from('drone').list(p, { limit: 1000, offset });
      if (error) throw error;
      for (const o of data) {
        if (o.id === null) await listDir(p ? `${p}/${o.name}` : o.name); else have.add(p ? `${p}/${o.name}` : o.name);
      }
      if (data.length < 1000) break;
    }
  };
  await listDir(prefix.replace(/\/$/, ''));
  const todo = files.filter((f) => !have.has(prefix + path.relative(dir, f).split(path.sep).join('/')));
  let done = 0, failed = 0;
  const worker = async () => {
    while (todo.length) {
      const f = todo.shift();
      const rel = prefix + path.relative(dir, f).split(path.sep).join('/');
      const type = f.endsWith('.json') ? 'application/json' : 'image/webp';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { error } = await sb.storage.from('drone').upload(rel, fs.readFileSync(f), { contentType: type, upsert: true, cacheControl: '31536000' });
        if (!error) { done++; break; }
        if (attempt === 3) { failed++; console.error('upload failed', rel, error.message); }
        else await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`tiles: ${done} uploaded, ${have.size} already present, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

const usersFile = arg('--users');
if (usersFile) await provisionUsers(usersFile);
const tiles = arg('--tiles');
if (tiles) await uploadTiles(tiles, arg('--prefix') || '');
