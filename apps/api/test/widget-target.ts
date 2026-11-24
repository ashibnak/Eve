/**
 * Test-only import target ("a test module" in the S3 done-when): widgets per company in the
 * test_widget table that the test harness creates. Shows what a real module plugs in.
 */
import { z } from 'zod';
import type { AuditService } from '../src/platform/audit/audit.service';
import type { RoleDefinition } from '../src/platform/auth/roles';
import {
  type DiffEntry,
  defineImportTarget,
  type Finding,
  type ImportTarget,
} from '../src/platform/connectors/import-target';
import type { PrismaService } from '../src/platform/db/prisma.service';

export const WIDGET_IMPORT_PERMISSION = 'test.widgets.import';

export const WidgetImporterRole: RoleDefinition = {
  name: 'test_widget_importer',
  permissions: [WIDGET_IMPORT_PERMISSION],
  allowedScopes: ['customer', 'company'],
};

interface WidgetRow {
  code: string;
  name: string;
  price: number;
  launched: string | null;
}

export function widgetTarget(
  prisma: PrismaService,
  audit: AuditService,
  options: { name?: string; approvalChain?: string[] } = {},
): ImportTarget {
  const current = async (companyId: string): Promise<Map<string, WidgetRow>> => {
    const rows = await prisma.$queryRaw<
      { code: string; name: string; price: number; launched: Date | null }[]
    >`
      SELECT code, name, price, launched FROM test_widget WHERE company_id = ${companyId}::uuid`;
    return new Map(
      rows.map((r) => [
        r.code,
        {
          code: r.code,
          name: r.name,
          price: r.price,
          launched: r.launched?.toISOString().slice(0, 10) ?? null,
        },
      ]),
    );
  };
  const fromStaged = (values: Record<string, unknown>): WidgetRow => ({
    code: values.code as string,
    name: values.name as string,
    price: values.price as number,
    launched: (values.launched as string | undefined) ?? null,
  });

  return defineImportTarget({
    name: options.name ?? 'test.widget',
    permission: WIDGET_IMPORT_PERMISSION,
    ...(options.approvalChain ? { approvalChain: options.approvalChain } : {}),
    entities: [
      {
        name: 'widget',
        key: 'code',
        fields: [
          { key: 'code', kind: 'code', required: true, aliases: ['کد'] },
          { key: 'name', kind: 'text', required: true, aliases: ['نام'] },
          {
            key: 'price',
            kind: 'number',
            required: true,
            schema: z.number().int().min(0),
            aliases: ['قیمت'],
          },
          { key: 'launched', kind: 'date', required: false, aliases: ['تاریخ عرضه'] },
        ],
      },
    ],

    async validate(rows, ctx) {
      const findings: Finding[] = [];
      const existing = await current(ctx.companyId);
      const names = new Map<string, string>();
      for (const row of rows) {
        const widget = fromStaged(row.values);
        // Blocking: two widgets may not share a name.
        const other = names.get(widget.name);
        if (other && other !== widget.code) {
          findings.push({
            severity: 'blocking',
            code: 'duplicate_name',
            message: `"${widget.name}" is used by ${other} and ${widget.code}`,
            entity: 'widget',
            key: widget.code,
            rowNumber: row.rowNumber,
          });
        }
        names.set(widget.name, widget.code);
        // Warning: a price falling by more than half deserves a second look.
        const before = existing.get(widget.code);
        if (before && widget.price < before.price / 2) {
          findings.push({
            severity: 'warning',
            code: 'price_drop',
            message: `${widget.code}: price ${before.price} → ${widget.price}`,
            entity: 'widget',
            key: widget.code,
            rowNumber: row.rowNumber,
          });
        }
      }
      return findings;
    },

    async diff(rows, ctx) {
      const existing = await current(ctx.companyId);
      const diff: DiffEntry[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const after = fromStaged(row.values);
        const before = existing.get(after.code) ?? null;
        seen.add(after.code);
        const kind = !before
          ? 'added'
          : JSON.stringify(before) === JSON.stringify(after)
            ? 'unchanged'
            : 'changed';
        diff.push({
          entity: 'widget',
          key: after.code,
          kind,
          before,
          after,
          rowNumber: row.rowNumber,
        });
      }
      for (const [code, before] of [...existing].sort(([a], [b]) => a.localeCompare(b))) {
        if (!seen.has(code))
          diff.push({ entity: 'widget', key: code, kind: 'removed', before, after: null });
      }
      return diff;
    },

    async commit(tx, _rows, diff, ctx) {
      for (const entry of diff) {
        if (entry.kind === 'unchanged') continue;
        const after = entry.after as WidgetRow | null;
        if (entry.kind === 'removed') {
          await tx.$executeRaw`DELETE FROM test_widget WHERE company_id = ${ctx.companyId}::uuid AND code = ${entry.key}`;
        } else if (after) {
          await tx.$executeRaw`
            INSERT INTO test_widget (company_id, code, name, price, launched)
            VALUES (${ctx.companyId}::uuid, ${after.code}, ${after.name}, ${after.price}, ${after.launched}::date)
            ON CONFLICT (company_id, code) DO UPDATE
              SET name = EXCLUDED.name, price = EXCLUDED.price, launched = EXCLUDED.launched`;
        }
        await audit.record(tx, {
          action: `test.widget.${entry.kind === 'added' ? 'create' : entry.kind === 'removed' ? 'remove' : 'update'}`,
          entityType: 'test_widget',
          entityId: entry.key,
          companyId: ctx.companyId,
          before: entry.before,
          after: entry.after,
          reason: `import ${ctx.importId}`,
        });
      }
    },
  });
}
