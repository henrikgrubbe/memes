import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*test-support.ts",
        "src/hosted/ingress/webhook-server.ts",
        "src/hosted/worker/worker-server.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 80,
        lines: 90,
      },
    },
  },
});
