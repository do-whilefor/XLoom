/** Credentials may be nested in write content, tool arguments and transcript JSON.
 * Match their encoded forms as well as plain text without decoding arbitrary output. */
export function credentialPatterns(secrets: readonly string[]): string[] {
  const patterns = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    let encoded = secret;
    for (let level = 0; level <= 4; level++) {
      patterns.add(encoded);
      encoded = JSON.stringify(encoded).slice(1, -1);
    }
  }
  return [...patterns].sort((left, right) => right.length - left.length);
}

export function redactCredentials(value: string, secrets: readonly string[]): string {
  return credentialPatterns(secrets)
    .reduce((text, secret) => text.split(secret).join("[MODEL_CREDENTIAL_REDACTED]"), value);
}
