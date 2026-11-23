import { expect, type Page, test } from '@playwright/test';
import fa from '../src/i18n/fa.json' with { type: 'json' };

const ME = {
  id: 'u1',
  username: 'ashkan',
  roles: [{ role: 'system_admin', scopeKind: 'customer', companyId: null }],
};

async function mockSignedIn(page: Page) {
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: ME }));
}

test('signed-in shell renders in Persian, right-to-left, with the design-system font', async ({
  page,
}) => {
  await mockSignedIn(page);
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  await expect(page).toHaveTitle(fa['app.title']);
  await expect(page.getByTestId('brand')).toHaveText(fa['app.brand']);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fa['app.shell.title']);
  await expect(
    page.getByText(fa['app.user.signed_in_as'].replace('{username}', 'ashkan')),
  ).toBeVisible();

  const fontFamily = await page.locator('body').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(fontFamily).toContain('Vazirmatn');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('16px "Vazirmatn Variable"'))).toBe(true);

  // The side menu sits on the inline-start edge: the right side in RTL.
  const nav = await page.getByRole('navigation').boundingBox();
  const viewport = page.viewportSize();
  expect(nav && viewport && Math.round(nav.x + nav.width)).toBe(viewport?.width);
});
