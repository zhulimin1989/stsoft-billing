import { signHmac, verifyHmac, webhookTimestamp } from './hmac.util';

const SECRET = 'test-secret-a1b2c3d4';

describe('signHmac', () => {
  it('produces deterministic hex output for same inputs', () => {
    const ts = '1800000000';
    const body = '{"a":1}';
    expect(signHmac(SECRET, ts, body)).toBe(signHmac(SECRET, ts, body));
  });

  it('produces 64-char hex (sha256)', () => {
    const sig = signHmac(SECRET, '1800000000', '{}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different secret → different signature', () => {
    expect(signHmac('s1', '1800000000', 'x'))
      .not.toBe(signHmac('s2', '1800000000', 'x'));
  });

  it('different timestamp → different signature', () => {
    expect(signHmac(SECRET, '1800000000', 'x'))
      .not.toBe(signHmac(SECRET, '1800000001', 'x'));
  });

  it('different body → different signature', () => {
    expect(signHmac(SECRET, '1800000000', '{"a":1}'))
      .not.toBe(signHmac(SECRET, '1800000000', '{"a":2}'));
  });

  it('throws on empty secret', () => {
    expect(() => signHmac('', '1800000000', 'x')).toThrow(/secret/i);
  });

  it('handles empty body', () => {
    const sig = signHmac(SECRET, '1800000000', '');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles large body', () => {
    const big = 'x'.repeat(1_000_000);
    const sig = signHmac(SECRET, '1800000000', big);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles unicode / non-ASCII body', () => {
    const sig1 = signHmac(SECRET, '1800000000', '{"name":"你好"}');
    const sig2 = signHmac(SECRET, '1800000000', '{"name":"hello"}');
    expect(sig1).not.toBe(sig2);
  });
});

describe('verifyHmac', () => {
  let nowMs: number;
  beforeEach(() => {
    nowMs = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function fresh() {
    return Math.floor(nowMs / 1000).toString();
  }

  it('accepts a freshly signed payload', () => {
    const ts = fresh();
    const body = '{"amount":10}';
    const sig = signHmac(SECRET, ts, body);
    expect(verifyHmac(SECRET, ts, body, sig)).toBe(true);
  });

  it('rejects tampered body', () => {
    const ts = fresh();
    const sig = signHmac(SECRET, ts, '{"amount":10}');
    expect(verifyHmac(SECRET, ts, '{"amount":1000000}', sig)).toBe(false);
  });

  it('rejects wrong secret', () => {
    const ts = fresh();
    const body = 'x';
    const sig = signHmac('secret-1', ts, body);
    expect(verifyHmac('secret-2', ts, body, sig)).toBe(false);
  });

  it('rejects mismatched timestamp (replay with different ts value)', () => {
    const ts = fresh();
    const sig = signHmac(SECRET, ts, 'x');
    const otherTs = (parseInt(ts, 10) + 1).toString();
    expect(verifyHmac(SECRET, otherTs, 'x', sig)).toBe(false);
  });

  it('rejects old timestamp outside maxAge window (default 300s)', () => {
    const oldTs = (Math.floor(nowMs / 1000) - 600).toString(); // 10 min old
    const sig = signHmac(SECRET, oldTs, 'x');
    expect(verifyHmac(SECRET, oldTs, 'x', sig)).toBe(false);
  });

  it('rejects future timestamp outside maxAge window', () => {
    const futureTs = (Math.floor(nowMs / 1000) + 600).toString();
    const sig = signHmac(SECRET, futureTs, 'x');
    expect(verifyHmac(SECRET, futureTs, 'x', sig)).toBe(false);
  });

  it('accepts timestamp near boundary (within window)', () => {
    const edgeTs = (Math.floor(nowMs / 1000) - 299).toString();
    const sig = signHmac(SECRET, edgeTs, 'x');
    expect(verifyHmac(SECRET, edgeTs, 'x', sig)).toBe(true);
  });

  it('rejects timestamp exactly at window edge (strict > maxAge)', () => {
    const tooOld = (Math.floor(nowMs / 1000) - 301).toString();
    const sig = signHmac(SECRET, tooOld, 'x');
    expect(verifyHmac(SECRET, tooOld, 'x', sig)).toBe(false);
  });

  it('custom maxAge is respected within the global cap', () => {
    const ts = (Math.floor(nowMs / 1000) - 60).toString();
    const sig = signHmac(SECRET, ts, 'x');
    expect(verifyHmac(SECRET, ts, 'x', sig, 30)).toBe(false);
    expect(verifyHmac(SECRET, ts, 'x', sig, 120)).toBe(true);
  });

  it('caps custom maxAge to five minutes', () => {
    const oldTs = (Math.floor(nowMs / 1000) - 400).toString();
    const sig = signHmac(SECRET, oldTs, 'x');
    expect(verifyHmac(SECRET, oldTs, 'x', sig, 1000)).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    const body = 'x';
    const realTs = fresh();
    const sig = signHmac(SECRET, realTs, body);
    expect(verifyHmac(SECRET, 'not-a-number', body, sig)).toBe(false);
    expect(verifyHmac(SECRET, '', body, sig)).toBe(false);
    expect(verifyHmac(SECRET, '-1', body, sig)).toBe(false);
  });

  it('rejects empty signature', () => {
    const ts = fresh();
    expect(verifyHmac(SECRET, ts, 'x', '')).toBe(false);
  });

  it('rejects malformed hex signature', () => {
    const ts = fresh();
    expect(verifyHmac(SECRET, ts, 'x', 'not-hex-at-all')).toBe(false);
    expect(verifyHmac(SECRET, ts, 'x', 'deadbeef')).toBe(false); // wrong length
  });

  it('rejects empty secret on verify', () => {
    const ts = fresh();
    const sig = signHmac(SECRET, ts, 'x');
    expect(verifyHmac('', ts, 'x', sig)).toBe(false);
  });

  it('timing-safe compare: signatures of same length but different bytes still rejected', () => {
    const ts = fresh();
    const realSig = signHmac(SECRET, ts, 'x');
    // Flip one hex char to a different one but keep length
    const altered = realSig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    expect(altered.length).toBe(realSig.length);
    expect(altered).not.toBe(realSig);
    expect(verifyHmac(SECRET, ts, 'x', altered)).toBe(false);
  });
});

describe('webhookTimestamp', () => {
  it('produces unix seconds (≤ 11 digits, numeric)', () => {
    const ts = webhookTimestamp();
    expect(ts).toMatch(/^\d{10,11}$/);
  });

  it('is monotonic across quick calls', () => {
    const a = webhookTimestamp();
    const b = webhookTimestamp();
    expect(parseInt(b, 10)).toBeGreaterThanOrEqual(parseInt(a, 10));
  });

  it('roundtrips with signHmac/verifyHmac', () => {
    const ts = webhookTimestamp();
    const body = JSON.stringify({ hello: 'world' });
    const sig = signHmac(SECRET, ts, body);
    expect(verifyHmac(SECRET, ts, body, sig)).toBe(true);
  });
});
