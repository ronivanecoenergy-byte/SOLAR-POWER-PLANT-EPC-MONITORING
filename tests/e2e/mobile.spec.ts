import { expect, test } from '@playwright/test';
import { login, openTable } from './helpers';

test.describe('mobile field use', () => {
  test('site engineer opens a table from search and sees large status buttons', async ({ page }) => {
    await login(page, 'site@example.com');
    await expect(page.locator('.tabbar')).toBeVisible();
    await page.locator('.tabbar').getByRole('link', { name: 'Keyplan' }).click();
    await page.getByLabel('Search by Table ID').fill('M04-11-07');
    await page.keyboard.press('Enter');
    await expect(page.locator('.td-id')).toHaveText('M04-11-07');
    await page.getByRole('tab', { name: 'PV modules' }).click();
    const box = await page.locator('.td-body').boundingBox();
    expect(box!.width).toBeGreaterThan(300);
    await expect(page.locator('.modgrid').first()).toBeVisible();
  });

  test('layers sheet opens from the map', async ({ page }) => {
    await login(page, 'site@example.com');
    await page.goto('./#/keyplan');
    await page.getByRole('button', { name: 'Layers and legend' }).click();
    await expect(page.locator('.kp-rail.open')).toBeVisible();
    await expect(page.getByText('Colour tables by')).toBeVisible();
  });

  test('deep link to a table works on a phone', async ({ page }) => {
    await login(page, 'techno@example.com');
    await openTable(page, 'M04-11-07');
    await expect(page.locator('.kp-panel')).toBeVisible();
  });
});
