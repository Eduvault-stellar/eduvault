/**
 * Unit tests for src/lib/env.js — Issue #138
 *
 * `validateRuntimeEnv()` reads `process.env` at call time (not at import
 * time), so these tests mutate `process.env` directly between assertions
 * without needing `vi.resetModules()`.
 *
 * Run with: npm test (vitest)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isPlaceholder, validateRuntimeEnv } from './env.js';

describe('isPlaceholder (#138)', () => {
  it('treats undefined, non-string, and known placeholder strings as placeholders', () => {
    expect(isPlaceholder(undefined)).toBe(true);
    expect(isPlaceholder(null)).toBe(true);
    expect(isPlaceholder('')).toBe(true);
    expect(isPlaceholder('replace-me')).toBe(true);
    expect(isPlaceholder('change-me')).toBe(true);
    expect(isPlaceholder('  ')).toBe(true);
  });

  it('treats a real, non-placeholder value as configured', () => {
    expect(isPlaceholder('GDPZEIQCN2TUH7E25IZ36MNRGULMFGC3KIXON7S5LHXZJBSETLKZRFCA')).toBe(false);
  });
});

describe('validateRuntimeEnv: NEXT_PUBLIC_USDC_ISSUER (#138)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalIssuer = process.env.NEXT_PUBLIC_USDC_ISSUER;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalIssuer === undefined) {
      delete process.env.NEXT_PUBLIC_USDC_ISSUER;
    } else {
      process.env.NEXT_PUBLIC_USDC_ISSUER = originalIssuer;
    }
  });

  it('flags a missing NEXT_PUBLIC_USDC_ISSUER as an error in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NEXT_PUBLIC_USDC_ISSUER;

    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('NEXT_PUBLIC_USDC_ISSUER'))).toBe(true);
  });

  it('flags a placeholder NEXT_PUBLIC_USDC_ISSUER as an error in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_USDC_ISSUER = 'replace-me';

    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('NEXT_PUBLIC_USDC_ISSUER'))).toBe(true);
  });

  it('does not flag a real NEXT_PUBLIC_USDC_ISSUER value in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_USDC_ISSUER = 'GDPZEIQCN2TUH7E25IZ36MNRGULMFGC3KIXON7S5LHXZJBSETLKZRFCA';

    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('NEXT_PUBLIC_USDC_ISSUER'))).toBe(false);
  });

  it('does not require NEXT_PUBLIC_USDC_ISSUER outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.NEXT_PUBLIC_USDC_ISSUER;

    const errors = validateRuntimeEnv();
    expect(errors.some((e) => e.includes('NEXT_PUBLIC_USDC_ISSUER'))).toBe(false);
  });
});
