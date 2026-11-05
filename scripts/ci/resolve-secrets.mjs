// Works out which repository secret holds which value by its form, so a value saved under the
// wrong name still works:
//   Supabase personal access token   sbp_ followed by 40 characters
//   Supabase project                 its Reference ID (20 letters) or any address that contains it
//   data key                         44 characters, recognised by its fingerprint
// Writes the values it finds to GITHUB_ENV (masked) as SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF
// and DATA_KEY for the later steps, checks that the token opens the project, and reports what is
// missing. Never prints a token or key. The project ID is printed: it is public anyway, as part of
// the app's Supabase address.
import crypto from 'node:crypto';
import fs from 'node:fs';

const DATA_KEY_FP = '68c7e5c39ab34a41';
const NAMES = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'DATA_KEY'];
const secrets = NAMES.map((name) => ({ name, value: process.env[name] || '' }));
const fp = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
const bare = (v) => v.replace(/[\s"'`]/g, '');
const order = (want) => [...secrets.filter((s) => s.name === want), ...secrets.filter((s) => s.name !== want)];

function findToken() {
  for (const s of order('SUPABASE_ACCESS_TOKEN')) {
    const m = [...new Set(s.value.match(/sbp_[A-Za-z0-9_]{32,}/g) || [])];
    if (m.length === 1) return { value: m[0], from: s.name };
  }
  return null;
}
function refIn(v) {
  const t = v.trim().replace(/^["'`]|["'`]$/g, '');
  const m = t.match(/https?:\/\/([a-z0-9]{20})\.supabase\.(?:co|com|in)/i) || t.match(/\/project\/([a-z0-9]{20})(?:[/?#]|$)/i) || t.match(/^([a-z0-9]{20})$/);
  return m ? m[1].toLowerCase() : null;
}
function findRef() {
  for (const s of order('SUPABASE_PROJECT_REF')) { const r = refIn(s.value); if (r) return { value: r, from: s.name }; }
  const fb = process.env.FALLBACK_PROJECT_REF || '';
  if (/^[a-z0-9]{20}$/.test(fb)) return { value: fb, from: 'the workflow file' };
  return null;
}
function findKey() {
  for (const s of order('DATA_KEY')) {
    for (const c of [bare(s.value), ...(s.value.match(/[A-Za-z0-9+/]{43}=/g) || [])]) if (c && fp(c) === DATA_KEY_FP) return { value: c, from: s.name };
  }
  return null;
}
function kind(v) {
  const t = v.trim();
  if (!t) return 'empty';
  if (/sbp_[A-Za-z0-9_]{32,}/.test(t)) return 'a Supabase access token';
  if (refIn(t)) return /supabase/i.test(t) ? 'a Supabase project address' : 'a project ID';
  if (fp(bare(t)) === DATA_KEY_FP || (t.match(/[A-Za-z0-9+/]{43}=/g) || []).some((c) => fp(c) === DATA_KEY_FP)) return 'the data key';
  if (/^eyJ/.test(t) || /^sb_(secret|publishable)_/.test(t)) return 'a Supabase API key (not one of the three values)';
  const words = t.split(/\s+/).length;
  return words > 1 ? `text of ${words} words (not one of the three values)` : `a ${t.length}-character value that is not one of the three`;
}

const token = findToken(), ref = findRef(), key = findKey();
const out = (k, v, mask) => { if (mask) console.log(`::add-mask::${v}`); if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `${k}=${v}\n`); };
if (token) out('SUPABASE_ACCESS_TOKEN', token.value, true);
if (ref) out('SUPABASE_PROJECT_REF', ref.value, false);
if (key) out('DATA_KEY', key.value, true);

console.log('Values found in the repository secrets:');
console.log(`  Supabase access token: ${token ? 'yes, in ' + token.from : 'MISSING'}`);
console.log(`  Supabase project:      ${ref ? ref.value + ', from ' + ref.from : 'MISSING'}`);
console.log(`  Data key:              ${key ? 'yes, in ' + key.from : 'MISSING'}`);
console.log(`What each secret holds: ${secrets.map((s) => `${s.name}: ${kind(s.value)}`).join('; ')}`);

const problems = [];
if (!token) problems.push('No secret holds a Supabase personal access token (sbp_…, from supabase.com/dashboard/account/tokens).');
if (!ref) problems.push('No secret holds the Supabase project address or ID (open the project in the Supabase dashboard and copy the browser address).');
if (!key) problems.push('No secret holds the data key (44 characters, ending in =) from the setup steps.');
if (token && ref) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref.value}`, { headers: { Authorization: `Bearer ${token.value}` } }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  if (res.ok) { const p = await res.json(); console.log(`Supabase: the token opens project "${p.name}" (${p.region}), status ${p.status}`); }
  else if (res.status === 401) problems.push('Supabase rejected the access token (401). Generate a new one at supabase.com/dashboard/account/tokens.');
  else if (res.status === 403 || res.status === 404) problems.push(`The access token's Supabase account cannot open project ${ref.value} (${res.status}). Check that the token and the project belong to the same account.`);
  else problems.push(`The Supabase Management API answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
for (const p of problems) console.log(`::error::${p}`);
process.exit(problems.length ? 1 : 0);
