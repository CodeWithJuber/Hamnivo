import { BlockList, isIP } from 'node:net';

/**
 * Which IP addresses a request made on a tenant's behalf may reach (X05). Only publicly routable
 * unicast addresses: never loopback, the local network, link-local addresses (where cloud metadata
 * services live), shared carrier NAT space, documentation or benchmarking ranges, multicast or
 * reserved space. Taken from the IANA special-purpose address registries for IPv4 and IPv6.
 * Transition prefixes that embed an IPv4 address (NAT64, 6to4, Teredo) are refused outright:
 * the address they lead to cannot be judged from here.
 */

type Block = readonly [network: string, prefix: number, label: AddressBlock];

export type AddressBlock =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'shared'
  | 'link_local'
  | 'documentation'
  | 'benchmarking'
  | 'multicast'
  | 'reserved'
  | 'transition';

const V4: readonly Block[] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'shared'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.31.196.0', 24, 'reserved'],
  ['192.52.193.0', 24, 'reserved'],
  ['192.88.99.0', 24, 'transition'],
  ['192.168.0.0', 16, 'private'],
  ['192.175.48.0', 24, 'reserved'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const V6: readonly Block[] = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  // IPv4-compatible addresses (deprecated); the IPv4-mapped block is judged by its IPv4 address.
  ['::', 96, 'reserved'],
  ['64:ff9b::', 96, 'transition'],
  ['64:ff9b:1::', 48, 'transition'],
  ['100::', 64, 'reserved'],
  ['2001::', 23, 'reserved'],
  ['2001:db8::', 32, 'documentation'],
  ['2002::', 16, 'transition'],
  ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'reserved'],
  ['fc00::', 7, 'private'],
  ['fe80::', 10, 'link_local'],
  ['fec0::', 10, 'link_local'],
  ['ff00::', 8, 'multicast'],
];

function blockList(blocks: readonly Block[], family: 'ipv4' | 'ipv6') {
  return blocks.map(([network, prefix, label]) => {
    const list = new BlockList();
    list.addSubnet(network, prefix, family);
    return { list, label };
  });
}

const V4_LISTS = blockList(V4, 'ipv4');
const V6_LISTS = blockList(V6, 'ipv6');

/** Expands an IPv6 address into its eight 16-bit groups (a zone such as `%eth0` is dropped). */
function ipv6Groups(address: string): number[] | null {
  let text = address.split('%')[0] ?? '';
  // A trailing dotted IPv4 part (::ffff:127.0.0.1) counts as the last two groups.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted?.[1] && dotted[2]) {
    const octets = dotted[2].split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  const values = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : -1));
  return values.some((v) => v < 0) ? null : values;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), if it is one. */
export function mappedIpv4(address: string): string | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if (g0 || g1 || g2 || g3 || g4 || g5 !== 0xffff) return null;
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

/**
 * The special-purpose block an address belongs to, `null` for a public unicast address, or
 * `'invalid'` when it is not an IP address at all.
 */
export function addressBlock(address: string): AddressBlock | 'invalid' | null {
  const bare = address.replace(/^\[|\]$/g, '');
  const family = isIP(bare.split('%')[0] ?? '');
  if (family === 4) {
    return V4_LISTS.find(({ list }) => list.check(bare, 'ipv4'))?.label ?? null;
  }
  if (family === 6) {
    const mapped = mappedIpv4(bare);
    if (mapped) return addressBlock(mapped);
    const plain = bare.split('%')[0] ?? '';
    return V6_LISTS.find(({ list }) => list.check(plain, 'ipv6'))?.label ?? null;
  }
  return 'invalid';
}

/** Whether a request may connect to this address: publicly routable unicast only. */
export function isPublicAddress(address: string): boolean {
  return addressBlock(address) === null;
}
