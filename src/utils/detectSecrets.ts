type SecretMatch = { kind: string; redacted: string }

const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  {
    kind: 'secret-assignment',
    re: /\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{16,}/i,
  },
  { kind: 'credentials-file', re: /\.credentials\.json\b/ },
]

export function detectSecrets(text: string): SecretMatch[] {
  if (!text) return []
  const out: SecretMatch[] = []
  for (const { kind, re } of SECRET_PATTERNS) {
    const m = text.match(re)
    if (m) out.push({ kind, redacted: '[redacted]' })
  }
  return out
}
