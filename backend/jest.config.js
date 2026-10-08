export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/tests/**/*.spec.js'],
  setupFiles: ['<rootDir>/tests/helpers/env.js'],
  globalSetup: '<rootDir>/tests/helpers/globalSetup.js',
  testTimeout: 30000,
};
