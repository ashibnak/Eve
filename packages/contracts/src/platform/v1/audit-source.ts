import { z } from 'zod';

/** Where a change came from (CLAUDE.md rule 9). */
export const AuditSourceSchema = z.enum(['manual', 'file', 'agent', 'workflow']);
export type AuditSource = z.infer<typeof AuditSourceSchema>;
