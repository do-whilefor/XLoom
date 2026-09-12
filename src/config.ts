import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { projectConfigSchema, formatValidationError } from "./schema.js";
import type { ProjectConfig } from "./types.js";

export const CHAT_GOAL = "普通聊天；使用 /run 目标启动独立红队任务";

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

/** Save non-secret settings atomically. Model keys belong in Pi's credential store. */
export function saveConfig(path: string, config: ProjectConfig): void {
  const parsed = projectConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error(`Invalid xloom configuration: ${formatValidationError(parsed.error)}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
