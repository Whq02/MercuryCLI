import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { memoize } from 'lodash-es'

import { flagEnv } from '../substrate/flagRegistry.js'

/**
 * The one config-home resolver, the auth-scope override, env truthiness
 * helpers, and provider region resolution.
 *
 * No other module may re-derive the home precedence inline: a caller that
 * hand-rolls its own spelling order splits the stores — one module reading
 * one home while the rest read another (a recorded incident class, not a
 * hypothetical).
 */

/**
 * Where this harness keeps its state. Precedence, first NON-EMPTY hit wins:
 * MERCURY_CONFIG_DIR > MERCURY_HOME (registry) > ~/.mercury.
 *
 * Library-memoized (lodash) with the cache EXPOSED — callers invalidate via
 * `getMercuryHome.cache.clear()` — and KEYED on the two env spellings, so an
 * env change re-resolves on the next call. Every returned path is
 * NFC-normalised.
 */
export const getMercuryHome = memoize((): string => {
  const resolved =
    process.env.MERCURY_CONFIG_DIR || flagEnv('MERCURY_HOME') || join(homedir(), '.mercury')
  return canonicalHomeSpelling(resolved)
}, () =>
  JSON.stringify([
    process.env.MERCURY_CONFIG_DIR ?? null,
    process.env.MERCURY_HOME ?? null,
  ]))

/**
 * One home, one spelling. The raw env string was the home: `C:\h\` and
 * `C:\h` and `C:/h` were three different homes — three derived identities,
 * a fabricated doctor fault for the trailing-separator spelling (TASK-014
 * w1-f13-02). Pure and platform-explicit so it proves on any host:
 *   · NFC (as before)
 *   · trailing separators dropped, except from a bare root (`/`, `C:\`)
 *   · on win32, forward slashes become backslashes (the OS spelling) and
 *     the drive letter is upper-cased
 * The value is never resolved against the cwd — a relative pin keeps its
 * meaning.
 */
export function canonicalHomeSpelling(raw: string, platform: string = process.platform): string {
  let s = raw.normalize('NFC')
  if (platform === 'win32') {
    s = s.replace(/\//g, '\\').replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`)
  }
  const bareRoot = platform === 'win32' ? /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\?)$/ : /^\/$/
  if (bareRoot.test(s)) return s
  s = s.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '')
  return s.length === 0 ? raw.normalize('NFC') : s
}

/**
 * Whether the home was explicitly pinned by env (either spelling). Callers
 * that enumerate sibling homes must treat an explicit pin as an isolation
 * boundary and never escape it.
 */
export function configHomeExplicitlySet(): boolean {
  return Boolean(process.env.MERCURY_CONFIG_DIR || flagEnv('MERCURY_HOME'))
}

/**
 * The config-home PIN as the environment spells it, un-canonicalised (NFC
 * only — the pre-canonicalHomeSpelling reading). Null when no pin exists:
 * the derived default home was always canonical, so only a pinned spelling
 * can differ from getMercuryHome. Exactly two readers exist by law — the
 * keychain's raw-spelling migration fallback and the identity principal's
 * adoption predicate (the identities the spelling fold moved, TASK-014
 * w1-f13-02's own warning) — everything else resolves through the one
 * canonical resolver above.
 */
export function rawConfigHomePinSpelling(): string | null {
  const raw = process.env.MERCURY_CONFIG_DIR || flagEnv('MERCURY_HOME')
  return raw ? raw.normalize('NFC') : null
}

// ---------------------------------------------------------------------------
// Auth-scope override: a session-scoped, in-memory (never persisted, never
// exported to children) redirect of ONLY the credential store to a different
// account's config directory. Transcripts, config monolith, teams, rooms and
// the daemon socket keep resolving through the plain config home.
// ---------------------------------------------------------------------------

let authScope: string | undefined

export function setAuthScope(dir: string): void {
  authScope = dir
}

export function clearAuthScope(): void {
  authScope = undefined
}

export function getAuthScope(): string | undefined {
  return authScope
}

/** The credential store's home: the auth-scope override, else the config home. */
export function getAuthConfigHomeDir(): string {
  return authScope ?? getMercuryHome()
}

/**
 * Create the config home (recursively, owner-only) when missing; otherwise
 * mask any group/other permission bits down to owner-only. Only ever clears
 * group/other bits, so the owner's own access is preserved by construction.
 * A no-op on Windows; never throws — startup must survive a failed
 * permission change.
 */
export function ensurePrivateConfigHome(): void {
  if (process.platform === 'win32') return
  try {
    const home = getMercuryHome()
    if (!existsSync(home)) {
      mkdirSync(home, { recursive: true, mode: 0o700 })
      return
    }
    const permissionBits = statSync(home).mode & 0o777
    if ((permissionBits & 0o077) !== 0) {
      chmodSync(home, permissionBits & 0o700)
    }
  } catch {
    // Best-effort privacy floor.
  }
}

/**
 * The teams directory: the registered override (used verbatim, untrimmed)
 * when set to a non-blank value, else `teams` under the config home. Every
 * team/crew/mailbox read and write must route through this so a hermetic
 * test home cannot see the operator's real roster.
 */
export function getTeamsDir(): string {
  const override = flagEnv('MERCURY_TEAMS_DIR')
  if (override !== undefined && override.trim() !== '') return override
  return join(getMercuryHome(), 'teams')
}

/**
 * The resolved home for display, tilde-contracted when it begins with the
 * user's home directory. A bare prefix test with no separator guard —
 * reproduce as built. All operator-facing labels naming the config home
 * derive from this.
 */
export function displayConfigHome(): string {
  const home = getMercuryHome()
  const userHome = homedir()
  return home.startsWith(userHome) ? `~${home.slice(userHome.length)}` : home
}

/** Exact-token search of NODE_OPTIONS (substring matching false-positives). */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) return false
  return nodeOptions.split(/\s+/).includes(flag)
}

/** True for exactly `1`, `true`, `yes`, `on` (lowercased, trimmed). */
export function isEnvTruthy(v: string | boolean | undefined): boolean {
  if (v === undefined) return false
  if (typeof v === 'boolean') return v
  const normalized = v.toLowerCase().trim()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

/**
 * True for exactly `0`, `false`, `no`, `off` (lowercased, trimmed). Note the
 * deliberate asymmetry with truthiness: an empty string is neither truthy
 * nor defined-falsy, and undefined is not defined-falsy.
 */
export function isEnvDefinedFalsy(v: string | boolean | undefined): boolean {
  if (v === undefined) return false
  if (typeof v === 'boolean') return !v
  if (v === '') return false
  const normalized = v.toLowerCase().trim()
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off'
}

/**
 * Bare/simple mode: skip hooks, language servers, the extensions load, skill walks,
 * attribution, background prefetches and ALL credential/keychain reads;
 * authentication comes only from an API-key env var or a key helper in an
 * explicit settings file. Explicitly-passed CLI flags for extension
 * directories, extra directories and MCP config are still honoured. Both
 * checks are needed because several gates run before the CLI action handler
 * translates the flag into the env var.
 */
export function isBareMode(): boolean {
  return isEnvTruthy(process.env.MERCURY_SIMPLE) || process.argv.includes('--bare')
}

/**
 * Parse repeated `KEY=VALUE` strings into a record. Split on the first `=`;
 * values may contain further equals signs. Throws on a malformed entry.
 */
export function parseEnvVars(raw: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!raw) return result
  for (const entry of raw) {
    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) {
      throw new Error(
        `Invalid environment variable "${entry}": expected the form KEY=value, e.g. -e KEY1=value1 -e KEY2=value2`,
      )
    }
    const key = entry.slice(0, separatorIndex)
    result[key] = entry.slice(separatorIndex + 1)
  }
  return result
}

/** Whether shell commands reset to the project directory after each command.
 *  The compat-era env opt-in retired default-off; the working dir persists. */
export function shouldMaintainProjectWorkingDir(): boolean {
  return false
}
