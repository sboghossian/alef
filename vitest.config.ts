import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is client/ and would hide server tests.
export default defineConfig({
  test: {
    root: ".",
    include: ["server/test/**/*.test.ts", "client/src/**/*.test.ts", "shared/**/*.test.ts"],
    setupFiles: ["server/test/dispatch-dir-setup.ts"],
  },
});
