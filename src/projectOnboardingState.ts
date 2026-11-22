import { flagEnv } from './substrate/flagRegistry.js'
import { composedGuideFilesAt } from './services/instructions/adapters/index.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { memoizeByCwd } from './utils/cwdMemo.js'
import { getFsImplementation } from './utils/fsOperations.js'
import { passedOver } from './utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from './pi/holes.js'

const ONBOARDING_SEEN_COUNT_LIMIT = 4
const ONBOARDING_MEMO_CAP = 50

export type Step = Unbuilt

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
  return notBuilt('src/projectOnboardingState.ts:30')
}

export function maybeMarkProjectOnboardingComplete(): void {
  return notBuilt('src/projectOnboardingState.ts:59')
}

export const shouldShowProjectOnboarding: Unbuilt = unbuilt('src/projectOnboardingState.ts:72')

export function incrementProjectOnboardingSeenCount(): void {
  return notBuilt('src/projectOnboardingState.ts:86')
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
