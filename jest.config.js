/**
 * Pure-logic Jest setup.
 *
 * Everything the spec asks us to test (transport adapters, the SSE parser,
 * token counting, the skill frontmatter parser, and the tool-call loop against
 * a mocked transport) is plain TypeScript with no React Native imports. So we
 * run in `node` rather than dragging in the jest-expo multi-platform preset,
 * which would triple the run time for no benefit.
 *
 * Transports take an injected `fetch`, which is what keeps this possible.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  transform: {
    // Resolved explicitly rather than by bare name. Harmless either way, but it
    // sidesteps jest-resolve entirely, which needed a native `unrs-resolver`
    // binding that npm had skipped the postinstall for.
    '^.+\\.[jt]sx?$': [require.resolve('babel-jest'), { presets: ['babel-preset-expo'] }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // marked@18 exposes ESM as its package entry; Jest runs this suite in
    // CommonJS, so use the package's equivalent UMD distribution.
    '^marked$': '<rootDir>/node_modules/marked/lib/marked.umd.js',
  },
  transformIgnorePatterns: ['node_modules/(?!(marked|refractor|hastscript|hast-util|property-information|space-separated-tokens|comma-separated-tokens|zwitch|html-void-elements|parse-entities|character-entities|is-decimal|is-hexadecimal|is-alphanumerical|is-alphabetical)/)'],
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/__tests__/**'],
  /**
   * A ratchet, not a target.
   *
   * These numbers are two points below what the suite currently measures, which is
   * the only setting that is useful: a threshold above where you are fails every
   * run and gets deleted, and a threshold far below it never fires. Two points of
   * slack absorbs the noise of adding a pure module before its tests land in the
   * same change, and still fails when a whole file arrives untested.
   *
   * The absolute figures are low and honestly so. `collectCoverageFrom` is `src`
   * only, but `src/components/` is in it and is deliberately not unit-tested (see
   * `testMatch`: `.ts` only, never `.tsx`) — so a large, permanently uncovered
   * denominator is baked in. `functions` is the lowest for the same reason: most
   * uncovered functions are component bodies and the store actions that exist
   * only to call one. Judge a change by whether it moves these *down*, not by the
   * distance to 100.
   *
   * Raise them when a run comes in comfortably higher. Never lower them to make a
   * red run green — that is the one edit that makes the gate meaningless.
   */
  coverageThreshold: {
    global: {
      lines: 64,
      statements: 63,
      branches: 62,
      functions: 51,
    },
  },
};
