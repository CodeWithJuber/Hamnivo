import { describe, expect, it } from 'vitest';
import { addressBlock, isPublicAddress, mappedIpv4 } from '../../src/net/index.js';

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
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['[::1]', 'loopback'],
    ['fe80::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['fd00:ec2::254', 'private'],
    ['fc00::1', 'private'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['64:ff9b::7f00:1', 'transition'],
    ['2002:7f00:1::', 'transition'],
    ['2001::1', 'reserved'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'link_local'],
    ['::ffff:10.0.0.1', 'private'],
    ['::127.0.0.1', 'reserved'],
  ])('%s is %s', (address, block) => {
    expect(addressBlock(address)).toBe(block);
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4009:81f::200e',
    '::ffff:8.8.8.8',
  ])('%s is public', (address) => {
    expect(addressBlock(address)).toBeNull();
    expect(isPublicAddress(address)).toBe(true);
  });

  it('refuses what is not an address', () => {
    expect(addressBlock('example.com')).toBe('invalid');
    expect(isPublicAddress('')).toBe(false);
    expect(isPublicAddress('300.1.1.1')).toBe(false);
  });

  it('reads the IPv4 address inside a mapped IPv6 address', () => {
    expect(mappedIpv4('::ffff:192.0.2.128')).toBe('192.0.2.128');
    expect(mappedIpv4('::ffff:c000:280')).toBe('192.0.2.128');
    expect(mappedIpv4('2606:4700::1')).toBeNull();
  });
});
