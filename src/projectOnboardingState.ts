// ============================================================================
//  src/projectOnboardingState.ts — tracks whether the current project has
//  completed first-run onboarding and whether the onboarding hint should
//  still be shown.
//
//  Two steps are modelled: an empty directory gates on the workspace step
//  (never complete — the hint invites the first real action), a non-empty
//  one gates on the MERCURY.md step. The show/complete readers consult the
//  cached project config BEFORE any filesystem work because both run on hot
//  paths (first render, every prompt submit).
// ============================================================================
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

/**
 * Persists the completion flag once onboarding is complete. Reads the cached
 * flag first and returns immediately when set — the completeness check
 * touches the filesystem and the prompt-submit path calls this on every
 * submission.
 */
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

/**
 * Whether to render the onboarding hint. Evaluated once per process — it
 * runs during first render, so the cached config is consulted before any
 * filesystem work.
 */
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

/**
 * The rendered first-run hint (FC-134): the first enabled, incomplete
 * step's own text — or undefined once onboarding is complete, the seen
 * budget is spent, or nothing applies. This module composed the hints and
 * the show gate for a first-run step that never ran: nothing consumed
 * them, the seen counter had no caller, and every project record kept
 * projectOnboardingSeenCount 0 forever. The composer's idle placeholder
 * is the consumer now. Memoized per process beside the show gate (both
 * sit on the first-render path).
 */
export const projectOnboardingHint = memoize((): string | undefined => {
  if (!shouldShowProjectOnboarding()) return undefined
  const step = getSteps().find(s => s.isEnabled && s.isCompletable && !s.isComplete)
  return step?.text
})

let seenBumpedThisProcess = false

/** Record one SHOWING per session (the budget is sessions, not frames):
 *  the first paint bumps the persisted count once, later paints are free. */
export function noteProjectOnboardingShown(): void {
  if (seenBumpedThisProcess) return
  seenBumpedThisProcess = true
  incrementProjectOnboardingSeenCount()
}
