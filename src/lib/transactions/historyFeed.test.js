/**
 * Unit test for src/lib/transactions/historyFeed.js — Issue #137
 *
 * Before this fix, `historyFeed.js` derived its own Horizon base URL by
 * comparing `NEXT_PUBLIC_STELLAR_NETWORK` against uppercase `'PUBLIC'`,
 * independently of `src/lib/config/chain.js`'s equivalent check (and
 * opposite of `refundService.js`'s lowercase `'mainnet'` check). This proves
 * `fetchHorizonTransactions` now requests against -- and therefore always
 * agrees with -- `chain.js`'s single validated `HORIZON_URL`.
 *
 * Run with: npm test (vitest)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('fetchHorizonTransactions Horizon endpoint (#137)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    globalThis.__eduvaultHistoryCache = new Map();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    globalThis.__eduvaultHistoryCache = new Map();
    vi.restoreAllMocks();
  });

  it('requests against chain.js\'s HORIZON_URL, not a locally-derived one', async () => {
    const { HORIZON_URL } = await import('@/lib/config/chain');
    const { fetchHorizonTransactions } = await import('./historyFeed.js');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ _embedded: { records: [] } }),
    });

    await fetchHorizonTransactions('GABC123', { page: 1, limit: 10 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const requestedUrl = global.fetch.mock.calls[0][0];
    expect(requestedUrl.startsWith(HORIZON_URL)).toBe(true);
  });
});
