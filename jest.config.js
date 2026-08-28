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
};
