/** SQLSTATE and constraint of a PostgreSQL error, also when wrapped by Drizzle. */
export function pgErrorInfo(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}

export const isUniqueViolation = (error: unknown, constraint?: string) => {
  const info = pgErrorInfo(error);
  return info.code === '23505' && (!constraint || info.constraint === constraint);
};
