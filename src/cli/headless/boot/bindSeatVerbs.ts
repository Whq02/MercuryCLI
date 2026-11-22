import { getSettingsWithSources } from '../../../utils/settings/settings.js'
import { parseUserSpecifiedModel, getEngineModel, renderModelName } from '../../../services/model/model.js'
import { commandOutputRow } from '../../../rows/project.js'
import { recordTranscript } from '../../../utils/sessionStorage/writer.js'
import { logForDebugging } from '../../../utils/debug.js'
import { setEngineModelOverride } from '../../../bootstrap/state.js'
import { setFlagEnv } from '../../../substrate/flagRegistry.js'
import { saveSessionModel } from '../../../utils/sessionStorage.js'
import { isEffortLevel } from '../../../utils/effort.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { notBuilt } from '../../../pi/holes.js'

function run(ports: RunnerPorts): BootMade<'injectModelSwitchBreadcrumbs' | 'applySeatModel' | 'applySeatEffort'> {
  return notBuilt('src/cli/headless/boot/bindSeatVerbs.ts:12')
}

export const bindSeatVerbs: BootStep<'injectModelSwitchBreadcrumbs' | 'applySeatModel' | 'applySeatEffort'> = { name: 'bindSeatVerbs', makes: ['injectModelSwitchBreadcrumbs', 'applySeatModel', 'applySeatEffort'], run }
