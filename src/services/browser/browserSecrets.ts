// ============================================================================
//  services/browser/browserSecrets — out-of-band named secrets for the
//  Browser tool's secretRef fill (the credential road's ruled stage 1).
//
//  The contract that makes the road safe: the VALUE never travels through a
//  model-visible surface. It is registered OUT OF BAND (never by a tool op),
//  resolved at fill time inside the acting call, absent from results and
//  provenance by construction, scrubbed from error text as a last resort,
//  and the env family is stripped from every spawned child's environment
//  (utils/subprocessEnv.ts) so a shell or MCP server can never read it.
//
//  Registration roads, in resolution order:
//    1. MERCURY_BROWSER_SECRET_<NAME> environment variables (ephemeral,
//       headless- and CI-clean; wins over the file so a shell override is
//       always possible);
//    2. <configHome>/browser-secrets.json — a flat {"NAME": "value"} object
//       that must be OWNER-ONLY on POSIX (mode group/other bits clear); a
//       wider mode refuses BY NAME rather than reading the file. win32 has
//       no POSIX modes — the check is skipped there, named in the note.
//  OS keychains are the ratified later sugar, not the floor.
// ============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'

/** The env family's spelling — also the subprocess-scrub prefix. */
export const BROWSER_SECRET_ENV_PREFIX = 'MERCURY_BROWSER_SECRET_'
/** Ref grammar: env-safe upper snake, 1-64 chars, letter-led. */
export const BROWSER_SECRET_REF_GRAMMAR = /^[A-Z][A-Z0-9_]{0,63}$/
export const BROWSER_SECRETS_FILENAME = 'browser-secrets.json'

export type BrowserSecretResolution =
  | { state: 'ok'; value: string; source: 'env' | 'file' }
  /** Notes are VALUE-FREE by construction — they name refs, roads and
   *  modes, never content. */
  | { state: 'missing' | 'refused'; note: string }

/** Resolve a named secret. `fileDir` is a proof seam (defaults to the
 *  config home); the returned note strings never carry secret content. */
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

/** Replace every occurrence of a resolved secret value in text with a
 *  named marker — the last-resort rail for error paths that might echo
 *  input (results built from driver messages). Deterministic, total. */
export function scrubSecretFromText(text: string, value: string, ref: string): string {
  if (value === '') return text
  return text.split(value).join(`[redacted:${ref}]`)
}
