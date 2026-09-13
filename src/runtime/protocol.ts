function jsonBody(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "") : trimmed;
}

export function parseFinalJson(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(jsonBody(text)); } catch { throw new Error("Agent final response must be a single JSON object."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent final response must be a JSON object.");
  return value as Record<string, unknown>;
}

/** Diagnose a wrapped object's other errors before spending the single repair.
 * The candidate is never accepted. Multiple objects or malformed/nested fragments
 * are not searched for alternatives: the entire outermost object must parse. */
export function validateFinalJson<T>(text: string, validate: (parsed: Record<string, unknown>) => T): T {
  let parsed: Record<string, unknown>;
  try { parsed = parseFinalJson(text); }
  catch (envelopeError) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    let candidate: Record<string, unknown> | undefined;
    // Do not unwrap a valid JSON value such as an array into a different proposal.
    let isJsonValue = false;
    try { JSON.parse(jsonBody(text)); isJsonValue = true; } catch { /* Prose or invalid JSON. */ }
    if (!isJsonValue && start >= 0 && end > start) {
      try { candidate = parseFinalJson(text.slice(start, end + 1)); } catch { /* No unambiguous object to diagnose. */ }
    }
    if (candidate) {
      try { validate(candidate); }
      catch (validationError) {
        const message = (error: unknown) => error instanceof Error ? error.message : String(error);
        throw new Error(`${message(envelopeError)} Embedded JSON diagnostics (not accepted): ${message(validationError)}`);
      }
    }
    throw envelopeError;
  }
  return validate(parsed);
}
