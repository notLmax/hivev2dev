import { defineConfig } from "vitest/config";

// Tests live in tests/ (outside tsconfig's src-only include) so tsc never
// compiles them into dist/. Vitest transforms TS itself.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
