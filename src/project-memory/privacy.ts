/** Handoffs contain concise notes/metadata, never captured stdout or commands. */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|aws_secret_access_key|client_secret|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,"';}]+)/gi, "$1[REDACTED]")
    .replace(/((?:--password|--token|--api-key|--secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
export function snippet(text: string, max: number): string {
  const safe = redactSecrets(text).replace(/<!--|-->/g, "").replace(/\s+/g, " ");
  return safe.length <= max ? safe : safe.slice(0, Math.max(0, max - 14)) + "… [read full]";
}
