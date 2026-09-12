const OUTPUT_LIMIT = 9000;
const SUMMARY_LIMIT = 240;
const OMITTED = "\n… [output omitted] …\n";

/** The caller supplies terminal-safe text and the tool's actual error status. */
export function retainToolOutput(text: string, isError: boolean): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  if (!isError) return text.slice(0, OUTPUT_LIMIT);
  const headLength = Math.floor((OUTPUT_LIMIT - OMITTED.length) / 2);
  const tailLength = OUTPUT_LIMIT - OMITTED.length - headLength;
  return text.slice(0, headLength) + OMITTED + text.slice(-tailLength);
}

const commandStatus = /^Command (?:exited with code -?\d+|timed out after .+|aborted)$/i;
const diagnostic = /^(?:(?:[\w.]*Error|[\w.]*Exception|E[A-Z][A-Z0-9_]+)\s*:|The term .+ is not recognized\b|Cannot find path\b)/;

/** Summarize an already-failed tool without interpreting its output as success/failure. */
export function summarizeToolFailure(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.trim().replace(/^\|\s*/, "")).filter(Boolean);
  const status = lines.findLast(line => commandStatus.test(line));
  const reason = lines.findLast(line => diagnostic.test(line));
  if (status || reason) {
    const summary = [status, reason].filter(Boolean).join(" · ").replace(/\s+/g, " ");
    return summary.length <= SUMMARY_LIMIT ? summary : summary.slice(0, SUMMARY_LIMIT - 1) + "…";
  }
  const tail = lines.join(" ").replace(/\s+/g, " ").trim();
  return tail.length <= SUMMARY_LIMIT ? tail : "…" + tail.slice(-(SUMMARY_LIMIT - 1));
}
