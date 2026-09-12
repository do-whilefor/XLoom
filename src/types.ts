import type { Api } from "@earendil-works/pi-ai";
import type { BlackboardContext } from "./loop/context.js";

export type Mode = "decide" | "execute" | "metacog";
export type AgentRole = "decide" | "execute";
export interface OuterLoopTrigger {
  kind: "start" | "resume" | "planned" | "execution_result" | "periodic" | "stagnation" | "blocked" | "technical_hit" | "fact_revision" | "hint" | "manual" | "completion" | "empty_plan";
  reason: string;
}
export interface AgentHandoff {
  role: AgentRole; mode: Mode; runId: string; revision: number; stepId?: string; trigger: OuterLoopTrigger;
}
export type RunStatus = "idle" | "running" | "paused" | "stopped" | "completed" | "error";
export type Outcome = "VULN_FOUND" | "NOT_REPRODUCED" | "LOW_ROI" | "NEED_INPUT";
export type FindingStatus = "lead" | "technical_hit" | "impact_verified" | "closed";
export type Rating = "unrated" | "info" | "P3" | "P2" | "P1";
export type StepStatus = "ready" | "claimed" | "done" | "no_progress" | "blocked" | "failed" | "abandoned";

export interface ModelConfig {
  provider: string;
  model: string;
  api?: Api;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  maxTokens?: number;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
export interface ProjectConfig {
  version: 1;
  title: string;
  goal: string;
  scope: string;
  context: string;
  models: { decide: ModelConfig; execute: ModelConfig; chat?: ModelConfig };
  limits: { maxNoProgress: number; maxMinutes: number | null; maxTokens: number | null; maxCost: number | null; maxTurnsPerRun: number | null; stepTimeoutSeconds: number; metacogEvery: number };
}
export interface Goal { id: string; description: string; parentId: string | null; status: "active" | "satisfied" | "abandoned"; factIds: string[] }
export interface Fact { id: string; description: string; stepId: string | null; evidenceIds: string[]; supersedes?: string }
export interface Step {
  id: string; goalId: string; from: string[]; description: string; successSignal: string; evidencePlan: string;
  priority: number; status: StepStatus; attempts: number; runId: string | null; leaseUntil: number | null; result?: string;
}
export interface Evidence { id: string; path: string; sha256: string; bytes: number; description: string; runId: string; stepId: string; excerpt?: string }
export interface Impact { capability: string; object: string; result: string; scope: string; prerequisites: string }
export interface Finding {
  id: string; key: string; target: string; title: string; status: FindingStatus; rating: Rating;
  evidenceIds: string[]; factIds: string[]; next: string; impact?: Impact; review?: string; pocEvidenceId?: string;
}
export interface Hint { id: string; content: string; createdAt: string }
export interface Usage { input: number; output: number; cost: number }
export interface BoardSnapshot {
  revision: number; config: ProjectConfig; status: RunStatus; outcome: Outcome | null; reason: string;
  goals: Goal[]; facts: Fact[]; steps: Step[]; findings: Finding[]; evidence: Evidence[]; hints: Hint[];
  usage: Usage; completedSteps: number; noProgressCount: number; lastMetaStep: number; lastMetaRevision: number; elapsedMs?: number;
}
export interface StepProposal { goalId: string; from: string[]; description: string; successSignal: string; evidencePlan: string; priority: number }
export interface Decision {
  summary: string;
  steps?: StepProposal[];
  goals?: { id: string; description: string; parentId: string }[];
  updateSteps?: { id: string; action: "abandon" | "prioritize"; priority?: number; reason: string }[];
  updateGoals?: { id: string; status: "satisfied" | "abandoned"; factIds: string[]; reason: string }[];
  reviews?: { findingId: string; status: "impact_verified" | "closed"; rating: Rating; reason: string; impact?: Impact; pocEvidenceId?: string }[];
  conclusion?: { outcome: Outcome; reason: string };
}
export interface Execution {
  summary: string; result: "done" | "no_progress" | "blocked";
  evidence?: { ref: string; path: string; description: string }[];
  facts?: { ref: string; description: string; evidenceRefs: string[]; supersedes?: string }[];
  findings?: { key: string; title: string; target: string; status: "lead" | "technical_hit"; factRefs: string[]; evidenceRefs: string[]; next: string; impact?: Impact; pocEvidenceRef?: string }[];
}
export interface RunRequest {
  id: string; mode: Mode; snapshot: BoardSnapshot; workspace: string; runDir: string; step?: Step;
  /** Public, task-local view assembled by the outer loop; never another Agent's chat. */
  context?: BlackboardContext;
  trigger?: OuterLoopTrigger;
  blackboardPath?: string;
  signal: AbortSignal; onEvent: (event: RuntimeEvent) => void;
}
export interface RunResult { output: unknown; usage: Usage }
export interface AgentRunner { run(request: RunRequest): Promise<RunResult> }
export interface RuntimeEvent {
  type: "text" | "narration" | "usage" | "thinking_start" | "thinking" | "thinking_end" | "tool_start" | "tool_update" | "tool_end" | "notice";
  mode: Mode | "chat"; text: string; toolName?: string; toolCallId?: string; isError?: boolean; blockId?: string; replayed?: boolean;
  /** Stable ID shared by one assistant message's text, thoughts and narration. */
  messageId?: string;
  usage?: Usage;
}
export interface LoopEvent {
  type: "state" | "board" | "runtime" | "notice" | "handoff" | "session" | "result";
  snapshot?: BoardSnapshot; runtime?: RuntimeEvent; message?: string; handoff?: AgentHandoff;
  /** Public summary of an already-committed proposal, never the raw model response. */
  result?: { mode: Mode; summary: string; outcome?: Outcome };
}
