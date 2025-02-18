module.exports = {
    preset: 'ts-jest',
    testTimeout: 180000,
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.+(ts|tsx|js)', '**/?(*.)+(spec|test).+(ts|tsx|js)'],
    testPathIgnorePatterns: ['<rootDir>/src/__tests__/test-config.ts'],
  };