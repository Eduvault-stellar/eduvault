import { fileURLToPath } from 'url';

export default {
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js', './src/test/setup.js'],
    globals: true,
    include: [
      'src/**/*.test.{js,jsx,mjs,cjs,ts,tsx}',
      'test/**/*.test.{js,jsx,mjs,cjs,ts,tsx}',
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      '.next/**',
      'tests/**',
      'archive/**',
    ],
  },
  resolve: {
    alias: {
      "@": srcPath,
      "@sentry/nextjs": sentryMockPath,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup-vitest.js"],
    include: [
      "src/**/*.{test,spec}.{js,jsx,ts,tsx}",
      "test/integration/**/*.{test,spec}.{js,jsx,ts,tsx}",
    ],
    exclude: ["tests/**", "archive/**", "contracts/**", "soroban/**", "node_modules/**"],
  },
};
