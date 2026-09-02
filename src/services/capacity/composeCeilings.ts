import { availableCores } from '../../utils/availableCores.js'
import { harnessEffortFact, resolveActiveHarnessProfile } from '../mission/harnessApplication.js'
import type { EffortValue } from '../../utils/effort.js'
import { harnessProfileById } from '../mission/harnessProfiles.js'
import { governorCeilings, setGovernorCeilings, type GovernorCeilings } from './governor.js'

export function machineLaneAllowance(cpuCount: number): number {
  return Math.min(16, Math.max(2, cpuCount - 2))
}

export type ComposedRole = 'concourse-worker' | 'single-seat' | 'visible'

export interface CeilingFacts {
  cpuCount: number
  role: ComposedRole
  delegationBand: 1 | 2 | 3 | null
  operatorLanes: number | null
}

export function composedRoleFromEnv(env: NodeJS.ProcessEnv = process.env): ComposedRole {
  const on = (name: string): boolean => {
    return env[name] === '1'
  }
  if (on('MERCURY_CONCOURSE_WORKER')) return 'concourse-worker'
  if (on('MERCURY_IMPLEMENTER')) {
    return 'single-seat'
  }
  return 'visible'
}

export function composeGovernorCeilings(facts: CeilingFacts): GovernorCeilings {
  const machine = machineLaneAllowance(facts.cpuCount)
  const operator = facts.operatorLanes !== null && facts.operatorLanes >= 1 ? Math.floor(facts.operatorLanes) : Infinity
  const cap = (n: number): number => Math.max(1, Math.min(n, operator))
  if (facts.role === 'concourse-worker') {
    return { modelLanes: cap(Math.min(2, machine)), delegationLanes: cap(1) }
  }
  if (facts.role === 'single-seat') {
    return { modelLanes: cap(1), delegationLanes: cap(1) }
  }
  const delegation =
    facts.delegationBand === 1 ? 1 : facts.delegationBand === 2 ? 2 : machine
  return { modelLanes: cap(machine), delegationLanes: cap(delegation) }
}

function liveDelegationBand(model: string | null | undefined, sessionEffortValue: EffortValue | undefined): 1 | 2 | 3 | null {
  try {
    const resolution = resolveActiveHarnessProfile({ model, effortLevel: harnessEffortFact(model, sessionEffortValue) })
    if (!resolution) return null
    const lanes = harnessProfileById(resolution.profileId)?.axes.delegationTopology.maxConcurrentLanes
    return lanes === 1 || lanes === 2 || lanes === 3 ? lanes : null
  } catch {
    return null
  }
}

export function operatorLanesFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env['MERCURY_MODEL_LANES'] ?? ''
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : null
}

let lastApplied: string | null = null

export function refreshGovernorCeilings(
  model: string | null | undefined,
  sessionEffortValue?: EffortValue,
): GovernorCeilings {
  const facts: CeilingFacts = {
    cpuCount: availableCores(),
    role: composedRoleFromEnv(),
    delegationBand: liveDelegationBand(model, sessionEffortValue),
    operatorLanes: operatorLanesFromEnv(),
  }
  const composed = composeGovernorCeilings(facts)
  const key = `${composed.modelLanes}:${composed.delegationLanes}`
  if (key !== lastApplied) {
    lastApplied = key
    setGovernorCeilings(composed)
  }
  return governorCeilings()
}

export function _resetComposeCeilingsForTesting(): void {
  lastApplied = null
}
