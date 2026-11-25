import type { platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { type Tx } from '../context/tx-runner';
import { type CellValue } from './workbook';
import { normalizeCode, normalizeText, parseBoolean, parseDate, parseNumber } from './normalize';

/** How a cell is read before the field's own schema checks it. */
export type FieldKind = 'code' | 'text' | 'number' | 'boolean' | 'date';

export interface ImportField {
  key: string;
  kind: FieldKind;
  required: boolean;
  /** Validates the converted value (e.g. `z.number().min(0)`). */
  schema?: z.ZodType;
  /** Header texts suggested automatically for this field (besides the key). */
  aliases?: readonly string[];
}

/** One kind of record in the file, e.g. unit, position, assignment: usually one sheet each. */
export interface ImportEntity {
  name: string;
  fields: readonly ImportField[];
  /**
   * Field that identifies a record (legacy code, personnel code), or several fields together
   * (e.g. person + position + kind for assignments); unique within the file. The first one must
   * be a required field.
   */
  key: string | readonly string[];
}

/** The key fields of an entity, in order. */
export function keyFields(entity: ImportEntity): readonly string[] {
  return typeof entity.key === 'string' ? [entity.key] : entity.key;
}

/** A row's key: its key fields' values joined with "|" (empty when the first one is missing). */
export function rowKey(entity: ImportEntity, values: Record<string, unknown>): string {
  const parts = keyFields(entity).map((k) => (values[k] === undefined ? '' : String(values[k])));
  return parts[0] ? parts.join('|') : '';
}

export interface ImportContext {
  importId: string;
  companyId: string;
  effectiveDate: platformV1.BusinessDate;
  today: platformV1.BusinessDate;
}

/** A staged row after mapping and conversion. */
export interface StagedRow {
  entity: string;
  sheet: string;
  rowNumber: number;
  key: string;
  values: Record<string, unknown>;
}

export interface Finding {
  severity: 'blocking' | 'warning';
  code: string;
  message: string;
  entity?: string;
  key?: string;
  rowNumber?: number;
}

export interface DiffEntry {
  entity: string;
  key: string;
  kind: 'added' | 'changed' | 'removed' | 'unchanged';
  before: unknown;
  after: unknown;
  rowNumber?: number;
}

/**
 * What a module plugs into the file-import pipeline (ADR-011). The pipeline reads, maps, converts
 * and stages rows; the target owns the meaning: domain checks, the diff against current data and
 * the commit. `commit` runs inside the pipeline's transaction with source `file` and the import id
 * as action id, and must write its own audit rows.
 */
export interface ImportTarget {
  /** `<slug>.<subject>`, e.g. `people.person`, `org.structure`. */
  name: string;
  entities: readonly ImportEntity[];
  /** Permission needed (over the import's company) to run this import. */
  permission: string;
  /**
   * Default approval chain (role names) when committing must be approved; omitted = the data owner
   * commits directly. Registered as request type `<name>.import.commit`.
   */
  approvalChain?: readonly string[];
  /**
   * Whether this import's commit needs the approval chain (default: always, when there is one).
   * E.g. org: a company's first structure load is committed directly, a re-import is approved.
   */
  needsApproval?(context: ImportContext): Promise<boolean>;
  validate(rows: readonly StagedRow[], context: ImportContext): Promise<Finding[]>;
  diff(rows: readonly StagedRow[], context: ImportContext): Promise<DiffEntry[]>;
  commit(
    tx: Tx,
    rows: readonly StagedRow[],
    diff: readonly DiffEntry[],
    context: ImportContext,
  ): Promise<void>;
}

export function defineImportTarget(target: ImportTarget): ImportTarget {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(target.name)) {
    throw new Error(`Invalid import target name "${target.name}"`);
  }
  for (const entity of target.entities) {
    const [first, ...rest] = keyFields(entity);
    if (!entity.fields.some((f) => f.key === first && f.required)) {
      throw new Error(`${target.name}/${entity.name}: key field ${first} must be a required field`);
    }
    for (const key of rest) {
      if (!entity.fields.some((f) => f.key === key)) {
        throw new Error(`${target.name}/${entity.name}: key field ${key} is not a field`);
      }
    }
  }
  return target;
}

/** Converts one cell for a field; returns the value or an error message for the row. */
export function convertCell(
  field: ImportField,
  cell: CellValue | undefined,
  calendar: platformV1.JurisdictionCalendar,
): { value: unknown } | { error: string } {
  if (cell === undefined || (typeof cell === 'string' && normalizeText(cell) === '')) {
    return field.required ? { error: `${field.key} is required` } : { value: undefined };
  }
  let value: unknown;
  switch (field.kind) {
    case 'code':
      value = normalizeCode(cell instanceof Date ? cell.toISOString() : String(cell));
      break;
    case 'text':
      value = normalizeText(cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell));
      break;
    case 'number':
      value = cell instanceof Date || typeof cell === 'boolean' ? null : parseNumber(cell);
      if (value === null) return { error: `${field.key}: "${String(cell)}" is not a number` };
      break;
    case 'boolean':
      value = cell instanceof Date ? null : parseBoolean(cell);
      if (value === null) return { error: `${field.key}: "${String(cell)}" is not yes/no` };
      break;
    case 'date':
      value =
        typeof cell === 'boolean'
          ? null
          : parseDate(typeof cell === 'number' ? String(cell) : cell, calendar);
      if (value === null) return { error: `${field.key}: "${String(cell)}" is not a valid date` };
      break;
  }
  if (field.schema) {
    const result = field.schema.safeParse(value);
    if (!result.success)
      return { error: `${field.key}: ${result.error.issues[0]?.message ?? 'invalid'}` };
    value = result.data;
  }
  return { value };
}

export const MappingSchema = z.record(
  z.string(),
  z.object({
    entity: z.string(),
    /** Header text → field key; unmapped headers are ignored. */
    columns: z.record(z.string(), z.string()),
  }),
);
export type ImportMapping = z.infer<typeof MappingSchema>;
