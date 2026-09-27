/** Only same-site paths are followed after sign-in, never another origin (no open redirects). */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined;
  return value;
}

export const redirectSearch = (search: Record<string, unknown>): { redirect?: string } => {
  const redirect = safeRedirect(search.redirect);
  return redirect ? { redirect } : {};
};
