import { expect, type Page, test } from '@playwright/test';
import fa from '../src/i18n/fa.json' with { type: 'json' };
import { FakeApi, type Persona } from './fixtures/fake-api';

type Key = keyof typeof fa;
const text = (key: Key, params: Record<string, string> = {}) =>
  fa[key].replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m);

async function open(page: Page, api: FakeApi, persona: Persona, path = '/') {
  api.persona = persona;
  await page.goto(path);
  await expect(page.getByTestId('brand')).toBeVisible();
}

/** Design system: at most one red primary action in the content of a view. */
async function expectOneRedAction(page: Page) {
  const red = page.locator('main').locator('button.bg-red:visible, a.bg-red:visible');
  expect(await red.count()).toBeLessThanOrEqual(1);
}

/** No i18n key may reach the screen untranslated (e.g. "changes.op.add"). */
async function expectNoRawKeys(page: Page) {
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(
    /\b(?:app|nav|ui|org|chart|positions|card|findings|changes|import|setup|inbox|me|approvals|roles)\.[a-z_]+(?:\.[a-z_]+)*\b/,
  );
}

const menu = (page: Page) => page.getByRole('navigation');

test.describe('org pages (S9 happy paths, mocked API from contract fixtures)', () => {
  let api: FakeApi;

  test.beforeEach(async ({ page }) => {
    api = new FakeApi(60);
    await api.install(page);
  });

  test('data owner: menu by role, chart, as-of date, position card and correction', async ({
    page,
  }) => {
    await open(page, api, 'owner');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    for (const key of [
      'nav.inbox',
      'nav.chart',
      'nav.positions',
      'nav.findings',
      'nav.changes',
      'nav.import',
    ] as const) {
      await expect(menu(page).getByRole('link', { name: text(key) })).toBeVisible();
    }
    await expect(menu(page).getByRole('link', { name: text('nav.setup') })).toHaveCount(0);
    await expectOneRedAction(page);

    await menu(page)
      .getByRole('link', { name: text('nav.chart') })
      .click();
    const chart = page.getByTestId('org-chart');
    await expect(chart).toHaveAttribute('data-ready', 'true');
    const before = Number(await chart.getAttribute('data-nodes'));
    // Open a closed manager: more positions appear.
    await page
      .getByRole('button', { name: /باز کردن/ })
      .first()
      .click();
    await expect
      .poll(async () => Number(await chart.getAttribute('data-nodes')))
      .toBeGreaterThan(before);
    await expectNoRawKeys(page);

    // A month earlier the structure was smaller.
    const total = api.company.structure.positions.length;
    await expect(page.getByText(new RegExp(`${total.toLocaleString('fa-IR')} پست`))).toBeVisible();
    await page.getByLabel(text('app.as_of')).fill('۱۴۰۵/۰۷/۳۰');
    await page.getByLabel(text('app.as_of')).press('Enter');
    const earlier = api.company.earlier.positions.length;
    await expect(
      page.getByText(new RegExp(`${earlier.toLocaleString('fa-IR')} پست`)),
    ).toBeVisible();
    await page.getByLabel(text('app.as_of')).fill('2026-11-22');
    await page.getByLabel(text('app.as_of')).press('Enter');

    // Open a position card from the chart and correct its title with a reason.
    const target = api.company.structure.positions[1]!;
    await page.getByRole('button', { name: target.title.fa, exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(target.title.fa);
    await expectOneRedAction(page);
    await page.getByRole('button', { name: text('card.correct') }).click();
    await page.getByLabel(text('card.correct.title_fa')).fill('رئیس واحد اصلاح‌شده');
    await page.getByLabel(text('ui.reason')).fill('غلط تایپی');
    await page.getByRole('button', { name: text('card.correct.submit') }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('رئیس واحد اصلاح‌شده');
    const correction = api.calls.find((c) => c.path.endsWith('/corrections'));
    expect(correction?.body).toMatchObject({
      versionFrom: '2020-01-01',
      changes: { titleFa: 'رئیس واحد اصلاح‌شده' },
      reason: 'غلط تایپی',
    });
  });

  test('positions table filters and offers the Excel export', async ({ page }) => {
    await open(page, api, 'owner', '/positions');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(text('positions.title'));
    const rows = page.getByRole('table').locator('tbody tr[aria-rowindex]');
    await expect(rows.first()).toBeVisible();
    await page.getByLabel(text('positions.filter')).selectOption('vacant');
    const vacant = api.company.structure.positions.filter((p) => p.occupancy === 'vacant').length;
    await expect(
      page.getByText(
        text('positions.status', {
          shown: vacant.toLocaleString('fa-IR'),
          total: api.company.structure.positions.length.toLocaleString('fa-IR'),
        }),
      ),
    ).toBeVisible();
    const exportLink = page.getByRole('link', { name: text('positions.export') });
    await expect(exportLink).toHaveAttribute('href', /positions\.xlsx\?asOf=2026-/);
    await expectOneRedAction(page);
  });

  test('findings inbox: blocking first; a warning accepted with a reason leaves the open list', async ({
    page,
  }) => {
    await open(page, api, 'owner', '/findings');
    const items = page.getByRole('list', { name: text('findings.title') }).getByRole('listitem');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText(text('org.finding.severity.blocking'));
    const accept = page.getByRole('button', { name: text('findings.accept') });
    await expect(accept).toBeDisabled();
    await items.nth(1).getByRole('button').first().click();
    await accept.click();
    await page.getByLabel(text('ui.reason')).fill('تصمیم هیئت‌مدیره');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: text('findings.accept') })
      .click();
    await expect(items).toHaveCount(2);
    expect(api.findings[1]!.status).toBe('accepted');
    await expectOneRedAction(page);
  });

  test('change request: owner submits, approver returns, owner resubmits, approver approves', async ({
    page,
  }) => {
    await open(page, api, 'owner', '/changes/new');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(text('changes.new.title'));
    await page.getByLabel(text('ui.reason')).fill('ایجاد واحد تحلیل داده');
    await page.getByLabel(text('changes.op.add_kind')).selectOption('unit.create');
    await page.getByRole('button', { name: text('changes.op.add') }).click();
    const op = page.getByTestId('operation').first();
    await op.getByLabel(text('changes.op.unit_name')).fill('تحلیل داده');
    await op
      .getByLabel(text('changes.op.level'))
      .selectOption({ label: api.company.levels[1]!.nameFa });
    await op
      .getByLabel(text('changes.op.parent'))
      .selectOption({ label: api.company.structure.units[0]!.name.fa });
    await page.getByLabel(text('changes.op.add_kind')).selectOption('position.update');
    await page.getByRole('button', { name: text('changes.op.add') }).click();
    const move = page.getByTestId('operation').nth(1);
    const moved = api.company.structure.positions[4]!;
    await move.getByLabel(text('changes.op.position_code'), { exact: true }).fill(moved.code);
    await move
      .getByLabel(text('changes.op.in_unit'))
      .selectOption({ label: text('changes.op.new_item', { name: 'تحلیل داده' }) });
    await expect(page.getByTestId('org-chart')).toHaveAttribute('data-ready', 'true');
    await expectOneRedAction(page);
    await page.getByRole('button', { name: text('changes.submit') }).click();

    await expect(page.getByTestId('impact')).toContainText(
      text('changes.impact.orders', { count: '۱' }),
    );
    const submitted = api.calls.find(
      (c) => c.method === 'POST' && c.path === '/org/change-requests',
    )!.body as { operations: unknown[] };
    expect(submitted.operations).toEqual([
      {
        op: 'unit.create',
        ref: 'u1',
        nameFa: 'تحلیل داده',
        levelId: api.company.levels[1]!.id,
        parent: { id: api.company.structure.units[0]!.id },
      },
      { op: 'position.update', positionId: moved.id, changes: { unit: { ref: 'u1' } } },
    ]);
    const requestPath = new URL(page.url()).pathname;

    // The approver finds it in the inbox, follows the chain and returns it with a note.
    await open(page, api, 'approver');
    await page
      .getByRole('list', { name: text('inbox.waiting.title') })
      .getByRole('button')
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`${requestPath}$`));
    await expect(page.getByRole('list', { name: text('changes.chain') })).toContainText(
      text('roles.org_change_approver'),
    );
    await expectOneRedAction(page);
    await page.getByRole('button', { name: text('changes.return') }).click();
    await page.getByLabel(text('changes.note_label')).fill('نام واحد را دقیق‌تر بنویسید');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: text('changes.return') })
      .click();
    await expect(page.getByText(/نام واحد را دقیق‌تر بنویسید/)).toBeVisible();

    // The owner edits and sends it again.
    await open(page, api, 'owner', requestPath);
    await page.getByRole('button', { name: text('changes.edit_and_resubmit') }).click();
    await page.getByLabel(text('changes.op.add_kind')).selectOption('unit.create');
    await page.getByRole('button', { name: text('changes.op.add') }).click();
    const again = page.getByTestId('operation').first();
    await again.getByLabel(text('changes.op.unit_name')).fill('تحلیل داده و هوش تجاری');
    await again
      .getByLabel(text('changes.op.level'))
      .selectOption({ label: api.company.levels[1]!.nameFa });
    await again
      .getByLabel(text('changes.op.parent'))
      .selectOption({ label: api.company.structure.units[0]!.name.fa });
    await page.getByRole('button', { name: text('changes.resubmit') }).click();
    await expect.poll(() => api.approvals[0]!.status).toBe('pending');

    // The approver approves: applied.
    await open(page, api, 'approver', requestPath);
    await page.getByRole('button', { name: text('changes.approve') }).click();
    await expect.poll(() => api.changeRequests[0]!.status).toBe('applied');
  });

  test('import wizard: upload, mapping, checks, preview and commit', async ({ page }) => {
    await open(page, api, 'owner', '/import');
    await page.getByLabel(text('import.file'), { exact: true }).setInputFiles({
      name: 'structure.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('fake'),
    });
    const next = (key: Key) => page.getByRole('button', { name: text(key) });
    await next('import.upload').click();
    await expect(page.getByRole('heading', { name: /واحدها/ })).toBeVisible();
    await next('import.use_mapping').click();
    await next('import.validate').click();
    await expect(page.getByText('R6: unit U3, no_supervisor')).toBeVisible();
    await next('import.preview').click();
    await expect(page.getByTestId('import-counts')).toContainText('۱۲۰');
    await page.getByLabel(text('ui.reason')).fill('بارگذاری نخست');
    await expectOneRedAction(page);
    await next('import.commit').click();
    await expect(page.getByTestId('import-result')).toContainText(
      text('import.committed', { date: '' }).trim().slice(0, 10),
    );
    const upload = api.calls.find((c) => c.method === 'POST' && c.path === '/platform/imports');
    expect(upload).toBeDefined();
  });

  test('system admin sets up the company; other roles do not see setup', async ({ page }) => {
    await open(page, api, 'admin', '/setup');
    await expect(menu(page).getByRole('link', { name: text('nav.setup') })).toBeVisible();
    await expect(page.getByLabel(text('setup.prefix'))).toHaveValue('TST');
    await page.getByLabel(text('setup.name_fa')).fill('شرکت آزمایشی نو');
    await page.getByRole('button', { name: text('setup.level.add') }).click();
    await page
      .getByLabel(text('setup.level', { rank: String(api.company.levels.length + 1) }))
      .fill('زیرگروه');
    await expectOneRedAction(page);
    await page.getByRole('button', { name: text('setup.save') }).click();
    await expect(page.getByText(text('setup.saved'))).toBeVisible();
    expect(api.profileSaved).toMatchObject({ nameFa: 'شرکت آزمایشی نو', codePrefix: 'TST' });
    const levels = api.calls.find((c) => c.path.endsWith('/unit-levels'))!.body as {
      levels: { nameFa: string }[];
    };
    expect(levels.levels.at(-1)).toEqual({ nameFa: 'زیرگروه' });

    await open(page, api, 'owner');
    await expect(menu(page).getByRole('link', { name: text('nav.setup') })).toHaveCount(0);
  });

  test('an employee sees only their own position and manager', async ({ page }) => {
    await open(page, api, 'employee');
    await expect(menu(page).getByRole('link', { name: text('nav.me') })).toBeVisible();
    for (const key of [
      'nav.chart',
      'nav.positions',
      'nav.findings',
      'nav.changes',
      'nav.import',
    ] as const) {
      await expect(menu(page).getByRole('link', { name: text(key) })).toHaveCount(0);
    }
    await menu(page)
      .getByRole('link', { name: text('nav.me') })
      .click();
    await expect(page.getByTestId('my-position')).toContainText(
      text('org.assignment.kind.primary'),
    );
    await expect(page.getByTestId('my-manager')).toHaveText(
      text('me.manager.primary', { levels: '1' }),
    );
    await expectNoRawKeys(page);
  });
});
