import { Resolver } from 'node:dns/promises';

/** TXT lookups for domain verification (A13); injectable so tests can answer for any domain. */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export const DNS_RESOLVER = Symbol('DNS_RESOLVER');

/** node:dns with the system resolver, or the servers named in SSO_DNS_SERVERS. */
export function systemDnsResolver(servers: readonly string[]): DnsResolver {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  if (servers.length > 0) resolver.setServers([...servers]);
  return { resolveTxt: (hostname) => resolver.resolveTxt(hostname) };
}

/** The record a tenant publishes to prove it owns a domain. */
export function verificationRecord(domain: string, token: string) {
  return { name: `_hamnivo-verification.${domain}`, value: `hamnivo-verification=${token}` };
}

const MISSING = new Set(['ENOTFOUND', 'ENODATA', 'ENODOMAIN', 'NXDOMAIN']);

/** Looks the record up: found, missing, or the lookup itself failed (retry later). */
export async function checkVerificationRecord(
  dns: DnsResolver,
  domain: string,
  token: string,
): Promise<'verified' | 'not_found' | 'lookup_failed'> {
  const record = verificationRecord(domain, token);
  let answers: string[][];
  try {
    answers = await dns.resolveTxt(record.name);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && MISSING.has(code) ? 'not_found' : 'lookup_failed';
  }
  // A long TXT value arrives split into strings of up to 255 bytes; join them back.
  return answers.some((chunks) => chunks.join('').trim() === record.value)
    ? 'verified'
    : 'not_found';
}
