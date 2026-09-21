
import type { EffortLevel } from '../effort.js'
import { EFFORT_LEVELS, getMaxSupportedEffortLevel } from '../effort.js'
import { parseUserSpecifiedModel } from '../model/model.js'
import { modelSupports1M } from '../model/capabilities.js'
import { withContext1m } from '../model/modelOptions.js'
import { has1mContext } from '../context.js'
import { routeOfFamilyWord, isModelFamilyWord } from '../model/modelFamilies.js'
import {
  autopilotAllowedModels,
  autopilotSessionFamily,
  autopilotTierKeyOf,
  autopilotTierKeys,
} from './autopilotGates.js'

export const MAX_SWITCHES_PER_SESSION = 8
export const TURNS_BETWEEN_SWITCHES = 3

export interface TierChangeRequest {
  model?: string
  effort?: EffortLevel
  scope: 'turn' | 'session'
  reason: string
}

export interface TierOverride {
  model?: string
  effort?: EffortLevel
}

export type TierVerdict =
  | { ok: true; applied: TierOverride; line: string }
  | { ok: false; refused: string }

let turnCounter = 0
let switchesThisSession = 0
let lastSwitchTurn = -Infinity
const turnOverrides = new Map<string, TierOverride>()

const threadKey = (agentId: string | undefined): string => agentId ?? 'main'

const BARE_KEYS = new Set(['fable51'])

export function resolveTierKey(key: string, currentModel: string): string {
  const lowered = key.trim().toLowerCase()
  const route = routeOfFamilyWord(lowered)
  if (route !== null) {
    const { familySeatSetting } = require('../../services/concourse/workerModels.js') as typeof import('../../services/concourse/workerModels.js')
    return familySeatSetting(route) ?? currentModel
  }
  const base = parseUserSpecifiedModel(key.trim())
  if (BARE_KEYS.has(lowered) || !isModelFamilyWord(lowered) && !/^[a-z0-9]+$/.test(lowered)) return base
  return has1mContext(currentModel) && modelSupports1M(base) ? withContext1m(base) : base
}

export function validateTierChange(
  req: TierChangeRequest,
  currentModel: string,
  currentEffort?: EffortLevel | number,
): TierVerdict {
  if (!req.model && !req.effort) {
    return { ok: false, refused: 'nothing to change — pass model and/or effort' }
  }
  if (!req.reason || req.reason.trim().length < 8) {
    return { ok: false, refused: 'a one-line reason is required (surfaced to the operator)' }
  }
  if (switchesThisSession >= MAX_SWITCHES_PER_SESSION) {
    return {
      ok: false,
      refused: `session switch cap reached (${MAX_SWITCHES_PER_SESSION}) — ask the operator to retune via /model`,
    }
  }
  if (turnCounter - lastSwitchTurn < TURNS_BETWEEN_SWITCHES) {
    const wait = TURNS_BETWEEN_SWITCHES - (turnCounter - lastSwitchTurn)
    return {
      ok: false,
      refused: `cooldown — ${wait} more full turn(s) before another switch (switching thrashes the prompt cache)`,
    }
  }
  const applied: TierOverride = {}
  if (req.model !== undefined) {
    const family = autopilotSessionFamily(currentModel)
    if (family === null) {
      return { ok: false, refused: `the session's model '${currentModel}' is on no known family — no tier key applies` }
    }
    const key = autopilotTierKeyOf(String(req.model), currentModel)
    if (key === null) {
      const keys = autopilotTierKeys(currentModel)
      const { providerDisplayName } = require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
      return {
        ok: false,
        refused: `'${String(req.model)}' is not a tier key of the session's family (${providerDisplayName(family)}) — the keys: ${keys.join(' | ')}`,
      }
    }
    const allowed = autopilotAllowedModels(currentModel)
    if (!allowed.includes(key)) {
      return {
        ok: false,
        refused: `'${key}' is not in the operator allowlist (${allowed.join(',')}) — MERCURY_AUTOPILOT_MODELS names the keys autopilot may pick`,
      }
    }
    applied.model = resolveTierKey(key, currentModel)
  }
  if (req.effort !== undefined) {
    if (!EFFORT_LEVELS.includes(req.effort)) {
      return { ok: false, refused: `unknown effort '${String(req.effort)}' — one of ${EFFORT_LEVELS.join('|')}` }
    }
    const targetModel = applied.model ?? currentModel
    const ceiling = getMaxSupportedEffortLevel(targetModel)
    const clamped =
      EFFORT_LEVELS.indexOf(req.effort) > EFFORT_LEVELS.indexOf(ceiling) ? ceiling : req.effort
    applied.effort = clamped
  }
  const short = (m: string) => m.replace(/\[1m\]$/, '')
  const fromParts: string[] = []
  const toParts: string[] = []
  if (applied.model) {
    fromParts.push(short(currentModel))
    toParts.push(short(applied.model))
  }
  if (applied.effort) {
    if (currentEffort !== undefined) fromParts.push(`@${currentEffort}`)
    toParts.push(`@${applied.effort}`)
  }
  const line = `⇅ autopilot · ${fromParts.length ? `${fromParts.join(' ')} → ` : ''}${toParts.join(' ')} (${req.scope}) — ${req.reason.trim()}`
  return { ok: true, applied, line }
}

export function recordSwitch(): void {
  switchesThisSession++
  lastSwitchTurn = turnCounter
}

export function setTurnOverride(agentId: string | undefined, o: TierOverride): void {
  turnOverrides.set(threadKey(agentId), o)
}

export function applyTurnTierModel(agentId: string | undefined, model: string): string {
  return turnOverrides.get(threadKey(agentId))?.model ?? model
}

export function applyTurnTierEffort(
  agentId: string | undefined,
  base: EffortLevel | number | undefined,
): EffortLevel | number | undefined {
  return turnOverrides.get(threadKey(agentId))?.effort ?? base
}

export function tierTurnEnded(agentId: string | undefined): void {
  if (threadKey(agentId) === 'main') turnCounter++
  turnOverrides.delete(threadKey(agentId))
}

export function describeTurnOverride(agentId: string | undefined): string | null {
  const o = turnOverrides.get(threadKey(agentId))
  if (!o) return null
  const parts: string[] = []
  if (o.model) parts.push(o.model.replace(/\[1m\]$/, ''))
  if (o.effort) parts.push(`@${o.effort}`)
  return parts.length ? `${parts.join(' ')} · turn` : null
}

export function autopilotRailsSnapshot(): {
  switches: number
  cap: number
  turnsSinceSwitch: number
} {
  return {
    switches: switchesThisSession,
    cap: MAX_SWITCHES_PER_SESSION,
    turnsSinceSwitch: turnCounter - (lastSwitchTurn === -Infinity ? turnCounter : lastSwitchTurn),
  }
}

export function resetTierStateForTests(): void {
  turnCounter = 0
  switchesThisSession = 0
  lastSwitchTurn = -Infinity
  turnOverrides.clear()
}
