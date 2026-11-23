import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Validates request input with a Zod schema; invalid input is a 400 listing the issues. */
export function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new BadRequestException({
    error: 'invalid_request',
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}
