import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { ProjectConfig, Usage } from "../types.js";

/** No turn cap by default. Explicit caps reserve a final reporting turn;
 * resource/time cancellation always takes precedence. */
export function createRunBudget(limits: ProjectConfig["limits"], usage: Usage, spent: Usage,
  protocol: "chat" | "agent", signal: AbortSignal) {
  let turns = 0;
  let stoppedBy: string | undefined;
  const maxTurns = limits.maxTurnsPerRun;
  const finalInstruction = protocol === "chat"
    ? "This is the final allowed model turn. Tools are unavailable. Give a concise final reply using only results already observed. Clearly state unfinished work or missing evidence; do not claim success merely because this invocation is ending."
    : "This is the final allowed model turn. Tools are unavailable. Return the required single JSON object using only results already observed and artifacts already written. For an unfinished Execute Step, report no_progress or blocked honestly with available evidence; for Decide, propose a bounded next Step. Do not invent artifacts, facts, evidence or Goal completion merely because this invocation is ending.";
  const instruction = maxTurns === null
    ? "No application model-turn limit is configured. Use tools as needed for the assigned work, preserve observed evidence, and return the required final result when ready. A count is not a completion condition."
    : `Invocation budget: maxTurnsPerRun=${maxTurns}, including a reserved final reporting turn. At most ${maxTurns - 1} model turns may use tools. Save necessary artifacts before the final turn. This invocation's end does not mean the user's Goal is complete.`;
  const shouldStopAfterTurn: NonNullable<AgentOptions["shouldStopAfterTurn"]> = ({ message }) => {
    turns++;
    const tokens = spent.input + spent.output + usage.input + usage.output;
    const cost = spent.cost + usage.cost;
    const reason = limits.maxTokens !== null && tokens >= limits.maxTokens ? `maxTokens=${limits.maxTokens}, tokens=${tokens}`
      : limits.maxCost !== null && cost >= limits.maxCost ? `maxCost=${limits.maxCost}, cost=${cost}`
      : maxTurns !== null && turns >= maxTurns ? `maxTurnsPerRun=${maxTurns}, turns=${turns}` : undefined;
    if (reason && message.content.some(part => part.type === "toolCall")) stoppedBy = reason;
    return reason !== undefined;
  };
  const prepareNextTurnWithContext: NonNullable<AgentOptions["prepareNextTurnWithContext"]> = ({ context }) => {
    signal.throwIfAborted();
    if (maxTurns === null || turns !== maxTurns - 1) return;
    // Pi captures tools when starting the loop: replacing the NEXT context is
    // required. Changing Agent.state.tools mid-loop would leave tools enabled.
    return { context: { ...context, tools: [], systemPrompt: `${context.systemPrompt}\n\n${finalInstruction}` } };
  };
  return {
    get canRequest(): boolean {
      return !signal.aborted && (maxTurns === null || turns < maxTurns)
        && (limits.maxTokens === null || spent.input + spent.output + usage.input + usage.output < limits.maxTokens)
        && (limits.maxCost === null || spent.cost + usage.cost < limits.maxCost);
    },
    instruction: `${instruction}${maxTurns === 1 ? `\n${finalInstruction}` : ""}`,
    toolsAllowed: maxTurns === null || maxTurns > 1,
    shouldStopAfterTurn,
    prepareNextTurnWithContext,
    get error(): string | undefined {
      if (!stoppedBy) return;
      return protocol === "chat"
        ? `Chat response budget reached before a final reply (${stoppedBy}); tool side effects may remain. Inspect results before retrying.`
        : `Agent budget reached before a final result (${stoppedBy}); the Step may have partial side effects. Inspect artifacts before retrying.`;
    },
  };
}
