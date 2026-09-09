import { evalKernelManager } from '../services/eval/kernelManager.js'
import { liveBrowserSessionCensus } from '../services/browser/browserSession.js'
import { liveServiceChildren } from '../services/projectServices/serviceManager.js'
import { liveDapSessionCount } from '../services/dap/dapClient.js'
import { liveWorkshopRuntimeCount } from '../services/workshop/runtime.js'

export type CapabilityHold = { kind: string; count: number; external: boolean }

export function runnerCapabilityHolds(io?: { pendingControlRequestCount(): number }): CapabilityHold[] {
  const holds: CapabilityHold[] = []
  const add = (kind: string, count: number, external: boolean): void => {
    if (count > 0) holds.push({ kind, count, external })
  }
  add('pending control request', io?.pendingControlRequestCount() ?? 0, false)
  add('eval kernel', evalKernelManager.kernelCount(), true)
  add('workshop runtime', liveWorkshopRuntimeCount(), true)
  add('browser', liveBrowserSessionCensus().length, true)
  add('service', liveServiceChildren().length, true)
  add('debug session', liveDapSessionCount(), true)
  return holds
}

export function capabilityHoldWords(holds: readonly CapabilityHold[]): string | null {
  if (holds.length === 0) return null
  return holds.map(h => `${h.count} ${h.kind}${h.count === 1 ? '' : 's'}${h.external ? ' (a live process)' : ''}`).join(', ') + ' would not survive a park'
}
