/**
 * SSRF guard for outbound HTTP requests whose URL is influenced by users
 * (e.g. admin-editable channel baseUrl, webhook URLs, image proxies).
 *
 * Rejects:
 *  - non-http(s) protocols (file:, gopher:, javascript:, ftp:, ...)
 *  - embedded credentials in the URL (user@host) — prevents log leakage
 *  - loopback / RFC1918 / link-local / metadata / reserved IPs
 *  - hostnames whose DNS resolution lands in any of the above
 *
 * Intentionally conservative. If a legitimate external URL happens to point
 * at a private range (rare), operators must proxy it through a trusted
 * gateway rather than weaken this guard.
 */

import { promises as dns, LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';

export interface UrlGuardOptions {
  /** Allow these exact hostnames even if they look internal. Testing only. */
  allowHosts?: string[];
}

export async function assertSafeExternalUrl(
  raw: string,
  opts: UrlGuardOptions = {},
): Promise<void> {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BadRequestException('URL is empty');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException(`Invalid URL: ${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException(
      `Unsafe URL protocol (${url.protocol}); only http/https allowed`,
    );
  }

  if (url.username || url.password) {
    throw new BadRequestException(
      'URL must not embed credentials (user:pass@host)',
    );
  }

  // Strip IPv6 brackets for inspection but keep the original for DNS.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (opts.allowHosts?.some((h) => h.toLowerCase() === hostname)) return;

  // Literal IP — check directly, skip DNS.
  if (isIP(hostname)) {
    if (isInternalAddress(hostname)) {
      throw new BadRequestException(
        `URL points to internal/reserved address: ${hostname}`,
      );
    }
    return;
  }

  // Hostname like "localhost" resolved via /etc/hosts is usually internal; catch early.
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new BadRequestException(`URL points to loopback host: ${hostname}`);
  }

  // DNS resolution — reject if any A/AAAA record lands in a private range.
  let addrs: LookupAddress[];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new BadRequestException(
      `DNS lookup failed for ${hostname}: ${(err as Error).message}`,
    );
  }

  for (const a of addrs) {
    if (isInternalAddress(a.address)) {
      throw new BadRequestException(
        `Host ${hostname} resolves to internal address ${a.address}`,
      );
    }
  }
}

/**
 * Classify an IPv4/IPv6 literal as internal (should be SSRF-blocked).
 * IPv4 is exhaustive for all RFC 1918 / loopback / link-local / metadata / reserved.
 * IPv6 rejects loopback, unique-local (fc00::/7), link-local (fe80::/10), mapped v4.
 */
export function isInternalAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return isInternalV4(addr);
  if (family === 6) return isInternalV6(addr);
  return false;
}

function isInternalV4(addr: string): boolean {
  const parts = addr.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  // 0.0.0.0/8 "this network"
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local + metadata (169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 reserved
  if (a >= 240) return true;
  return false;
}

function isInternalV6(addr: string): boolean {
  const lower = addr.toLowerCase();
  // Loopback ::1
  if (lower === '::1') return true;
  // Unspecified ::
  if (lower === '::') return true;
  // IPv4-mapped literal form ::ffff:a.b.c.d
  const mappedDotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return isInternalV4(mappedDotted[1]);
  // IPv4-mapped hex form ::ffff:XXXX:YYYY (Node URL canonicalizes the dotted form
  // into compressed hex, e.g. ::ffff:7f00:1 for ::ffff:127.0.0.1)
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      return isInternalV4(`${a}.${b}.${c}.${d}`);
    }
  }
  // Unique local fc00::/7
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Link-local fe80::/10 (fe80-febf first block)
  if (/^fe[89ab]/.test(lower)) return true;
  return false;
}
