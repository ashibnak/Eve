import { expect, test } from '@playwright/test';
import { FakeApi } from './fixtures/fake-api';

/**
 * S9 done-when: a 6,000-position chart opens in under 2 s (decision 2026-11-26: the whole
 * company loaded, top 3 levels open, interactive). Measured from navigation to the chart's ready
 * signal over 5 runs; the median is held to 2 s, the worst and the fully expanded chart are
 * reported.
 */
test('a 6,000-position chart opens in under 2 s', async ({ page }) => {
  test.setTimeout(180_000);
  const api = new FakeApi(6000);
  expect(api.company.structure.positions).toHaveLength(6000);
  await api.install(page);
  const measure = async (path: string) => {
    const started = Date.now();
    await page.goto(path);
    await expect(page.getByTestId('org-chart')).toHaveAttribute('data-ready', 'true', {
      timeout: 60_000,
    });
    return Date.now() - started;
  };
  await measure('/chart'); // warm-up: the browser caches the app bundle once
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) runs.push(await measure('/chart'));
  runs.sort((a, b) => a - b);
  const median = runs[2]!;
  const nodes = Number(await page.getByTestId('org-chart').getAttribute('data-nodes'));
  const full = await measure('/chart?levels=99');
  const fullNodes = Number(await page.getByTestId('org-chart').getAttribute('data-nodes'));
  console.info(
    `chart 6,000 positions: median ${median} ms, worst ${runs[4]} ms, ${nodes} nodes open; fully expanded ${full} ms (${fullNodes} nodes)`,
  );
  expect(fullNodes).toBe(6000);
  expect(median).toBeLessThan(2000);
});
