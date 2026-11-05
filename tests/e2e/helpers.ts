import { expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

export const users: { email: string; password: string; role: string; subcon: string | null }[] =
  JSON.parse(fs.readFileSync(process.env.DEMO_USERS || 'data/secrets/demo_users.json', 'utf8'));
export const pw = (email: string) => users.find((u) => u.email === email)!.password;
export const readonly = !!process.env.E2E_READONLY;

export async function login(page: Page, email: string) {
  await page.goto('./');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(pw(email));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.topbar')).toBeVisible({ timeout: 45_000 });
}
export async function openTable(page: Page, code: string) {
  await page.goto(`./#/keyplan?table=${encodeURIComponent(code)}`);
  await expect(page.locator('.td-id')).toHaveText(code, { timeout: 30_000 });
}
export async function toast(page: Page, text: string | RegExp) {
  await expect(page.locator('.toast').filter({ hasText: text }).first()).toBeVisible({ timeout: 20_000 });
}

/** API access as a demo user, for finding fixtures. */
export async function api(email = 'admin@example.com') {
  const c = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: pw(email) });
  if (error) throw error;
  return c;
}
export async function allState(c: any) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.from('v_table_state').select('*').order('id').range(from, from + 999);
    if (error) throw error; out.push(...data); if (data.length < 1000) break;
  }
  return out;
}
