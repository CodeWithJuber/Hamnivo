/**
 * The tunnel for browser errors: Studio and the chat send their error reports (Sentry envelopes)
 * to this server, which forwards each one to the configured project and nowhere else. The pages
 * then need no connection to the tracker's host (their CSP allows only this API), and an ad
 * blocker does not drop the reports.
 *
 * An envelope is forwarded only when the DSN in its header is SENTRY_DSN itself, so the tunnel
 * can never carry data to another server or project.
 */

/** The parts of a DSN that name one project: where it is and which key opens it. */
function projectOf(
  dsn: string,
): { origin: string; prefix: string; id: string; key: string } | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    // Not a URL: no project to send to.
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts.pop();
  if (!id || !/^\d+$/.test(id) || !url.username) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return {
    origin: `${url.protocol}//${url.host}`,
    prefix: parts.length > 0 ? `/${parts.join('/')}` : '',
    id,
    key: decodeURIComponent(url.username),
  };
}

/** Whether two DSNs name the same project with the same key (a trailing slash aside). */
export function sameProject(a: string, b: string): boolean {
  const x = projectOf(a);
  const y = projectOf(b);
  return (
    x !== null &&
    y !== null &&
    x.origin === y.origin &&
    x.prefix === y.prefix &&
    x.id === y.id &&
    x.key === y.key
  );
}

/**
 * Where an envelope goes: the envelope endpoint of the configured project, or null when the
 * envelope names another DSN or is not an envelope at all. The key goes in the query string,
 * which Sentry and GlitchTip both accept.
 */
export function envelopeTarget(envelope: string, configuredDsn: string): URL | null {
  const end = envelope.indexOf('\n');
  const head = end === -1 ? envelope : envelope.slice(0, end);
  let header: unknown;
  try {
    header = JSON.parse(head);
  } catch {
    // The first line of an envelope is its JSON header; anything else is not one.
    return null;
  }
  const dsn = (header as { dsn?: unknown } | null)?.dsn;
  if (typeof dsn !== 'string' || !sameProject(dsn, configuredDsn)) return null;
  const project = projectOf(configuredDsn);
  if (!project) return null;
  const target = new URL(`${project.origin}${project.prefix}/api/${project.id}/envelope/`);
  target.searchParams.set('sentry_key', project.key);
  return target;
}

/** What a page needs to report its errors: null `dsn` when error tracking is off. */
export interface ErrorReportingSettings {
  dsn: string | null;
  environment: string;
  release: string | null;
}
