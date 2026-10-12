import { detectSecrets } from '../utils/detectSecrets.js'

export function memorySecretRefusal(text: string): string | null {
  const found = detectSecrets(text)
  if (found.length === 0) return null
  const kinds = [...new Set(found.map(match => match.kind))].join(', ')
  return `looks like a secret (${kinds}) — memory is a plain-text record on disk and never holds a key, a token or a password; keep credentials in the environment or the keychain`
}
