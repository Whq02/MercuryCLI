import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, normalize, sep } from 'node:path'
import { memoize } from 'lodash-es'
import { getMercuryHome, isEnvTruthy } from '../utils/envUtils.js'
import { getInitialSettings, getSettingsForSource } from '../utils/settings/settings.js'
import { findCanonicalGitRoot } from '../utils/git.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { sanitizePathComponent } from '../utils/tasks.js'
import { capSanitizedName } from '../utils/sessionStoragePortable.js'
import { projectDirectoryIdentity, resolveProjectStore, type StoreSpellingRules } from '../utils/projectStoreIdentity.js'

export function isMnemeEnabled(): boolean {
  if (isEnvTruthy(process.env.MERCURY_BARE)) return false
  const setting = getInitialSettings().memory?.enabled
  if (setting !== undefined) return setting
  return true
}

export function getMemoryBaseDir(): string {
  return getMercuryHome()
}

function readMnemeDirectoryOverride(): string | undefined {
  for (const source of ['policySettings', 'flagSettings', 'localSettings', 'userSettings'] as const) {
    const value = getSettingsForSource(source)?.memory?.directory
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

export function hasMnemeHomeOverride(): boolean {
  return false
}

export const getMnemeHome = memoize((): string => {
  const override = validateMemoryPathOverride(readMnemeDirectoryOverride())
  if (override !== undefined) return override
  const key = mnemeProjectKey()
  return `${join(getMemoryBaseDir(), 'projects', key, 'memory')}${sep}`.normalize('NFC')
}, () => `${getMemoryBaseDir()}\0${getProjectRoot()}`)

const mnemeProjectKeyMemo = new Map<string, string>()
const foldMemoryRoot = (root: string): string => findCanonicalGitRoot(root) ?? root
const memorySpellingRules: StoreSpellingRules = {
  fold: foldMemoryRoot,
  spellingBody: name => name,
  slugMatches: (name, spelling) => {
    const plain = sanitizePathComponent(spelling)
    return name === plain || name === capSanitizedName(plain, spelling)
  },
}

export function mnemeProjectKeyFor(root: string): string {
  const projects = join(getMemoryBaseDir(), 'projects')
  const spelled = `${projects}\0${root}`
  const memoised = mnemeProjectKeyMemo.get(spelled)
  if (memoised !== undefined) return memoised
  const identity = projectDirectoryIdentity(root, foldMemoryRoot)
  const canonicalKey = `${projects}\0${identity.canonical}`
  const byCanonical = mnemeProjectKeyMemo.get(canonicalKey)
  if (byCanonical !== undefined) {
    if (identity.exists) mnemeProjectKeyMemo.set(spelled, byCanonical)
    return byCanonical
  }
  const uncapped = sanitizePathComponent(identity.canonical)
  const capped = capSanitizedName(uncapped, identity.canonical)
  const candidate = capped !== uncapped && !existsSync(join(projects, capped)) && existsSync(join(projects, uncapped)) ? uncapped : capped
  const key = basename(resolveProjectStore(projects, identity, candidate, memorySpellingRules))
  if (identity.exists) {
    mnemeProjectKeyMemo.set(spelled, key)
    mnemeProjectKeyMemo.set(canonicalKey, key)
  }
  return key
}

export function mnemeProjectKey(): string {
  return mnemeProjectKeyFor(getProjectRoot())
}

export function projectRecordsDir(projectKey: string): string {
  return join(getMemoryBaseDir(), 'projects', projectKey)
}

export function lineagePath(projectKey: string): string {
  return join(projectRecordsDir(projectKey), 'lineage', 'ledger.jsonl')
}

export function isMnemePath(absolutePath: string): boolean {
  return normalize(absolutePath).startsWith(getMnemeHome())
}
