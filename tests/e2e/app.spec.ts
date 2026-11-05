import { expect, test } from '@playwright/test';
import { allState, api, login, openTable, pw, readonly, toast } from './helpers';

test.describe('sign-in and role-based navigation', () => {
  test('wrong password is rejected with a clear message', async ({ page }) => {
    await page.goto('./');
    await page.getByLabel('Email').fill('admin@example.com');
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('don’t match');
  });

  for (const [email, title, hidden] of [
    ['ceo@example.com', 'Executive dashboard', ['Administration']],
    ['pm@example.com', 'Project status', ['Administration']],
    ['cm@example.com', 'Site execution', ['Administration']],
    ['pic@example.com', 'Work coordination', ['Administration']],
    ['qaqc@example.com', 'Quality dashboard', ['Administration']],
    ['site@example.com', 'Field progress', ['Administration']],
    ['planner@example.com', 'Planning dashboard', ['Administration']],
    ['techno@example.com', 'TECHNO — your work', ['Administration', 'Subcontractors']],
    ['admin@example.com', 'Project overview', []],
  ] as [string, string, string[]][]) {
    test(`${email} gets the ${title} view`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await login(page, email);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
      for (const h of hidden) await expect(page.locator('.topbar .nav').getByRole('link', { name: h })).toHaveCount(0);
      await expect(page.locator('.figures').first()).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
});

test.describe('interactive digital keyplan', () => {
  test.beforeEach(async ({ page }) => { await login(page, 'admin@example.com'); });

  test('search by Table ID selects the table and opens its details', async ({ page }) => {
    await page.goto('./#/keyplan');
    await expect(page.locator('.kp-panel .figure').first()).toContainText('3,512');
    const box = page.getByLabel('Search by Table ID');
    await box.fill('M04-11-0');
    await expect(page.locator('.suggest [role=option]').first()).toBeVisible();
    await box.fill('M04-11-07');
    await page.keyboard.press('Enter');
    await expect(page.locator('.td-id')).toHaveText('M04-11-07');
    await expect(page.locator('.td-block')).toHaveText('Block M04');
    await expect(page.locator('.td-meta')).toContainText('Row 07');
    await expect(page.getByText('Work history')).toBeVisible();
    await expect(page.getByText('Outstanding items')).toBeVisible();
  });

  test('clicking the map selects the table under the pointer', async ({ page }) => {
    await openTable(page, 'M04-11-07');
    await page.getByLabel('Close details').click();
    await expect(page.locator('.td-id')).toHaveCount(0);
    await page.waitForTimeout(800);
    const map = page.locator('.ol');
    const b = (await map.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.locator('.td-id')).toHaveText('M04-11-07');
  });

  test('legend, subcontractor focus and counts highlight tables', async ({ page }) => {
    await page.goto('./#/keyplan');
    await page.getByLabel('Mounting structure per subcontractor').check();
    await page.locator('.legend button', { hasText: 'TECHNO' }).click();
    await expect(page.locator('.focusbar')).toContainText('1,192 tables');
    await page.locator('.legend button', { hasText: 'All Subcontractors' }).click();
    await expect(page.locator('.focusbar')).toHaveCount(0);
    await page.getByLabel('PV module installation').check();
    await page.getByRole('button', { name: /^SAL Approved: \d+/ }).click();
    await expect(page.locator('.focusbar')).toContainText('SAL — Approved (PV)');
    await page.locator('.focusbar').getByRole('button', { name: 'Clear' }).click();
    await page.locator('.legend button', { hasText: 'Not Started' }).click();
    await expect(page.locator('.focusbar')).toContainText('Not Started');
  });

  test('layers can be turned off and the opacity changed', async ({ page }) => {
    await page.goto('./#/keyplan');
    await page.getByLabel('Drone image', { exact: false }).uncheck();
    await page.getByLabel('Status colour opacity').fill('0.8');
    await expect(page.locator('.opacity b')).toHaveText('80%');
    await expect(page.locator('.layer .tag')).toHaveCount(5);
  });

  test('table register filters and opens a table on the keyplan', async ({ page }) => {
    await page.goto('./#/mechanical');
    await page.getByRole('searchbox', { name: 'Table ID' }).fill('M02-13-012');
    await page.locator('table.data tbody tr').first().click();
    await expect(page.locator('.td-id')).toHaveText('M02-13-012');
  });
});

test.describe('workflow: submit → verify → inspect → rectify → approve', () => {
  test.skip(readonly, 'changes records');
  let code = '';
  test.beforeAll(async () => {
    // any untouched table, assigned to TECHNO for both disciplines through the API (as the PIC/CM would)
    const c = await api();
    const subs = (await c.from('subcontractors').select('id, code')).data!;
    const techno = subs.find((s: any) => s.code === 'TECHNO').id;
    const v = await allState(c);
    const t = v.find((r: any) => r.mms_work === 'not_started' && r.pv_work === 'not_started' && !r.has_exception && r.table_code && !r.id_flags.length && r.mms_open_punch === 0);
    for (const d of ['MMS', 'PV']) {
      const { error } = await c.rpc('set_assignment', { p_tables: [t.id], p_discipline: d, p_subcon: techno });
      if (error) throw error;
    }
    code = t.table_code;
  });

  test('subcontractor reports, engineer verifies, QA/QC inspects and approves', async ({ browser }) => {
    const sub = await browser.newPage(); await login(sub, 'techno@example.com');
    await openTable(sub, code);
    await sub.getByRole('tab', { name: 'Mounting structure' }).click();
    await sub.getByRole('radio', { name: 'Completed' }).click();
    await sub.getByRole('button', { name: 'Submit for verification' }).click();
    await toast(sub, 'Submitted for verification');
    await expect(sub.getByText('Waiting for verification:')).toBeVisible();

    const site = await browser.newPage(); await login(site, 'site@example.com');
    await expect(site.getByText('Accomplishments waiting for verification')).toBeVisible();
    const row = site.locator('table.data tr', { hasText: code });
    await row.getByRole('button', { name: 'Verify' }).click();
    await toast(site, 'Verified');

    await sub.reload(); await openTable(sub, code);
    await sub.getByRole('tab', { name: 'Mounting structure' }).click();
    await expect(sub.locator('.disc header h4')).toContainText('Completed');
    await sub.getByRole('button', { name: 'Submit for inspection' }).click();
    await sub.getByRole('button', { name: 'Send request' }).click();
    await toast(sub, 'Inspection requested');

    const qa = await browser.newPage(); await login(qa, 'qaqc@example.com');
    await openTable(qa, code);
    await qa.getByRole('tab', { name: 'Mounting structure' }).click();
    await qa.getByRole('button', { name: 'Record inspection result' }).click();
    await qa.locator('.modal').getByRole('button', { name: 'Failed' }).click();
    await qa.getByLabel('Rectification items, one per line').fill('Re-torque purlin bolts\nReplace damaged clamp');
    await qa.locator('.modal').getByRole('button', { name: 'Record result' }).click();
    await toast(qa, 'For Rectification');

    await sub.reload(); await openTable(sub, code);
    await sub.getByRole('tab', { name: 'Mounting structure' }).click();
    await expect(sub.getByText('Re-torque purlin bolts')).toBeVisible();
    await sub.getByRole('button', { name: 'Mark all rectified' }).click();
    await toast(sub, 'resubmitted');

    await qa.reload(); await openTable(qa, code);
    await qa.getByRole('tab', { name: 'Mounting structure' }).click();
    await qa.getByRole('button', { name: 'Record inspection result' }).click();
    await qa.locator('.modal').getByRole('button', { name: 'Record result' }).click();
    await toast(qa, 'Inspection passed');
    await qa.getByRole('button', { name: 'Record approval' }).click();
    await qa.getByLabel('Approved by').fill('Client representative');
    await qa.locator('.modal').getByRole('button', { name: 'Record approval' }).click();
    await toast(qa, 'Approval recorded');
    await expect(qa.locator('.disc header h4')).toContainText('Approved');

    // history shows who changed what
    await qa.getByRole('tab', { name: 'History' }).click();
    await expect(qa.locator('.timeline')).toContainText('Accomplishment verified');
    await expect(qa.locator('.timeline')).toContainText('Approved');
  });

  test('PV modules are recorded individually on the 4 × 7 grid (after the structure is complete)', async ({ page }) => {
    await login(page, 'site@example.com');
    await openTable(page, code);
    await page.getByRole('tab', { name: 'PV modules' }).click();
    for (const n of [1, 2, 3, 8]) await page.locator('.td-body .modgrid').last().getByRole('button', { name: new RegExp(`^Module ${n},`) }).click();
    await page.getByRole('button', { name: 'Save progress' }).click();
    await toast(page, 'Progress saved');
    await expect(page.locator('.disc .modgrid-note').first()).toContainText('4/28 installed');
  });

  test('photo upload attaches a file to the table', async ({ page }) => {
    await login(page, 'site@example.com');
    await openTable(page, code);
    await page.getByRole('tab', { name: /^Files/ }).click();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await page.locator('input[type=file][multiple]').setInputFiles({ name: 'site-photo.png', mimeType: 'image/png', buffer: png });
    await toast(page, 'Uploaded site-photo.png');
    await expect(page.locator('figure')).toHaveCount(1);
  });

  test('a constraint recorded on site appears on the table', async ({ page }) => {
    await login(page, 'site@example.com');
    await openTable(page, code);
    await page.getByRole('button', { name: 'Record constraint' }).click();
    await page.locator('.modal').getByRole('button', { name: 'pile refusal' }).click();
    await page.getByLabel('What is holding the work?').fill('Two piles refused at 1.2 m');
    await page.locator('.modal').getByRole('button', { name: 'Record constraint' }).click();
    await toast(page, 'Constraint recorded');
    await expect(page.getByText('Two piles refused at 1.2 m')).toBeVisible();
  });

  test('planner sets weekly targets and milestones', async ({ page }) => {
    await login(page, 'planner@example.com');
    await page.getByRole('button', { name: 'Set target' }).click();
    await page.getByLabel('Tables to complete').fill('25');
    await page.locator('.modal').getByRole('button', { name: 'Save target' }).click();
    await toast(page, 'Target saved');
    await page.getByRole('button', { name: 'Add milestone' }).click();
    await page.locator('.modal').getByLabel('Name').fill('Block M01 PV mechanical completion');
    await page.locator('.modal').getByLabel('Planned').fill('2026-12-20');
    await page.locator('.modal').getByRole('button', { name: 'Save milestone' }).click();
    await toast(page, 'Milestone saved');
    await expect(page.getByText('Block M01 PV mechanical completion')).toBeVisible();
  });
});

test.describe('access control', () => {
  test('subcontractor cannot see or act on another company’s table', async ({ page }) => {
    const c = await api();
    const subs = (await c.from('subcontractors').select('id, code')).data!;
    const jjc = subs.find((s: any) => s.code === 'JJC').id;
    const v = await allState(c);
    const other = v.find((r: any) => r.mms_subcon === jjc && r.pv_subcon === jjc && r.table_code);
    await login(page, 'techno@example.com');
    await openTable(page, other.table_code);
    await page.getByRole('tab', { name: 'Mounting structure' }).click();
    await expect(page.getByText('Not assigned to your company')).toBeVisible();
  });
});

test.describe('password reset link', () => {
  test('an expired link explains itself on the sign-in page', async ({ page }) => {
    await page.goto('./#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Email link is invalid or has expired');
    expect(page.url()).not.toContain('error_description');
  });

  test('a recovery link signs the user in and asks for a new password', async ({ page }) => {
    test.skip(readonly || !process.env.SUPABASE_SERVICE_ROLE_KEY, 'changes a password: test database only');
    const { createClient } = await import('@supabase/supabase-js');
    const svc = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const email = 'pm@example.com';
    const appUrl = new URL('./', test.info().project.use.baseURL).href;
    const { data, error } = await svc.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: appUrl } });
    if (error) throw error;
    try {
      // the local auth server omits the /auth/v1 prefix that hosted Supabase includes
      await page.goto(data.properties.action_link.replace(/^(https?:\/\/[^/]+)\/verify/, '$1/auth/v1/verify'));
      await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible({ timeout: 30_000 });
      await page.getByLabel('New password', { exact: true }).fill('Temporary-pass-123');
      await page.getByLabel('Repeat the new password').fill('Temporary-pass-1234');
      await page.getByRole('button', { name: 'Save the new password' }).click();
      await expect(page.getByRole('alert')).toContainText('different');
      await page.getByLabel('Repeat the new password').fill('Temporary-pass-123');
      await page.getByRole('button', { name: 'Save the new password' }).click();
      await toast(page, 'Password changed');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Project status');
      // the new password works
      const c = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
      const r = await c.auth.signInWithPassword({ email, password: 'Temporary-pass-123' });
      expect(r.error).toBeNull();
    } finally {
      const { data: list } = await svc.auth.admin.listUsers({ perPage: 200 });
      const u = list.users.find((x) => x.email === email)!;
      await svc.auth.admin.updateUserById(u.id, { password: pw(email) }); // restore the demo password
    }
  });
});

test.describe('reports, QA/QC, subcontractors and administration', () => {
  test('reports export to Excel and PDF', async ({ page }) => {
    await login(page, 'pm@example.com');
    await page.getByRole('tab', { name: 'Reports' }).click();
    for (const kind of ['Daily construction progress report', 'Subcontractor accomplishment report', 'Punch-list register']) {
      await page.getByLabel('Report').selectOption({ label: kind });
      const [x] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel' }).click()]);
      expect(x.suggestedFilename()).toMatch(/\.xlsx$/);
      const [p] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).click()]);
      expect(p.suggestedFilename()).toMatch(/\.pdf$/);
    }
  });

  test('QA/QC queues load and subcontractor comparison opens a company dashboard', async ({ page }) => {
    await login(page, 'qaqc@example.com');
    await page.goto('./#/qaqc');
    await expect(page.getByRole('tab', { name: /Inspection requests/ })).toBeVisible();
    await page.getByRole('tab', { name: /Inspection log/ }).click();
    await page.goto('./#/subcontractors');
    await page.locator('table.data tr', { hasText: 'SAL' }).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('SAL');
    await expect(page.getByText('Total assigned tables').first()).toBeVisible();
  });

  test('administrator sees users, the import report, the drone fit and the audit trail', async ({ page }) => {
    await login(page, 'admin@example.com');
    await page.goto('./#/admin?tab=users');
    await expect(page.getByText('qaqc@example.com')).toBeVisible();
    await page.getByRole('tab', { name: 'Drawings and import' }).click();
    await expect(page.getByText('EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg').first()).toBeVisible();
    await expect(page.locator('table.data').getByText('DUPLICATE_ID').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Drone layer' }).click();
    await expect(page.getByText('Ground resolution')).toBeVisible();
    await page.getByRole('tab', { name: 'Audit trail' }).click();
    await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();
    await page.getByRole('tab', { name: 'Permissions' }).click();
    await expect(page.getByText('Record client/final approval')).toBeVisible();
  });
});
