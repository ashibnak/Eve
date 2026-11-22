import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createPlatform, type Platform, rawClient } from '../../../test/platform';

describe('audit log', () => {
  let platform: Platform;

  beforeAll(() => {
    platform = createPlatform(inject('db'));
  });

  afterAll(() => platform.close());

  function appendOne(reason: string) {
    return asUser(() =>
      platform.txRunner.run((tx) =>
        platform.audit.record(tx, {
          action: 'test.thing.change',
          entityType: 'thing',
          entityId: 't1',
          companyId: null,
          before: { n: 1 },
          after: { n: 2, big: 9007199254740993n },
          reason,
        }),
      ),
    );
  }

  it('chains every row to the previous one', async () => {
    const first = (await appendOne('a')).result;
    const second = (await appendOne('b')).result;
    const row = await platform.prisma.auditLog.findUniqueOrThrow({ where: { seq: second.seq } });
    expect(row.prevHash).toBe(first.hash);
    expect(row.after).toEqual({ n: 2, big: '9007199254740993' });
    expect(await platform.audit.verifyChain()).toMatchObject({ ok: true });
  });

  it('stays linear under concurrent appends', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendOne(`concurrent ${i}`)));
    expect(await platform.audit.verifyChain()).toMatchObject({ ok: true });
  });

  it('refuses an entry without a reason', async () => {
    await expect(appendOne('  ')).rejects.toThrow('reason');
  });

  it.each([
    ['UPDATE', 'UPDATE audit_log SET reason = $$x$$'],
    ['DELETE', 'DELETE FROM audit_log'],
    ['TRUNCATE', 'TRUNCATE audit_log'],
  ])('denies %s to the app role', async (_op, sql) => {
    const app = await rawClient(inject('db').appUrl);
    try {
      await expect(app.query(sql)).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });

  it('blocks UPDATE even for the owner (trigger)', async () => {
    const owner = await rawClient(inject('db').ownerUrl);
    try {
      await expect(owner.query('UPDATE audit_log SET reason = $$x$$')).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await owner.end();
    }
  });

  it('detects a tampered row', async () => {
    const { seq } = (await appendOne('original')).result;
    const owner = await rawClient(inject('db').ownerUrl);
    const tamper = async (reason: string) => {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
      await owner.query('UPDATE audit_log SET reason = $1 WHERE seq = $2', [
        reason,
        seq.toString(),
      ]);
      await owner.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');
      await owner.query('COMMIT');
    };
    try {
      await tamper('forged');
      expect(await platform.audit.verifyChain()).toMatchObject({
        ok: false,
        brokenAtSeq: seq,
        problem: 'hash',
      });
    } finally {
      await tamper('original'); // restore so later tests see an intact chain
      await owner.end();
    }
    expect(await platform.audit.verifyChain()).toMatchObject({ ok: true });
  });
});
