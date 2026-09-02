import { join } from 'path'
import { memoize } from 'lodash-es'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { getFsImplementation } from './utils/fsOperations.js'

const ONBOARDING_SEEN_COUNT_LIMIT = 4

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
  } catch {
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
    text: 'Run /init to create a MERCURY.md file with standing orders for this project',
    isComplete: getFsImplementation().existsSync(join(getCwd(), 'MERCURY.md')),
    isCompletable: true,
    isEnabled: !emptyDir,
  })

  return steps
}

export function isProjectOnboardingComplete(): boolean {
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

export const shouldShowProjectOnboarding = memoize((): boolean => {
  const config = getCurrentProjectConfig()
  if (config.hasCompletedProjectOnboarding) {
    return false
  }
  if ((config.projectOnboardingSeenCount ?? 0) >= ONBOARDING_SEEN_COUNT_LIMIT) {
    return false
  }
  if (process.env.IS_DEMO) {
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

export const projectOnboardingHint = memoize((): string | undefined => {
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
