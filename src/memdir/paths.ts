// ============================================================================
//  src/memdir/paths.ts — memory enablement gates and memory-directory
//  resolution with path validation.
// ============================================================================
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { memoize } from 'lodash-es'
import { getMercuryHome, isEnvTruthy } from '../utils/envUtils.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getInitialSettings, getSettingsForSource } from '../utils/settings/settings.js'
import { findCanonicalGitRoot } from '../utils/git.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { sanitizePathComponent } from '../utils/tasks.js'

/**
 * Auto memory is on by default. Priority chain, first defined wins:
 * 1. MERCURY_SIMPLE truthy → disabled (the prompt path already omits
 *    the memory section; this stops the other half — background
 *    maintenance, the remember command, team sync).
 * 2. The settings key autoMemoryEnabled, when defined.
 * 3. Default: enabled.
 * (autoMemoryEnabled in settings is the off switch — no env kill.)
 */
export function isAutoMemoryEnabled(): boolean {
  if (isEnvTruthy(process.env.MERCURY_SIMPLE)) return false
  const setting = getInitialSettings().autoMemoryEnabled
  if (setting !== undefined) return setting
  return true
}

/**
 * Relevant-memory recall is default-off: on when the feature flag is true
 * (`mercury_moth_copse`, default false — resolves to its default through the
 * empty gate table in this build) OR when MERCURY_RELEVANT_RECALL reads
 * exactly '1'. The env is read fresh on every call so it takes effect
 * without a restart.
 */
export function relevantMemoryRecallEnabled(): boolean {
  if (getFeatureValue_CACHED_MAY_BE_STALE('mercury_moth_copse', false)) return true
  return flagEnv('MERCURY_RELEVANT_RECALL') === '1'
}

/**
 * Filters an injected-instruction-file list by recall state: off returns a
 * fresh copy unchanged; on drops entries whose type is `AutoMem` or
 * `TeamMem` (contract data — the instruction engine's own discriminator
 * spellings). Generic so it carries no dependency on the engine.
 */
export function filterInjectedMemoryFilesByRecall<T extends { type: string }>(
  files: T[],
  recallOn: boolean,
): T[] {
  if (!recallOn) return [...files]
  return files.filter(file => file.type !== 'AutoMem' && file.type !== 'TeamMem')
}

/** The memory base directory is the resolved config home. */
export function getMemoryBaseDir(): string {
  return getMercuryHome()
}

/**
 * Settings-override read: `autoMemoryDirectory` from policySettings,
 * flagSettings, localSettings, then userSettings — first defined wins.
 * projectSettings is DELIBERATELY excluded: a malicious repository could
 * otherwise point memory at a sensitive directory and gain silent write
 * access through the filesystem write carve-out for memory paths.
 */
function readAutoMemoryDirectoryOverride(): string | undefined {
  for (const source of ['policySettings', 'flagSettings', 'localSettings', 'userSettings'] as const) {
    const value = (getSettingsForSource(source) as { autoMemoryDirectory?: string } | undefined)
      ?.autoMemoryDirectory
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Validate an override candidate. Empty/unset → undefined. Settings-sourced
 * values may use a leading `~/` or `~\` (expanded against home), but a
 * remainder normalizing to `.` or `..` is rejected — it would expand to the
 * home directory or its parent, the same danger class as a filesystem root.
 * Then normalize, strip trailing separators, and reject: non-absolute;
 * shorter than 3 chars (a bare root); a Windows drive root; a UNC path; or
 * a NUL byte (survives normalization and truncates in syscalls). Accepted
 * values get exactly one trailing separator and NFC normalization.
 */
function validateMemoryPathOverride(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  let candidate = raw
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    const remainder = candidate.slice(2)
    const normalizedRemainder = normalize(remainder)
    if (normalizedRemainder === '.' || normalizedRemainder === '..') return undefined
    candidate = join(homedir(), remainder)
  }
  let normalized = normalize(candidate)
  while (normalized.length > 1 && (normalized.endsWith('/') || normalized.endsWith('\\'))) {
    normalized = normalized.slice(0, -1)
  }
  if (!isAbsolute(normalized)) return undefined
  if (normalized.length < 3) return undefined
  if (/^[A-Za-z]:[\\/]?$/.test(normalized)) return undefined
  if (normalized.startsWith('\\\\') || normalized.startsWith('//')) return undefined
  if (normalized.includes('\0')) return undefined
  return `${normalized}${sep}`.normalize('NFC')
}

/**
 * Reports whether a PROGRAMMATIC path override is active. The programmatic
 * producer always returns undefined in this build, so this is always
 * false — but the write carve-out is gated on it, so the seam stays.
 */
export function hasAutoMemPathOverride(): boolean {
  return false
}

/**
 * The auto-memory directory: a settings override, else
 * `<base>/projects/<sanitized-project-key>/memory/` with a trailing
 * separator, NFC-normalized. The project key is the canonical git root when
 * one is found (so every worktree of a repo shares one memory directory),
 * else the stable project root. Memoized on the project root — render-path
 * callers hit this once per tool-use message per re-render, and each miss
 * costs four settings reads with filesystem work.
 */
export const getAutoMemPath = memoize((): string => {
  const override = validateMemoryPathOverride(readAutoMemoryDirectoryOverride())
  if (override !== undefined) return override
  const projectRoot = getProjectRoot()
  const canonical = findCanonicalGitRoot(projectRoot) ?? projectRoot
  const key = sanitizePathComponent(canonical)
  return `${join(getMemoryBaseDir(), 'projects', key, 'memory')}${sep}`.normalize('NFC')
}, () => getProjectRoot())

/** Daily log: `<autoMemDir>/logs/YYYY/MM/YYYY-MM-DD.md`, zero-padded. */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return join(getAutoMemPath(), 'logs', year, month, `${year}-${month}-${day}.md`)
}

export function getAutoMemEntrypoint(): string {
  // Concatenation, not a path join — the directory's guaranteed trailing
  // separator is load-bearing for this pattern across the module.
  return `${getAutoMemPath()}MEMORY.md`
}

/**
 * Containment: normalize the candidate (defeating traversal segments) and
 * test the prefix. Caveat carried from the source record: true does NOT
 * imply write permission when a programmatic override is active — the write
 * carve-out is additionally gated on the absence of such an override; a
 * settings-sourced override does get the carve-out.
 */
export function isAutoMemPath(absolutePath: string): boolean {
  return normalize(absolutePath).startsWith(getAutoMemPath())
}
