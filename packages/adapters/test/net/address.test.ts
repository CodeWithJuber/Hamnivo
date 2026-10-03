import { describe, expect, it } from 'vitest';
import { addressBlock, isPublicAddress, mappedIpv4 } from '../../src/net/index.js';

/**
 * The one address list behind every request made on a tenant's behalf. It replaces four lists
 * that had drifted apart (webhooks, MCP servers, SSO discovery, migration sources), so this test
 * holds the union of what any of them refused, range by range, written out here independently of
 * the implementation.
 */

interface Range {
  cidr: string;
  /** Skip the addresses just outside: the neighbours sit in IETF-reserved space no list covered. */
  loose?: true;
}

const V4_RANGES: Range[] = [
  { cidr: '0.0.0.0/8' },
  { cidr: '10.0.0.0/8' },
  { cidr: '100.64.0.0/10' },
  { cidr: '127.0.0.0/8' },
  { cidr: '169.254.0.0/16' },
  { cidr: '172.16.0.0/12' },
  { cidr: '192.0.0.0/24' },
  { cidr: '192.0.2.0/24' },
  { cidr: '192.31.196.0/24' },
  { cidr: '192.52.193.0/24' },
  { cidr: '192.88.99.0/24' },
  { cidr: '192.168.0.0/16' },
  { cidr: '192.175.48.0/24' },
  { cidr: '198.18.0.0/15' },
  { cidr: '198.51.100.0/24' },
  { cidr: '203.0.113.0/24' },
  { cidr: '224.0.0.0/4' },
  { cidr: '240.0.0.0/4' },
];

const V6_RANGES: Range[] = [
  { cidr: '::/128' },
  { cidr: '::1/128' },
  // IPv4-compatible (deprecated) and IPv4-translated: refused whatever IPv4 address they carry.
  { cidr: '::/96', loose: true },
  { cidr: '::ffff:0:0:0/96', loose: true },
  { cidr: '64:ff9b::/96' },
  { cidr: '64:ff9b:1::/48' },
  { cidr: '100::/64' },
  { cidr: '2001::/23' },
  { cidr: '2001:db8::/32' },
  { cidr: '2002::/16' },
  { cidr: '3fff::/20' },
  { cidr: '5f00::/16' },
  { cidr: 'fc00::/7' },
  { cidr: 'fe80::/10' },
  { cidr: 'fec0::/10' },
  { cidr: 'ff00::/8' },
];

const v4Number = (address: string) =>
  address.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
const v4Text = (value: number) =>
  [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');

function v6Number(address: string): bigint {
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((total, group) => (total << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}
const v6Text = (value: bigint) =>
  Array.from({ length: 8 }, (_, i) =>
    ((value >> BigInt(16 * (7 - i))) & 0xffffn).toString(16),
  ).join(':');

interface Bounds {
  first: string;
  last: string;
  /** The addresses just outside the range, when there are any. */
  before: string | null;
  after: string | null;
  contains(address: string): boolean;
}

function v4Bounds(cidr: string): Bounds {
  const [network = '', prefix = '0'] = cidr.split('/');
  const first = v4Number(network);
  const last = first + 2 ** (32 - Number(prefix)) - 1;
  return {
    first: v4Text(first),
    last: v4Text(last),
    before: first > 0 ? v4Text(first - 1) : null,
    after: last < 2 ** 32 - 1 ? v4Text(last + 1) : null,
    contains: (address) => v4Number(address) >= first && v4Number(address) <= last,
  };
}

function v6Bounds(cidr: string): Bounds {
  const [network = '', prefix = '0'] = cidr.split('/');
  const first = v6Number(network);
  const last = first + (1n << BigInt(128 - Number(prefix))) - 1n;
  return {
    first: v6Text(first),
    last: v6Text(last),
    before: first > 0n ? v6Text(first - 1n) : null,
    after: last < (1n << 128n) - 1n ? v6Text(last + 1n) : null,
    contains: (address) => v6Number(address) >= first && v6Number(address) <= last,
  };
}

describe('every refused range', () => {
  for (const [family, ranges, bounds] of [
    ['IPv4', V4_RANGES, v4Bounds],
    ['IPv6', V6_RANGES, v6Bounds],
  ] as const) {
    describe(family, () => {
      const all = ranges.map((range) => bounds(range.cidr));
      it.each(ranges.map((range, index) => [range.cidr, range, all[index] as Bounds] as const))(
        '%s: refused from its first to its last address, public just outside',
        (_cidr, range, edge) => {
          expect(isPublicAddress(edge.first), `first ${edge.first}`).toBe(false);
          expect(isPublicAddress(edge.last), `last ${edge.last}`).toBe(false);
          if (range.loose) return;
          for (const outside of [edge.before, edge.after]) {
            if (!outside) continue;
            // Next to another refused range is still refused; anywhere else it is public.
            const expected = !all.some((other) => other.contains(outside));
            expect(isPublicAddress(outside), `outside ${outside}`).toBe(expected);
          }
        },
      );
    });
  }
});

describe('address blocks', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.20', 'private'],
    ['169.254.169.254', 'link_local'],
    ['100.64.0.1', 'shared'],
    ['0.0.0.0', 'unspecified'],
    ['192.0.2.1', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['192.88.99.1', 'transition'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['[::1]', 'loopback'],
    ['fe80::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['fec0::1', 'link_local'],
    ['fd00:ec2::254', 'private'],
    ['fc00::1', 'private'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation'],
    ['64:ff9b::7f00:1', 'transition'],
    ['2002:7f00:1::', 'transition'],
    ['::ffff:0:a00:1', 'transition'],
    ['2001::1', 'reserved'],
    ['100::1', 'reserved'],
    ['5f00::1', 'reserved'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'link_local'],
    ['::ffff:10.0.0.1', 'private'],
    ['::127.0.0.1', 'reserved'],
  ])('%s is %s', (address, block) => {
    expect(addressBlock(address)).toBe(block);
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('IPv4 inside IPv6', () => {
  it('judges an IPv4-mapped address by the IPv4 address it carries, in any spelling', () => {
    for (const address of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::FFFF:7F00:1',
      '0:0:0:0:0:ffff:7f00:1',
      '0000:0000:0000:0000:0000:ffff:7f00:0001',
      '::ffff:127.0.0.1%eth0',
      '[::ffff:169.254.169.254]',
      '::ffff:10.0.0.1',
      '::ffff:0.0.0.0',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ['::ffff:8.8.8.8', '::ffff:808:808', '::ffff:93.184.216.34']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('refuses the forms that carry an IPv4 address outright, even a public one', () => {
    for (const address of [
      // IPv4-compatible (deprecated)
      '::8.8.8.8',
      '::808:808',
      '::127.0.0.1',
      // IPv4-translated
      '::ffff:0:8.8.8.8',
      '::ffff:0:808:808',
      '::ffff:0:10.0.0.1',
      // NAT64, and its local-use prefix
      '64:ff9b::808:808',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::a00:1',
      '64:ff9b:1::808:808',
      // 6to4
      '2002:808:808::1',
      '2002:7f00:1::1',
      '2002:a00:1::1',
      // Teredo
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '2001:0:5ef5:79fd:0:0:f7f7:f7f7',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('reads the IPv4 address inside a mapped IPv6 address', () => {
    expect(mappedIpv4('::ffff:192.0.2.128')).toBe('192.0.2.128');
    expect(mappedIpv4('::ffff:c000:280')).toBe('192.0.2.128');
    expect(mappedIpv4('::FFFF:C000:280')).toBe('192.0.2.128');
    expect(mappedIpv4('2606:4700::1')).toBeNull();
    expect(mappedIpv4('::ffff:0:c000:280')).toBeNull();
    expect(mappedIpv4('::c000:280')).toBeNull();
    expect(mappedIpv4('not-an-address')).toBeNull();
  });
});

describe('public addresses', () => {
  it.each([
    '93.184.216.34',
    '93.184.215.14',
    '8.8.8.8',
    '8.8.4.4',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.255.255',
    '192.0.1.1',
    '192.167.255.255',
    '198.20.0.1',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '2a00:1450:4009:81f::200e',
    '2001:4860:4860::8888',
    '2001:200::1',
    '2003::1',
    '::ffff:8.8.8.8',
    '::ffff:8.8.4.4',
  ])('%s is public', (address) => {
    expect(addressBlock(address)).toBeNull();
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('what is not an address', () => {
  it.each([
    '',
    ' ',
    'example.com',
    'localhost',
    'not-an-ip',
    'not-an-address',
    '300.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '2130706433',
    '0x7f.1',
    '017700000001',
    '::g',
    '1::2::3',
    '12345::1',
    '127.0.0.1:80',
    'http://127.0.0.1',
  ])('%j is refused', (address) => {
    expect(addressBlock(address)).toBe('invalid');
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('cases the earlier lists were tested with', () => {
  it('refuses every address any of them refused', () => {
    for (const address of [
      // webhooks
      '10.1.2.3',
      '172.31.255.255',
      '192.168.1.20',
      'fd00:ec2::254',
      // MCP servers
      '127.255.255.254',
      '172.16.0.9',
      '192.168.1.10',
      '192.0.2.10',
      'fd12:3456::1',
      '::ffff:169.254.169.254',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::1',
      // SSO discovery
      '10.2.3.4',
      '172.20.0.1',
      'fd00::1',
      '::ffff:127.0.0.1',
      // migration sources
      '192.168.1.1',
      '::ffff:0:10.0.0.1',
      '64:ff9b::a00:1',
      '2002:a00:1::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '100::1',
      'fec0::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});
