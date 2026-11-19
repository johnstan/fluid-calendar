/** @type {import('jest').Config} */
const config = {
  testEnvironment: "node",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"],
  transform: {
    // isolatedModules keeps jest memory bounded: type-checking is covered by
    // `tsc --noEmit`, so tests only need transpilation.
    // jsx: Next's tsconfig uses "preserve"; tests need JSX compiled so
    // .tsx modules (e.g. components) can be imported.
    "^.+\\.tsx?$": [
      "ts-jest",
      { isolatedModules: true, tsconfig: { jsx: "react-jsx" } },
    ],
  },
};

module.exports = config;
