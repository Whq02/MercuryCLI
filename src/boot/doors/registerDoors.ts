import { registerDefaultProviderCapabilities } from '../../models/roads/registerCapabilities.js'
import { registerOtherBuildAliveProbe } from '../../platform/secure-storage/otherBuildsRegistry.js'
import { registerLoadedInstructionsPeek } from '../../permissions/rules/decision/loadedInstructionsPeek.js'
import { registerDefaultModelHookRunners } from '../../integrations/event-hook-runners/registerRunners.js'
import { registerDefaultTranscriptProjector } from '../../sessions/transcript-projector/registerTranscriptProjector.js'
let booted = false

export function registerBootDoors(): void {
  if (booted) return
  booted = true
  registerDefaultProviderCapabilities()
  registerOtherBuildAliveProbe(() => {
    const { otherBuildAlive } = require('../../daemon/control/otherBuilds.js') as typeof import('../../daemon/control/otherBuilds.js')
    return otherBuildAlive()
  })
  registerLoadedInstructionsPeek(() => {
    const { getInstructionFiles } = require('../../sessions/instructions/instructionFiles.js') as typeof import('../../sessions/instructions/instructionFiles.js')
    return getInstructionFiles.cache.get(undefined)
  })
  registerDefaultModelHookRunners()
  registerDefaultTranscriptProjector()
}
