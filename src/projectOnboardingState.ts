import { resolve } from 'node:path'
import { flagEnv } from './substrate/flagRegistry.js'
import { composedGuideFilesAt } from './services/instructions/adapters/index.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { getFsImplementation } from './utils/fsOperations.js'
import { passedOver } from './utils/passedOver.js'

const ONBOARDING_SEEN_COUNT_LIMIT = 4
const ONBOARDING_MEMO_CAP = 50

type OnboardingMemoCache<V> = {
  has(key: unknown): boolean
  get(key: unknown): V | undefined
  set(key: unknown, value: V): OnboardingMemoCache<V>
  delete(key: unknown): boolean
  clear(): void
  readonly size: number
}

function memoizeByCwd<T>(
  compute: () => T,
): (() => T) & { cache: OnboardingMemoCache<T> } {
  const entries = new Map<string, T>()
  const keyOf = (key: unknown): string => (key === undefined ? resolve(getCwd()) : resolve(String(key)))
  const cache: OnboardingMemoCache<T> = {
    has: (key: unknown) => entries.has(keyOf(key)),
    get: (key: unknown) => entries.get(keyOf(key)),
    set: (key: unknown, value: T) => {
      const k = keyOf(key)
      if (entries.has(k)) {
        entries.delete(k)
      } else if (entries.size >= ONBOARDING_MEMO_CAP) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
      entries.set(k, value)
      return cache
    },
    delete: (key: unknown) => entries.delete(keyOf(key)),
    clear: () => {
      entries.clear()
    },
    get size(): number {
      return entries.size
    },
  }
  const memo = (): T => {
    const k = resolve(getCwd())
    if (entries.has(k)) {
      const hit = entries.get(k) as T
      entries.delete(k)
      entries.set(k, hit)
      return hit
    }
    const value = compute()
    cache.set(k, value)
    return value
  }
  memo.cache = cache
  return memo
}

export type Step = {
  key: string
  text: string
  isComplete: boolean
  isCompletable: boolean
  isEnabled: boolean
}

function isWorkingDirectoryEmpty(): boolean {
  const fs = getFsImplementation()
  try {
    return fs.readdirSync(getCwd()).length === 0
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function getSteps(): Step[] {
  const emptyDir = isWorkingDirectoryEmpty()
  const steps: Step[] = []

  steps.push({
    key: 'workspace',
    text: 'Ask me to build a fresh app here, or to clone a repository you already work in',
    isComplete: false,
    isCompletable: true,
    isEnabled: emptyDir,
  })

  steps.push({
    key: 'mercurymd',
    text: 'Run /orient to create a MERCURY.md file with standing orders for this project',
    isComplete: composedGuideFilesAt(getCwd()).length > 0,
    isCompletable: true,
    isEnabled: !emptyDir,
  })

  return steps
}

function isProjectOnboardingComplete(): boolean {
  return getSteps()
    .filter(step => step.isCompletable && step.isEnabled)
    .every(step => step.isComplete)
}

export function maybeMarkProjectOnboardingComplete(): void {
  const config = getCurrentProjectConfig()
  if (config.hasCompletedProjectOnboarding) {
    return
  }
  if (isProjectOnboardingComplete()) {
    saveCurrentProjectConfig(currentConfig => ({
      ...currentConfig,
      hasCompletedProjectOnboarding: true,
    }))
  }
}

export const shouldShowProjectOnboarding = memoizeByCwd((): boolean => {
  const config = getCurrentProjectConfig()
  if (config.hasCompletedProjectOnboarding) {
    return false
  }
  if ((config.projectOnboardingSeenCount ?? 0) >= ONBOARDING_SEEN_COUNT_LIMIT) {
    return false
  }
  if (flagEnv('MERCURY_DEMO')) {
    return false
  }
  return !isProjectOnboardingComplete()
})

export function incrementProjectOnboardingSeenCount(): void {
  saveCurrentProjectConfig(currentConfig => ({
    ...currentConfig,
    projectOnboardingSeenCount: (currentConfig.projectOnboardingSeenCount ?? 0) + 1,
  }))
}

export const projectOnboardingHint = memoizeByCwd((): string | undefined => {
  if (!shouldShowProjectOnboarding()) return undefined
  const step = getSteps().find(s => s.isEnabled && s.isCompletable && !s.isComplete)
  return step?.text
})

let seenBumpedThisProcess = false

export function noteProjectOnboardingShown(): void {
  if (seenBumpedThisProcess) return
  seenBumpedThisProcess = true
  incrementProjectOnboardingSeenCount()
}
