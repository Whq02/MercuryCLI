import { registerDefaultProviderCapabilities } from '../providers/registerCapabilities.js'
import { registerOtherBuildAliveProbe } from '../../utils/secureStorage/otherBuildsRegistry.js'
import { registerLoadedInstructionsPeek } from '../../utils/permissions/decision/loadedInstructionsPeek.js'
import { registerDefaultModelHookRunners } from '../hooks/registerRunners.js'
import { registerDefaultTranscriptProjector } from '../sessionStorage/registerTranscriptProjector.js'
let booted = false

export function registerBootDoors(): void {
  if (booted) return
  booted = true
  registerDefaultProviderCapabilities()
  registerOtherBuildAliveProbe(() => {
    const { otherBuildAlive } = require('../../daemon/otherBuilds.js') as typeof import('../../daemon/otherBuilds.js')
    return otherBuildAlive()
  })
  registerLoadedInstructionsPeek(() => {
    const { getInstructionFiles } = require('../instructions/engine.js') as typeof import('../instructions/engine.js')
    return getInstructionFiles.cache.get(undefined)
  })
  registerDefaultModelHookRunners()
  registerDefaultTranscriptProjector()
}
