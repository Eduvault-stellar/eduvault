'use client';

import { useEffect } from 'react';
import { createTrustedHtmlSink, TRUSTED_TYPES_SINK_NAME } from '@/lib/security/trustedTypes';

export default function SecurityInit() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const existing = window.trustedTypes?.getPolicy?.(TRUSTED_TYPES_SINK_NAME);
      if (!existing) {
        createTrustedHtmlSink();
      }
    } catch {
      // Trusted Types not supported or policy creation failed; app falls back gracefully.
    }
  }, []);

  return null;
}
