import { flagEnv } from './substrate/flagRegistry.js'
import { composedGuideFilesAt } from './services/instructions/adapters/index.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { memoizeByCwd } from './utils/cwdMemo.js'
import { getFsImplementation } from './utils/fsOperations.js'
import { passedOver } from './utils/passedOver.js'

const ONBOARDING_SEEN_COUNT_LIMIT = 4
const ONBOARDING_MEMO_CAP = 50

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
  const empty = isWorkingDirectoryEmpty()
  const hasGuide = composedGuideFilesAt(getCwd()).length > 0
  return [
    {
      key: 'workspace',
      text: 'Ask me to build a fresh app here, or to clone a repository you already work in',
      isComplete: false,
      isCompletable: true,
      isEnabled: empty,
    },
    {
      key: 'mercurymd',
      text: 'Run /orient to create a MERCURY.md file with standing orders for this project',
      isComplete: hasGuide,
      isCompletable: true,
      isEnabled: !empty,
    },
  ]
}

function isProjectOnboardingComplete(): boolean {
  return getSteps()
    .filter(step => step.isEnabled && step.isCompletable)
    .every(step => step.isComplete)
}

export function maybeMarkProjectOnboardingComplete(): void {
  const config = getCurrentProjectConfig()
  if (config.hasCompletedProjectOnboarding) return
  if (!isProjectOnboardingComplete()) return
  saveCurrentProjectConfig(current => ({
    ...current,
    hasCompletedProjectOnboarding: true,
  }))
}

export const shouldShowProjectOnboarding = memoizeByCwd((): boolean => {
  const config = getCurrentProjectConfig()
  if (config.hasCompletedProjectOnboarding) return false
  if ((config.projectOnboardingSeenCount ?? 0) >= ONBOARDING_SEEN_COUNT_LIMIT) return false
  if (flagEnv('MERCURY_DEMO')) return false
  return !isProjectOnboardingComplete()
}, ONBOARDING_MEMO_CAP)

export function incrementProjectOnboardingSeenCount(): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    projectOnboardingSeenCount: (current.projectOnboardingSeenCount ?? 0) + 1,
  }))
}

export const projectOnboardingHint = memoizeByCwd((): string | undefined => {
  if (!shouldShowProjectOnboarding()) return undefined
  const step = getSteps().find(s => s.isEnabled && s.isCompletable && !s.isComplete)
  return step?.text
}, ONBOARDING_MEMO_CAP)

let seenBumpedThisProcess = false

export function noteProjectOnboardingShown(): void {
  if (seenBumpedThisProcess) return
  seenBumpedThisProcess = true
  incrementProjectOnboardingSeenCount()
}
