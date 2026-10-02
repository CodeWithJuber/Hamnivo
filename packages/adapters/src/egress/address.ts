import { BlockList, isIP } from 'node:net';

/**
 * Addresses a tool call may never reach (blueprint §15 SSRF, X05): loopback, private, link-local
 * (cloud metadata lives at 169.254.169.254), carrier-grade NAT, multicast, reserved and
 * documentation ranges, and their IPv6 counterparts, including IPv4 addresses written inside IPv6
 * (mapped, compatible, NAT64 and 6to4).
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** The IPv4 address an IPv6 address carries, when it is one of the embedding forms. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|::ffff:0:|::|64:ff9b::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted?.[1]) return dotted[1];
  const groups = expandIpv6(lower);
  if (!groups) return null;
  const toIpv4 = (high: number, low: number) =>
    `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::a.b.c.d (NAT64)
  if (zeros(0, 5) && groups[5] === 0xffff) return toIpv4(groups[6] ?? 0, groups[7] ?? 0);
  if (zeros(0, 6) && ((groups[6] ?? 0) !== 0 || (groups[7] ?? 0) > 1)) {
    return toIpv4(groups[6] ?? 0, groups[7] ?? 0);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) {
    return toIpv4(groups[6] ?? 0, groups[7] ?? 0);
  }
  // 2002:AABB:CCDD::/48 (6to4)
  if (groups[0] === 0x2002) return toIpv4(groups[1] ?? 0, groups[2] ?? 0);
  return null;
}

/** Eight 16-bit groups of an IPv6 address, or null when it is not one. */
function expandIpv6(address: string): number[] | null {
  const plain = address.split('%')[0] ?? '';
  if (isIP(plain) !== 6) return null;
  let text = plain;
  const ipv4 = text.match(/((?:\d{1,3}\.){3}\d{1,3})$/)?.[1];
  if (ipv4) {
    const [a = 0, b = 0, c = 0, d = 0] = ipv4.split('.').map(Number);
    text = `${text.slice(0, -ipv4.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/** Whether a resolved address is public: anything else is refused before connecting. */
export function isPublicAddress(address: string): boolean {
  const plain = address.split('%')[0] ?? '';
  const family = isIP(plain);
  if (family === 4) return !blocked.check(plain, 'ipv4');
  if (family === 6) {
    const inner = embeddedIpv4(plain);
    if (inner !== null && blocked.check(inner, 'ipv4')) return false;
    return !blocked.check(plain, 'ipv6');
  }
  return false;
}
