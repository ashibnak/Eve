import { z } from 'zod';

/**
 * Who performed an action. Agents always act on behalf of a user and never with more
 * scope than that user (CLAUDE.md rule 11).
 */
export const ActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().min(1) }),
  z.object({
    kind: z.literal('agent'),
    id: z.string().min(1),
    onBehalfOf: z.string().min(1),
  }),
  z.object({ kind: z.literal('system'), id: z.string().min(1) }),
]);
export type Actor = z.infer<typeof ActorSchema>;
