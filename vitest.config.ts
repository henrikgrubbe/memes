import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["scripts/**/*.ts"],
      exclude: ["scripts/**/*.test.ts", "scripts/**/*test-support.ts"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 80,
        lines: 90,
      },
    },
  },
});
