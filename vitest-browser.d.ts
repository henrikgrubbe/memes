import "vitest/browser";

// Vitest 5.0.0 references this source interface but omits it from the published entry point.
declare module "vitest/browser" {
  interface MarkOptions {
    stack?: string;
    kind?: "action" | "expect" | "mark" | "lifecycle";
  }
}
