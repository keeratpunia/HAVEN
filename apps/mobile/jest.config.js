/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testPathIgnorePatterns: ['/node_modules/', '/.expo/', '/dist/', '/e2e/'],
  // The rest of this monorepo writes relative imports with an explicit `.js`
  // extension pointing at `.ts`/`.tsx` source (the TypeScript "NodeNext" convention —
  // see metro.config.js for the same gap on the Metro side). Jest's resolver doesn't
  // do that mapping either, so it needs the same nudge.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
