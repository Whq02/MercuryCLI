import type { CheckSpec } from '../../healthReport.js'
import '../../../substrate/flagRegistry.js'
import '../../../substrate/startupMenu.js'
import '../../cwd.js'
import '../../permissions/capabilityGate.js'
import '../../model/model.js'
import '../../model/frontierPolicy.js'
import '../../model/computedDefault.js'
import '../../../services/providers/routeLaw.js'
import '../../../services/instructions/engine.js'
import '../../../services/instructions/listing.js'
import '../../cockpit/promptProvenance.js'
import '../../settings/allErrors.js'
import '../../text/hiddenCharacterFindings.js'
import '../../text/hiddenCodePoints.js'
import '../../settings/constants.js'
import '../../settings/settings.js'
import '../../../services/providers/idSpaces.js'
import '../../healthReport.js'
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
