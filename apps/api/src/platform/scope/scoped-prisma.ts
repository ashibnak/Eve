import type { PrismaService } from '../db/prisma.service';
import type { ResolvedScope } from './access.service';

/** How a model is scoped: its company column and, for org-shaped data, its unit column. */
export interface ScopedModel {
  companyField: string;
  unitField?: string;
}

/**
 * Models readable through the scope layer. Rows with a null company are customer-wide and visible
 * only to a customer-wide scope. Packs add their models here when they register their tables.
 */
export const SCOPED_MODELS: Record<string, ScopedModel> = {
  CoreCompany: { companyField: 'id' },
  ConfigSetting: { companyField: 'companyId' },
  AuditLog: { companyField: 'companyId' },
};

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** The row filter a scope implies for one model (exported for unit tests). */
export function scopeFilter(
  model: ScopedModel,
  scope: ResolvedScope,
): Record<string, unknown> | null {
  if (scope.customerWide) return null;
  const visible: Record<string, unknown>[] = [
    { [model.companyField]: { in: [...scope.companyIds] } },
  ];
  if (model.unitField && scope.unitIds.size > 0) {
    visible.push({ [model.unitField]: { in: [...scope.unitIds] } });
  }
  return visible.length === 1 ? (visible[0] ?? null) : { OR: visible };
}

/**
 * A read-only Prisma client restricted to a scope (CLAUDE.md rule 11). Every read on a scoped
 * model gets the scope's row filter; reading any other model, or writing, throws: writes go
 * through commands that check access explicitly.
 */
export function scopedPrisma(prisma: PrismaService, scope: ResolvedScope) {
  return prisma.$extends({
    name: 'eve-scope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          const scoped = SCOPED_MODELS[model];
          if (!scoped) throw new Error(`Model ${model} is not readable through the scope layer`);
          if (!READ_OPERATIONS.has(operation)) {
            throw new Error(`Scoped client is read-only (${model}.${operation})`);
          }
          const filter = scopeFilter(scoped, scope);
          if (!filter) return query(args);
          const where = (args as { where?: Record<string, unknown> }).where ?? {};
          const existingAnd = where.AND === undefined ? [] : [where.AND].flat();
          const scopedArgs = { ...args, where: { ...where, AND: [...existingAnd, filter] } };
          return query(scopedArgs as typeof args);
        },
      },
    },
  });
}

export type ScopedPrisma = ReturnType<typeof scopedPrisma>;
