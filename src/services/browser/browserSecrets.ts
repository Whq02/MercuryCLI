
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'

export const BROWSER_SECRET_ENV_PREFIX = 'MERCURY_BROWSER_SECRET_'
export const BROWSER_SECRET_REF_GRAMMAR = /^[A-Z][A-Z0-9_]{0,63}$/
export const BROWSER_SECRETS_FILENAME = 'browser-secrets.json'

export type BrowserSecretResolution =
  | { state: 'ok'; value: string; source: 'env' | 'file' }
  | { state: 'missing' | 'refused'; note: string }

export function resolveBrowserSecret(ref: string, opts?: { fileDir?: string }): BrowserSecretResolution {
  if (!BROWSER_SECRET_REF_GRAMMAR.test(ref)) {
    return {
      state: 'refused',
      note: `secretRef "${ref}" does not match the name grammar (UPPER_SNAKE, letter-led, up to 64 chars)`,
    }
  }
  const fromEnv = process.env[`${BROWSER_SECRET_ENV_PREFIX}${ref}`]
  if (typeof fromEnv === 'string' && fromEnv !== '') return { state: 'ok', value: fromEnv, source: 'env' }
  const dir = opts?.fileDir ?? getMercuryHome()
  const file = path.join(dir, BROWSER_SECRETS_FILENAME)
  const roads = `set ${BROWSER_SECRET_ENV_PREFIX}${ref}, or add "${ref}" to ${file} (owner-only file mode)`
  let raw: string
  try {
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777
      if ((mode & 0o077) !== 0) {
        return {
          state: 'refused',
          note: `${file} is readable beyond its owner (mode ${mode.toString(8)}) — chmod 600 it; the secret was not read`,
        }
      }
    }
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { state: 'missing', note: `secret ${ref} is not registered — ${roads}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'refused', note: `${file} is not valid JSON — expected a flat {"NAME": "value"} object` }
  }
  const value = (parsed as Record<string, unknown>)?.[ref]
  if (typeof value === 'string' && value !== '') return { state: 'ok', value, source: 'file' }
  return { state: 'missing', note: `secret ${ref} is not registered — ${roads}` }
}

export function scrubSecretFromText(text: string, value: string, ref: string): string {
  if (value === '') return text
  return text.split(value).join(`[redacted:${ref}]`)
}
