import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';
const users = JSON.parse(fs.readFileSync('data/secrets/demo_users.json','utf8'));
const pw = (e) => users.find(u => u.email === e).password;
const BASE = process.env.BASE || 'http://127.0.0.1:5173/';
const out = '/tmp/claude-0/shots/';
async function login(p, email) {
  await p.goto(BASE);
  await p.fill('input[type=email]', email); await p.fill('input[type=password]', pw(email));
  await p.click('button:has-text("Sign in")');
  await p.waitForSelector('.topbar', { timeout: 30000 });
}
const b = await chromium.launch();
const errors = [];
{ // desktop admin
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await login(p, 'admin@example.com');
  await p.waitForSelector('.figures', { timeout: 30000 }); await p.waitForTimeout(1500);
  await p.screenshot({ path: out + '02-dashboard.png', fullPage: true });
  await p.goto(BASE + '#/keyplan'); await p.waitForTimeout(5000);
  await p.screenshot({ path: out + '03-keyplan.png' });
  await p.fill('.searchbox input', 'M04-11-07'); await p.waitForTimeout(400); await p.keyboard.press('Enter'); await p.waitForTimeout(2500);
  await p.screenshot({ path: out + '04-table-selected.png' });
  for (let i = 0; i < 3; i++) { await p.click('button[aria-label="Zoom in"]'); await p.waitForTimeout(500); }
  await p.waitForTimeout(2500);
  await p.screenshot({ path: out + '05-zoom-modules.png' });
  await p.click('input[name=mode] >> nth=3'); await p.waitForTimeout(1500); // PV per subcon
  await p.click('button[aria-label="Show whole site"]'); await p.waitForTimeout(2500);
  await p.screenshot({ path: out + '06-pv-subcon.png' });
  await ctx.close();
}
{ // mobile site engineer
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push('M PAGEERROR ' + e.message));
  await login(p, 'site@example.com');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: out + '07-mobile-dashboard.png' });
  await p.goto(BASE + '#/keyplan?table=M04-11-07'); await p.waitForTimeout(5000);
  await p.screenshot({ path: out + '08-mobile-keyplan-sheet.png' });
  await ctx.close();
}
console.log('errors', errors.slice(0, 12));
await b.close();
