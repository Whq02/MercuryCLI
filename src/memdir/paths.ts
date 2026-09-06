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

export function isAutoMemoryEnabled(): boolean {
  if (isEnvTruthy(process.env.MERCURY_BARE)) return false
  const setting = getInitialSettings().autoMemoryEnabled
  if (setting !== undefined) return setting
  return true
}

export function relevantMemoryRecallEnabled(): boolean {
  if (getFeatureValue_CACHED_MAY_BE_STALE('mercury_moth_copse', false)) return true
  return flagEnv('MERCURY_RELEVANT_RECALL') === '1'
}

export function filterInjectedMemoryFilesByRecall<T extends { type: string }>(
  files: T[],
  recallOn: boolean,
): T[] {
  if (!recallOn) return [...files]
  return files.filter(file => file.type !== 'AutoMem' && file.type !== 'TeamMem')
}

export function getMemoryBaseDir(): string {
  return getMercuryHome()
}

function readAutoMemoryDirectoryOverride(): string | undefined {
  for (const source of ['policySettings', 'flagSettings', 'localSettings', 'userSettings'] as const) {
    const value = (getSettingsForSource(source) as { autoMemoryDirectory?: string } | undefined)
      ?.autoMemoryDirectory
    if (value !== undefined) return value
  }
  return undefined
}

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

export function hasAutoMemPathOverride(): boolean {
  return false
}

export const getAutoMemPath = memoize((): string => {
  const override = validateMemoryPathOverride(readAutoMemoryDirectoryOverride())
  if (override !== undefined) return override
  const projectRoot = getProjectRoot()
  const canonical = findCanonicalGitRoot(projectRoot) ?? projectRoot
  const key = sanitizePathComponent(canonical)
  return `${join(getMemoryBaseDir(), 'projects', key, 'memory')}${sep}`.normalize('NFC')
}, () => getProjectRoot())

export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return join(getAutoMemPath(), 'logs', year, month, `${year}-${month}-${day}.md`)
}

export function getAutoMemEntrypoint(): string {
  return `${getAutoMemPath()}MEMORY.md`
}

export function isAutoMemPath(absolutePath: string): boolean {
  return normalize(absolutePath).startsWith(getAutoMemPath())
}
