import { evalKernelManager } from '../services/eval/kernelManager.js'
import { liveBrowserSessionCensus } from '../services/browser/browserSession.js'
import { liveServiceChildren } from '../services/projectServices/serviceManager.js'
import { liveDapSessionCount } from '../services/dap/dapClient.js'

type CapabilityHold = { kind: string; count: number; external: boolean; words?: string }

const WAITING_CREWMATE = 'waiting crewmate'

function waitingCrewmates(): number {
  const { armedAutomaticResumeCount } = require('../tools/AgentTool/agentToolUtils.js') as typeof import('../tools/AgentTool/agentToolUtils.js')
  return armedAutomaticResumeCount()
}

function waitingCrewmateWords(count: number): string {
  return count === 1 ? '1 crewmate is waiting to retry by itself' : `${count} crewmates are waiting to retry by themselves`
}

export function runnerCapabilityHolds(io?: { pendingControlRequestCount(): number }): CapabilityHold[] {
  const holds: CapabilityHold[] = []
  const add = (kind: string, count: number, external: boolean): void => {
    if (count > 0) holds.push({ kind, count, external })
  }
  add('pending control request', io?.pendingControlRequestCount() ?? 0, false)
  add('eval kernel', evalKernelManager.kernelCount(), true)
  add('browser', liveBrowserSessionCensus().length, true)
  add('service', liveServiceChildren().length, true)
  add('debug session', liveDapSessionCount(), true)
  const waiting = waitingCrewmates()
  if (waiting > 0) holds.push({ kind: WAITING_CREWMATE, count: waiting, external: false, words: waitingCrewmateWords(waiting) })
  return holds
}

export function capabilityHoldWords(holds: readonly CapabilityHold[]): string | null {
  if (holds.length === 0) return null
  const lost = holds.filter(h => h.words === undefined)
  const said = holds.flatMap(h => (h.words === undefined ? [] : [h.words]))
  if (lost.length > 0) said.unshift(lost.map(h => `${h.count} ${h.kind}${h.count === 1 ? '' : 's'}${h.external ? ' (a live process)' : ''}`).join(', ') + ' would not survive a park')
  return said.join('; ')
}
