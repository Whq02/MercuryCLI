import { registerDefaultProviderCapabilities } from '../providers/registerCapabilities.js'
import { registerOtherBuildAliveDoor } from '../../daemon/otherBuilds.js'
import { registerDefaultModelHookRunners } from '../hooks/registerRunners.js'

let booted = false

export function registerBootDoors(): void {
  if (booted) return
  booted = true
  registerDefaultProviderCapabilities()
  registerOtherBuildAliveDoor()
  registerDefaultModelHookRunners()
}
