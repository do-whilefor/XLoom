import { defineConfig } from "vitest/config";
// CLI and PowerShell integration cases start additional native processes. Keep
// file-level concurrency bounded so process startup does not exhaust their clocks.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], testTimeout: 15000, maxWorkers: 4 } });
