// Prepares a Supabase project through the Management API (runs in GitHub Actions).
// Needs SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF. Optional SITE_URL (the published app URL).
// 1. reads the project's API keys and exports them (masked) for later steps
// 2. applies supabase/migrations/*.sql once each (tracked in public.app_migrations)
// 3. loads the CAD baseline seed if the project has no tables yet
// 4. sets the auth site URL so password-reset links return to the app
// --keys-only stops after step 1 (used by the smoke-test job).
import fs from 'node:fs';
import path from 'node:path';

// Secrets are often pasted with a line break, quotes or a "Bearer " prefix; accept those, and accept
// the project URL in place of its Reference ID. Never print the values (the logs are public).
const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '').trim().replace(/^bearer\s+/i, '').trim();
const token = clean(process.env.SUPABASE_ACCESS_TOKEN);
let ref = clean(process.env.SUPABASE_PROJECT_REF);
const fromUrl = ref.match(/^https?:\/\/([a-z0-9]+)\.supabase\.(?:co|com|in)/i) || ref.match(/\/project\/([a-z0-9]+)/i);
if (fromUrl) ref = fromUrl[1];
const fail = (m) => { console.error(`::error::${m}`); process.exit(1); };
if (!token || !ref) fail('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required');
if (/\s/.test(token)) fail('SUPABASE_ACCESS_TOKEN contains spaces or line breaks inside it. Paste only the token (it starts with sbp_).');
if (!/^sbp_/.test(token)) {
  const looks = /^eyJ/.test(token) ? 'a project API key (anon or service_role JWT)' : /^sb_(secret|publishable)_/.test(token) ? 'a project API key (sb_secret_/sb_publishable_)' : 'something other than a personal access token';
  fail(`SUPABASE_ACCESS_TOKEN looks like ${looks}. It must be a personal access token from supabase.com/dashboard/account/tokens; those start with sbp_.`);
}
if (!/^[a-z0-9]+$/.test(ref)) fail('SUPABASE_PROJECT_REF should be the project Reference ID (Project Settings → General), e.g. abcdefghijklmnopqrst, or the project URL.');
if (ref.length !== 20) console.log(`::warning::SUPABASE_PROJECT_REF has ${ref.length} characters; Supabase Reference IDs usually have 20.`);
console.log(`::add-mask::${ref}`);
// overridable only to rehearse this script against a local imitation of the Management API
const API = process.env.SUPABASE_API_URL || 'https://api.supabase.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}, tries = 5) {
  for (let i = 1; ; i++) {
    const res = await fetch(API + p, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (res.ok) { const t = await res.text(); return t ? JSON.parse(t) : null; }
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && i < tries) { await sleep(2000 * i); continue; }
    if (res.status === 401) fail(`The Supabase Management API rejected SUPABASE_ACCESS_TOKEN (401). Create a new personal access token at supabase.com/dashboard/account/tokens and save it as the secret.`);
    if (res.status === 403 || res.status === 404) fail(`The Supabase Management API answered ${res.status} for the project. Check that SUPABASE_PROJECT_REF is the Reference ID of a project that the token's account can open.`);
    throw new Error(`${opts.method || 'GET'} ${p} → ${res.status}: ${body.slice(0, 600)}`);
  }
}
const sql = (query) => api(`/projects/${ref}/database/query`, { method: 'POST', body: JSON.stringify({ query }) });
const out = (k, v) => { console.log(`::add-mask::${v}`); if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `${k}=${v}\n`); };

// ---- 1. project + keys
const project = await api(`/projects/${ref}`);
console.log(`Project ${project.name} (${project.region}), status ${project.status}`);
if (project.status && !/ACTIVE/i.test(project.status)) throw new Error(`Project is ${project.status}; restore it in the Supabase dashboard first.`);
const keys = await api(`/projects/${ref}/api-keys?reveal=true`);
const pick = (names, types) => keys.find((k) => names.includes(k.name) && (!k.type || k.type === 'legacy'))?.api_key || keys.find((k) => types.includes(k.type))?.api_key;
const anon = pick(['anon'], ['publishable']);
const service = pick(['service_role'], ['secret']);
if (!anon || !service) throw new Error('Could not read the project API keys.');
out('SUPABASE_URL', process.env.SUPABASE_PROJECT_URL || `https://${ref}.supabase.co`); out('SUPABASE_ANON_KEY', anon); out('SUPABASE_SERVICE_ROLE_KEY', service);
console.log(`API keys: ${keys.map((k) => `${k.name}/${k.type || 'legacy'}`).join(', ')}`);
if (process.argv.includes('--keys-only')) process.exit(0);

// ---- 2. migrations
await sql(`create table if not exists public.app_migrations (name text primary key, applied_at timestamptz not null default now());
           alter table public.app_migrations enable row level security; revoke all on public.app_migrations from anon, authenticated;`);
const applied = new Set((await sql('select name from public.app_migrations')).map((r) => r.name));
const dir = 'supabase/migrations';
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  if (applied.has(f)) { console.log(`migration ${f}: already applied`); continue; }
  console.log(`migration ${f}: applying`);
  await sql(fs.readFileSync(path.join(dir, f), 'utf8'));
  await sql(`insert into public.app_migrations (name) values ('${f.replace(/'/g, "''")}')`);
}

// ---- 3. seed (CAD baseline) once
const [{ n }] = await sql('select count(*)::int as n from public.pv_tables');
if (n === 0) {
  const sdir = 'data/build/seed';
  if (!fs.existsSync(sdir)) throw new Error('Seed files missing: decrypt data/bundle.tar.gz.enc first.');
  const files = fs.readdirSync(sdir).filter((x) => x.endsWith('.sql')).sort();
  for (const f of files) { process.stdout.write(`seed ${f}… `); await sql(fs.readFileSync(path.join(sdir, f), 'utf8')); console.log('ok'); }
} else console.log(`seed: ${n} tables already present, skipped`);
await sql(`notify pgrst, 'reload schema'`);
const [check] = await sql(`select (select count(*) from public.pv_tables)::int tables, (select count(*) from public.progress where qa_status = 'approved')::int approved,
  (select count(*) from public.assignments)::int assignments, (select count(*) from storage.buckets where id in ('attachments','drone'))::int buckets`);
console.log(`database: ${JSON.stringify(check)}`);

// ---- 4. auth settings
if (process.env.SITE_URL) {
  const site = process.env.SITE_URL.replace(/\/?$/, '/');
  try {
    await api(`/projects/${ref}/config/auth`, { method: 'PATCH', body: JSON.stringify({ site_url: site, uri_allow_list: `${site}**`, mailer_autoconfirm: true }) });
    console.log(`auth: site URL ${site}; new accounts confirmed automatically and wait for an administrator to assign a role`);
  } catch (e) { console.log(`::warning::Auth settings not updated: ${e.message}`); }
}
