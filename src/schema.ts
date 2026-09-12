import { z } from "zod";

const text = (max = 8_000) => z.string().trim().min(1).max(max).refine((value) => !value.includes("\0"), "Must not contain NUL characters");
const id = text(256);
const refs = z.array(id).max(256);
const positiveInt = (max: number) => z.number().finite().int().min(1).max(max);
const priority = z.number().finite().int().min(0).max(1_000);
const rating = z.enum(["unrated", "info", "P3", "P2", "P1"]);
const outcome = z.enum(["VULN_FOUND", "NOT_REPRODUCED", "LOW_ROI", "NEED_INPUT"]);

const impactSchema = z.object({
  capability: text(),
  object: text(),
  result: text(),
  scope: text(),
  prerequisites: text(),
}).strict();

export const modelConfigSchema = z.object({
  provider: text(128),
  model: text(256),
  api: text(128).optional(),
  baseUrl: text(2_048).refine((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, "Use an HTTP(S) base URL without credentials, query parameters, or fragments").optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Use an environment variable name, not an API key").optional(),
  contextWindow: positiveInt(10_000_000).optional(),
  maxTokens: positiveInt(1_000_000).optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
}).strict();

export const limitsSchema = z.object({
  // Accept old configurations without keeping a task-completion counter limit.
  maxSteps: positiveInt(10_000).optional(),
  maxNoProgress: positiveInt(1_000).default(3),
  maxMinutes: z.number().finite().positive().max(10_080).nullable().default(null),
  maxTokens: positiveInt(1_000_000_000).nullable().default(null),
  maxCost: z.number().finite().positive().max(1_000_000).nullable().default(null),
  maxTurnsPerRun: positiveInt(1_000).default(12),
  stepTimeoutSeconds: z.number().finite().positive().max(86_400).default(180),
  metacogEvery: positiveInt(1_000).default(3),
}).strict().transform(({ maxSteps: _legacyMaxSteps, ...limits }) => limits);

export const projectConfigSchema = z.object({
  version: z.literal(1).default(1),
  title: text(160).default("xloom"),
  goal: text(16_000),
  scope: text(16_000),
  context: z.string().max(64_000).default(""),
  models: z.object({ decide: modelConfigSchema, execute: modelConfigSchema, chat: modelConfigSchema.optional() }).strict(),
  limits: limitsSchema.default({}),
}).strict();

export const usageSchema = z.object({
  input: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  output: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cost: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const decisionSchema = z.object({
  summary: text(),
  steps: z.array(z.object({
    goalId: id,
    from: refs,
    description: text(),
    successSignal: text(),
    evidencePlan: text(),
    priority,
  }).strict()).max(32).optional(),
  goals: z.array(z.object({ id, description: text(), parentId: id }).strict()).max(32).optional(),
  updateSteps: z.array(z.object({
    id,
    action: z.enum(["abandon", "prioritize"]),
    priority: priority.optional(),
    reason: text(),
  }).strict()).max(128).optional(),
  updateGoals: z.array(z.object({
    id,
    status: z.enum(["satisfied", "abandoned"]),
    factIds: refs,
    reason: text(),
  }).strict()).max(128).optional(),
  reviews: z.array(z.object({
    findingId: id,
    status: z.enum(["impact_verified", "closed"]),
    rating,
    reason: text(),
    impact: impactSchema.optional(),
    pocEvidenceId: id.optional(),
  }).strict()).max(128).optional(),
  conclusion: z.object({ outcome, reason: text() }).strict().optional(),
}).strict();

export const executionSchema = z.object({
  summary: text(),
  result: z.enum(["done", "no_progress", "blocked"]),
  evidence: z.array(z.object({ ref: id, path: text(4_096), description: text() }).strict()).max(128).optional(),
  facts: z.array(z.object({
    ref: id,
    description: text(),
    evidenceRefs: refs,
    supersedes: id.optional(),
  }).strict()).max(128).optional(),
  findings: z.array(z.object({
    key: id,
    title: text(512),
    target: text(2_048),
    status: z.enum(["lead", "technical_hit"]),
    factRefs: refs,
    evidenceRefs: refs,
    next: text(),
    impact: impactSchema.optional(),
    pocEvidenceRef: id.optional(),
  }).strict()).max(128).optional(),
}).strict();

/** Keeps validation errors actionable without echoing submitted values or secrets. */
export function formatValidationError(error: z.ZodError): string {
  return error.issues.slice(0, 12).map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
}
