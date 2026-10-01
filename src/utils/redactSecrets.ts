import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_PROVIDER_CREDENTIAL_ENV_VARS } from '../services/providers/credentialEnvSpellings.js'
import { getApiKeyFromConfigOrMacOSKeychain } from './auth.js'
import { getAuthConfigHomeDir } from './envUtils.js'
import { getSecureStorage } from './secureStorage/index.js'
import { redactSecrets as redactKnownShapes } from './secrets/secretScanner.js'

export const SECRET_REDACTION = '[redacted]'
const SECRET_NAME = /(?:api[-_]?key|private[-_]?key|token|password|passwd|secret|authorization|credential)s?$/i
const SECRET_ASSIGNMENT = /(\b[\w-]*(?:api[_-]?key|private[_-]?key|token|password|passwd|secret|credential)s?["']?[ \t]*[:=][ \t]*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\[redacted\]|[^\s"'&;,}\[\]<>`)]+))/gi
const PREFIXED_SECRET = /\b(?:sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9_])/g

function stringsIn(value: unknown, all: boolean, into: Set<string>): void {
  if (typeof value === 'string') {
    if (all && value) into.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, all, into)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) stringsIn(item, all || SECRET_NAME.test(key) || key === 'key', into)
  }
}

export async function sessionSecretValues(): Promise<string[]> {
  const values = new Set<string>()
  stringsIn(await getSecureStorage().readAsync(), true, values)
  stringsIn(getApiKeyFromConfigOrMacOSKeychain(), true, values)
  for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) stringsIn(process.env[name], true, values)
  const home = getAuthConfigHomeDir()
  for (const file of [
    '.credentials.json', '.provider-secrets.json', '.openai-auth.json', '.openrouter-auth.json',
    '.gemini-auth.json', '.huggingface-auth.json', '.moonshot-auth.json', '.xai-auth.json',
  ]) {
    let text: string
    try {
      text = readFileSync(join(home, file), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error('The credential store could not be read; nothing was exported.')
    }
    try {
      stringsIn(JSON.parse(text), file === '.credentials.json', values)
    } catch {
      throw new Error('The credential store could not be read; nothing was exported.')
    }
  }
  return [...values]
}

function redactAuthorization(value: string): string {
  const scheme = value.match(/^(?:Bearer|Basic|Digest)[ \t]+/i)?.[0] ?? ''
  return scheme + SECRET_REDACTION
}

export function createSecretRedactor(knownSecrets: readonly string[] = []): (text: string) => string {
  const values = [...new Set(knownSecrets.filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length)
  const exact = values.length ? new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null
  return (text: string): string => {
    let result = exact ? text.replace(exact, () => SECRET_REDACTION) : text
    result = result.replace(/-----BEGIN[ A-Z0-9_-]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[ A-Z0-9_-]*PRIVATE KEY(?: BLOCK)?-----|$)/gi, SECRET_REDACTION)
    result = result.replace(PREFIXED_SECRET, SECRET_REDACTION)
    result = redactKnownShapes(result, SECRET_REDACTION)
    result = result.replace(/(\bBearer[ \t]+)[A-Za-z0-9._~+\/-]+=*/gi, `$1${SECRET_REDACTION}`)
    result = result.replace(/(['"])((?:proxy-)?authorization[ \t]*:[ \t]*)((?:\\.|(?!\1)[^\\])*)\1/gi,
      (_match, quote: string, prefix: string, value: string) => `${quote}${prefix}${redactAuthorization(value)}${quote}`)
    result = result.replace(/^([ \t]*(?:proxy-)?authorization[ \t]*:[ \t]*)([^\r\n]*)/gim,
      (_match, prefix: string, value: string) => prefix + redactAuthorization(value))
    result = result.replace(/(\b(?:proxy-)?authorization\b["']?[ \t]*[:=][ \t]*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|((?:(?:Bearer|Basic|Digest)[ \t]+)?(?:\[redacted\]|[^\s"'&,;}\[\]<>`]+)))/gi,
      (_match, prefix: string, double: string | undefined, single: string | undefined, bare: string | undefined) => {
        const quote = double !== undefined ? '"' : single !== undefined ? "'" : ''
        return `${prefix}${quote}${redactAuthorization(double ?? single ?? bare ?? '')}${quote}`
      })
    return result.replace(SECRET_ASSIGNMENT,
      (_match, prefix: string, double: string | undefined, single: string | undefined) => {
        const quote = double !== undefined ? '"' : single !== undefined ? "'" : ''
        return `${prefix}${quote}${SECRET_REDACTION}${quote}`
      })
  }
}

export function redactSecretValues<T>(value: T, redact: (text: string) => string, secret = false): T {
  if (typeof value === 'string') return (secret && value ? SECRET_REDACTION : redact(value)) as T
  if (Array.isArray(value)) return value.map(item => redactSecretValues(item, redact, secret)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redact(key),
      /^(?:proxy-)?authorization$/i.test(key) && typeof item === 'string' && item
        ? redactAuthorization(item)
        : redactSecretValues(item, redact, secret || SECRET_NAME.test(key)),
    ])) as T
  }
  return value
}
