import { registerDefaultProviderCapabilities } from '../providers/registerCapabilities.js'

let booted = false

export function registerBootDoors(): void {
  if (booted) return
  booted = true
  registerDefaultProviderCapabilities()
}
