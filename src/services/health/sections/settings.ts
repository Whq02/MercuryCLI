import type { CheckSpec } from '../healthReport.js'
import { managedPolicyCheck, settingsCheck, envLimitsCheck, keybindingsCheck, flagsCheck, killsCheck, wardsCheck } from './settings/sources.js'
import { modelCheck, frontierCheck } from './settings/model.js'
import { instructionProfileCheck, hiddenCharactersCheck, requestContextCheck, memoryLifecycleCheck } from './settings/prompt.js'

export function settingsChecks(): CheckSpec[] {
  return [
    managedPolicyCheck(),
    settingsCheck(),
    envLimitsCheck(),
    keybindingsCheck(),
    modelCheck(),
    frontierCheck(),
    instructionProfileCheck(),
    hiddenCharactersCheck(),
    requestContextCheck(),
    flagsCheck(),
    killsCheck(),
    wardsCheck(),
    memoryLifecycleCheck(),
  ]
}
