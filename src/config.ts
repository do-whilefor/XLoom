import { readFileSync, writeFileSync } from "node:fs";
import { projectConfigSchema, formatValidationError } from "./schema.js";
import type { ProjectConfig } from "./types.js";

/** A model registry default, not a model availability check or a network call. */
export function defaultConfig(goal: string, scope = goal): ProjectConfig {
  const model = { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "medium" as const };
  return projectConfigSchema.parse({
    version: 1,
    title: "xloom",
    goal,
    scope,
    context: "",
    models: { decide: { ...model }, execute: { ...model } },
    limits: {},
  });
}

export function loadConfig(path: string): ProjectConfig {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read xloom configuration at ${path}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Invalid JSON in xloom configuration at ${path}`);
  }
  const parsed = projectConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid xloom configuration at ${path}: ${formatValidationError(parsed.error)}`);
  }
  return parsed.data;
}

/** Exclusive creation: initialization must never overwrite an existing project. */
export function saveNewConfig(path: string, config: ProjectConfig): void {
  const parsed = projectConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid xloom configuration: ${formatValidationError(parsed.error)}`);
  }
  writeFileSync(path, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
