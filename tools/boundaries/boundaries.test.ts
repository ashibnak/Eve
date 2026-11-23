/**
 * Proves the module boundary rules in .dependency-cruiser.cjs fire (S0 "done when": a deliberate
 * boundary violation fails CI). Each fixture is a miniature repo; the real config and CLI run
 * against it exactly as `pnpm boundaries` does on the real tree.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = join(root, 'tools/boundaries/__fixtures__');
const cli = join(root, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const config = join(root, '.dependency-cruiser.cjs');

interface Violation {
  rule: { name: string; severity: string };
  from: string;
  to: string;
}

function run(fixture: string, outputType: 'json' | 'err') {
  const cwd = join(fixtures, fixture);
  const targets = readdirSync(cwd); // e.g. ["apps", "packages"]
  return spawnSync(
    process.execPath,
    [cli, ...targets, '--config', config, '--output-type', outputType],
    {
      cwd,
      encoding: 'utf8',
    },
  );
}

/** Rule names from the JSON report; exit code from the `err` reporter that `pnpm boundaries` uses. */
function cruise(fixture: string): { exitCode: number | null; violations: Violation[] } {
  const json = run(fixture, 'json');
  if (!json.stdout) throw new Error(`dependency-cruiser produced no output: ${json.stderr}`);
  const report = JSON.parse(json.stdout) as { summary: { violations: Violation[] } };
  return { exitCode: run(fixture, 'err').status, violations: report.summary.violations };
}

describe('module boundaries', () => {
  it('accept the allowed shape: adapter -> other module public service, self-contained port', () => {
    const { exitCode, violations } = cruise('clean');
    expect(violations).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it.each([
    ['platform-to-packs', 'platform-not-to-packs'],
    ['pack-internals', 'pack-module-isolation'],
    ['port-to-service', 'pack-module-isolation'],
    ['adapter-to-internals', 'adapters-only-public-service'],
    ['package-to-app', 'packages-not-to-apps'],
    ['circular', 'no-circular'],
    ['pack-raw-prisma', 'packs-no-raw-prisma'],
  ])('fixture %s fails with rule %s', (fixture, rule) => {
    const { exitCode, violations } = cruise(fixture);
    expect(violations.map((v) => v.rule.name)).toContain(rule);
    expect(exitCode).not.toBe(0);
  });
});
