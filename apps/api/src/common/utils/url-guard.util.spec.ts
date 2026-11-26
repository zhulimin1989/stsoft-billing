import { BadRequestException } from '@nestjs/common';
import { assertSafeExternalUrl, isInternalAddress } from './url-guard.util';

// Mock DNS to keep tests deterministic.
jest.mock('node:dns', () => ({
  promises: {
    lookup: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dnsMock = require('node:dns').promises.lookup as jest.Mock;

describe('isInternalAddress (IPv4 classification)', () => {
  test.each([
    ['0.0.0.0', true, 'this-network'],
    ['10.0.0.1', true, '10/8'],
    ['10.255.255.255', true, '10/8 max'],
    ['127.0.0.1', true, 'loopback'],
    ['127.1.2.3', true, 'loopback subnet'],
    ['169.254.169.254', true, 'AWS/GCP metadata'],
    ['169.254.0.1', true, 'link-local'],
    ['172.15.255.255', false, 'just outside 172.16/12'],
    ['172.16.0.1', true, '172.16 lower'],
    ['172.31.255.255', true, '172.31 upper'],
    ['172.32.0.0', false, 'just outside 172.16/12 upper'],
    ['192.168.1.1', true, '192.168/16'],
    ['192.167.0.0', false, 'just outside 192.168'],
    ['198.18.1.1', true, 'benchmarking'],
    ['198.19.255.255', true, 'benchmarking upper'],
    ['198.20.0.0', false, 'just outside benchmarking'],
    ['224.0.0.1', true, 'multicast'],
    ['239.255.255.255', true, 'multicast max'],
    ['240.0.0.1', true, 'reserved'],
    ['255.255.255.255', true, 'reserved'],
    ['1.1.1.1', false, 'Cloudflare public'],
    ['8.8.8.8', false, 'Google DNS'],
    ['9.9.9.9', false, 'Quad9 public'],
    ['104.16.0.1', false, 'Cloudflare public'],
  ])('%s → internal=%s (%s)', (ip, expected) => {
    expect(isInternalAddress(ip)).toBe(expected);
  });
});

describe('isInternalAddress (IPv6 classification)', () => {
  test.each([
    ['::1', true, 'loopback'],
    ['::', true, 'unspecified'],
    ['fe80::1', true, 'link-local'],
    ['febf::1', true, 'link-local upper'],
    ['fec0::1', false, 'deprecated site-local, not blocked'], // actually fc+ fd are ULA
    ['fc00::1', true, 'unique-local lower'],
    ['fd12:3456::1', true, 'unique-local'],
    ['::ffff:127.0.0.1', true, 'v4-mapped loopback'],
    ['::ffff:192.168.1.1', true, 'v4-mapped RFC1918'],
    ['::ffff:8.8.8.8', false, 'v4-mapped public'],
    ['2606:4700:4700::1111', false, 'Cloudflare IPv6 public'],
    ['2001:4860:4860::8888', false, 'Google IPv6 public'],
  ])('%s → internal=%s (%s)', (ip, expected) => {
    expect(isInternalAddress(ip)).toBe(expected);
  });
});

describe('assertSafeExternalUrl', () => {
  beforeEach(() => {
    dnsMock.mockReset();
  });

  it('rejects empty string', async () => {
    await expect(assertSafeExternalUrl('')).rejects.toThrow(BadRequestException);
  });

  it('rejects non-string input', async () => {
    // @ts-expect-error intentional runtime misuse
    await expect(assertSafeExternalUrl(null)).rejects.toThrow(BadRequestException);
  });

  it('rejects malformed URL', async () => {
    await expect(assertSafeExternalUrl('not a url')).rejects.toThrow(/Invalid URL/);
    await expect(assertSafeExternalUrl('://broken')).rejects.toThrow(/Invalid URL/);
  });

  it('rejects non-http(s) protocols', async () => {
    await expect(assertSafeExternalUrl('file:///etc/passwd')).rejects.toThrow(/protocol/i);
    await expect(assertSafeExternalUrl('gopher://internal:70/')).rejects.toThrow(/protocol/i);
    await expect(assertSafeExternalUrl('javascript:alert(1)')).rejects.toThrow(/protocol/i);
    await expect(assertSafeExternalUrl('ftp://ftp.example.com/')).rejects.toThrow(/protocol/i);
    await expect(assertSafeExternalUrl('data:text/plain,hi')).rejects.toThrow(/protocol/i);
  });

  it('rejects URLs embedding credentials (user:pass@host)', async () => {
    dnsMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    await expect(assertSafeExternalUrl('http://user:pass@example.com/')).rejects.toThrow(/credentials/i);
    await expect(assertSafeExternalUrl('http://admin@example.com/')).rejects.toThrow(/credentials/i);
  });

  it('rejects literal loopback / RFC1918 / metadata addresses without DNS lookup', async () => {
    await expect(assertSafeExternalUrl('http://127.0.0.1/')).rejects.toThrow(/internal/i);
    await expect(assertSafeExternalUrl('https://10.0.0.5:8080/')).rejects.toThrow(/internal/i);
    await expect(assertSafeExternalUrl('http://192.168.1.1/')).rejects.toThrow(/internal/i);
    await expect(assertSafeExternalUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/internal/i);
    await expect(assertSafeExternalUrl('http://172.16.0.1/')).rejects.toThrow(/internal/i);
    expect(dnsMock).not.toHaveBeenCalled();
  });

  it('rejects IPv6 loopback / ULA / link-local literals', async () => {
    await expect(assertSafeExternalUrl('http://[::1]/')).rejects.toThrow(/internal/i);
    await expect(assertSafeExternalUrl('http://[fc00::1]/')).rejects.toThrow(/internal/i);
    await expect(assertSafeExternalUrl('http://[fe80::1]/')).rejects.toThrow(/internal/i);
    await expect(assertSafeExternalUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/internal/i);
  });

  it('rejects localhost by hostname without DNS', async () => {
    await expect(assertSafeExternalUrl('http://localhost:3000/')).rejects.toThrow(/loopback|internal/i);
    await expect(assertSafeExternalUrl('http://api.localhost/')).rejects.toThrow(/loopback|internal/i);
  });

  it('DNS returns only public IPs — URL is allowed', async () => {
    dnsMock.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ]);
    await expect(assertSafeExternalUrl('https://dns.google/resolve')).resolves.toBeUndefined();
    expect(dnsMock).toHaveBeenCalledWith('dns.google', expect.any(Object));
  });

  it('DNS returns at least one internal address — rejected (rebinding defense)', async () => {
    dnsMock.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 }, // DNS rebinding attack attempt
    ]);
    await expect(assertSafeExternalUrl('https://evil.example.com/')).rejects.toThrow(/internal/i);
  });

  it('DNS lookup error is surfaced as BadRequest', async () => {
    dnsMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertSafeExternalUrl('https://does-not-exist.invalid/')).rejects.toThrow(/DNS lookup failed/);
  });

  it('allowHosts bypasses the check for exact hostname match (testing only)', async () => {
    await expect(
      assertSafeExternalUrl('http://localhost:1234/x', { allowHosts: ['localhost'] }),
    ).resolves.toBeUndefined();
    expect(dnsMock).not.toHaveBeenCalled();
  });

  it('allowHosts does NOT match mismatched hostname', async () => {
    await expect(
      assertSafeExternalUrl('http://localhost:1234/x', { allowHosts: ['other.example.com'] }),
    ).rejects.toThrow(/loopback|internal/i);
  });

  it('case-insensitive hostname classification', async () => {
    await expect(assertSafeExternalUrl('http://LOCALHOST/')).rejects.toThrow(/loopback|internal/i);
    await expect(assertSafeExternalUrl('http://LocalHost:8080/')).rejects.toThrow(/loopback|internal/i);
  });

  it('url with encoded @ does NOT bypass credentials check', async () => {
    // "%40" could let "user%40host@real.host" trick a naive parser, but WHATWG URL decodes it.
    dnsMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    // This actually parses as host="real.host" with username="user%40host" — credentials block.
    await expect(assertSafeExternalUrl('http://user%40host@real.host/')).rejects.toThrow(/credentials/i);
  });

  it('path, query, fragment are ignored in the check', async () => {
    dnsMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    await expect(
      assertSafeExternalUrl('https://example.com/path?q=1&x=y#frag'),
    ).resolves.toBeUndefined();
  });

  it('port is ignored in the check (only hostname matters)', async () => {
    dnsMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    await expect(assertSafeExternalUrl('https://example.com:8443/')).resolves.toBeUndefined();
    await expect(assertSafeExternalUrl('http://127.0.0.1:80/')).rejects.toThrow(/internal/i);
  });
});
