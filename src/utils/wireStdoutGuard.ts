import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { passedOver } from './passedOver.js'
import { startMicrotask } from './timers.js'
import { notBuilt } from '../pi/holes.js'


const STDOUT_GUARD_MARKER = '[stdout-guard]'

export function installWireStdoutGuard(): void {
  return notBuilt('src/utils/wireStdoutGuard.ts:23')
}
