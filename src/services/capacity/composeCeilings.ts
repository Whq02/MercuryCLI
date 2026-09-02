// ============================================================================
// composeCeilings — the governor's ceiling
//  COMPOSITION. One pure function turns the process's real facts — machine
//  headroom, the child-role env stamps, the ACTIVE harness profile's
//  delegation band — into GovernorCeilings, and one memoized refresh applies
//  it at the acquire seam (the turn machine calls it before every permit
//  acquire, so ceilings stay LIVE across model switches and mid-session
//  engages: gates re-read env live, the house law).
//
// The role partition:
//  · MERCURY_CONCOURSE_WORKER — a background session: TWO model-bearing
//    seats total (its own turn + at most one concurrent delegated seat;
//    the governor's interactive reserve keeps the turn admissible), so
//    modelLanes=2 and delegationLanes=1. This is the process half —
//    every in-process spawn surface (workflows, AgentTool, Console…)
//    reaches the provider through the streamModel backstop, which these
//    ceilings now bound.
//  · The visible foreground process: machine allowance min(16, max(2,
//    cpu−2)) — the CPU/process term, the SAME arithmetic the workflow
//    limiter clamps to (one formula, no duplicate ceiling).
//
//  The profile term (the "maxConcurrentLanes as a REAL input"): the
//  fact is a delegation-width BAND (1|2|3 — its own docstring: constrain-
//  only compatibility, agent count never a target). Band 1 ⇒ delegation
//  serializes (the GPT/GLM solo lanes' live truth), band 2 ⇒ two delegated
//  lanes, band 3 ⇒ the machine allowance (full width supported — never a
//  NEW clamp on the anthropic-default workflow driver). Unarmed harness
//  profiles (MERCURY_HARNESS_PROFILE off) compose the band as null ⇒
//  machine width, byte-identical admission to the pre-composition default.
// ============================================================================
import { availableCores } from '../../utils/availableCores.js'
import { harnessEffortFact, resolveActiveHarnessProfile } from '../mission/harnessApplication.js'
import type { EffortValue } from '../../utils/effort.js'
import { harnessProfileById } from '../mission/harnessProfiles.js'
import { governorCeilings, setGovernorCeilings, type GovernorCeilings } from './governor.js'

/** The one machine-allowance formula (shared with the workflow limiter's
 *  clamp — computeConcurrencyCap consumes the composed ceiling, so the two
 *  never diverge). */
export function machineLaneAllowance(cpuCount: number): number {
  return Math.min(16, Math.max(2, cpuCount - 2))
}

export type ComposedRole = 'concourse-worker' | 'visible'

export interface CeilingFacts {
  cpuCount: number
  role: ComposedRole
  /** The active harness profile's delegation band (1|2|3), or null when the
   *  profile system is unarmed / no profile resolves. */
  delegationBand: 1 | 2 | 3 | null
  /** The OPERATOR ceiling (MERCURY_MODEL_LANES, ≥1) — min'ed into both
   *  axes; null when unset/invalid. Also the capacity provers' production-
   *  true pin (a raw setGovernorCeilings pin would be overwritten by the
   *  next acquire's refresh — by design: composition owns the ceilings). */
  operatorLanes: number | null
}

/** Read the process's composed role from the mechanically-stamped child
 *  role envs (buildStreamJsonInvocation sanitizes + stamps exactly one). */
export function composedRoleFromEnv(env: NodeJS.ProcessEnv = process.env): ComposedRole {
  const on = (name: string): boolean => {
    return env[name] === '1'
  }
  if (on('MERCURY_CONCOURSE_WORKER')) return 'concourse-worker'
  return 'visible'
}

/** Pure composition over the facts. */
export function composeGovernorCeilings(facts: CeilingFacts): GovernorCeilings {
  const machine = machineLaneAllowance(facts.cpuCount)
  const operator = facts.operatorLanes !== null && facts.operatorLanes >= 1 ? Math.floor(facts.operatorLanes) : Infinity
  const cap = (n: number): number => Math.max(1, Math.min(n, operator))
  if (facts.role === 'concourse-worker') {
    // ≤2 concurrent model-bearing seats for a background
    // session — the turn plus one delegated seat.
    return { modelLanes: cap(Math.min(2, machine)), delegationLanes: cap(1) }
  }
  const delegation =
    facts.delegationBand === 1 ? 1 : facts.delegationBand === 2 ? 2 : machine
  return { modelLanes: cap(machine), delegationLanes: cap(delegation) }
}

/** The active profile's delegation band via the gated CH resolver (armed ⇒
 *  the cached pure resolution; off ⇒ null with ZERO resolver work — the
 *  CH-41 gate). Static imports are free here: the turn machine (this
 *  function's one production caller path) already carries the mission
 *  estate for its context-policy read. */
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

/** The registered MERCURY_MODEL_LANES operator ceiling — positive int or null. */
export function operatorLanesFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env['MERCURY_MODEL_LANES'] ?? ''
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : null
}

let lastApplied: string | null = null

/**
 * The acquire-seam refresh: compose the live facts and apply them when they
 * changed (setGovernorCeilings drains waiters, so a raise admits queued work
 * immediately). Memoized on the composed VALUE — a no-change refresh is two
 * env reads + a cached resolution.
 */
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

/** Proof seam. */
export function _resetComposeCeilingsForTesting(): void {
  lastApplied = null
}
