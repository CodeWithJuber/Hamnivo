import type { z } from 'zod';
import { AppError } from './app-error.js';

/** Parses input with a contract schema; failures become VALIDATION_FAILED with field paths. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError('VALIDATION_FAILED', {
    fields: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(body)',
      message: issue.message,
    })),
  });
}
