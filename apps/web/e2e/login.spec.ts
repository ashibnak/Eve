import { expect, type Page, test } from '@playwright/test';
import fa from '../src/i18n/fa.json' with { type: 'json' };

const ME = { id: 'u1', username: 'ashkan', roles: [] };

/** A fake API: password `right-password`, code `123456`. Records the bodies it receives. */
async function mockAuthApi(page: Page) {
  const received: { path: string; body: unknown }[] = [];
  let signedIn = false;
  await page.route('**/api/v1/auth/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const body = request.postDataJSON() as Record<string, string> | null;
    received.push({ path, body });
    if (path === '/auth/me') {
      return signedIn
        ? route.fulfill({ json: ME })
        : route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
    }
    if (path === '/auth/login') {
      return body?.password === 'right-password'
        ? route.fulfill({ json: { stage: 'code_sent', sentTo: '…4567' } })
        : route.fulfill({ status: 401, json: { error: 'invalid_credentials' } });
    }
    if (path === '/auth/code') {
      if (body?.code !== '123456')
        return route.fulfill({ status: 401, json: { error: 'invalid_code' } });
      signedIn = true;
      return route.fulfill({ json: { id: ME.id, username: ME.username } });
    }
    if (path === '/auth/logout') {
      signedIn = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404 });
  });
  return received;
}

test('signs in with password and one-time code, then signs out', async ({ page }) => {
  const received = await mockAuthApi(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fa['auth.login.title']);
  await page.getByLabel(fa['auth.login.username']).fill('ashkan');
  await page.getByLabel(fa['auth.login.password']).fill('right-password');
  await page.getByRole('button', { name: fa['auth.login.submit'] }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fa['auth.code.title']);
  await expect(page.getByText(fa['auth.code.help'].replace('{sentTo}', '…4567'))).toBeVisible();

  // A wrong code shows an error and keeps the code step.
  await page.getByLabel(fa['auth.code.label']).fill('000000');
  await page.getByRole('button', { name: fa['auth.code.submit'] }).click();
  await expect(page.getByRole('alert')).toContainText(fa['auth.error.invalid_code']);

  // Persian digits are accepted and sent as ASCII.
  await page.getByLabel(fa['auth.code.label']).fill('۱۲۳۴۵۶');
  await page.getByRole('button', { name: fa['auth.code.submit'] }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fa['app.shell.title']);
  expect(
    received.find((r) => r.path === '/auth/code' && (r.body as { code: string }).code === '123456'),
  ).toBeTruthy();

  await page.getByRole('button', { name: fa['app.user.logout'] }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fa['auth.login.title']);
});

test('shows a clear error for a wrong password, with one red action on the page', async ({
  page,
}) => {
  await mockAuthApi(page);
  await page.goto('/');
  await page.getByLabel(fa['auth.login.username']).fill('ashkan');
  await page.getByLabel(fa['auth.login.password']).fill('wrong');
  await page.getByRole('button', { name: fa['auth.login.submit'] }).click();
  await expect(page.getByRole('alert')).toContainText(fa['auth.error.invalid_credentials']);

  const redButtons = await page
    .getByRole('button')
    .evaluateAll(
      (buttons) =>
        buttons.filter((b) => getComputedStyle(b).backgroundColor === 'rgb(192, 18, 33)').length,
    );
  expect(redButtons).toBe(1);
});
