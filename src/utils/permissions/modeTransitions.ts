
import type { PermissionMode } from '../../types/permissions.js'
import { logForDebugging } from '../debug.js'

export const MODE_TRANSITION_ROADS = [
  'boot',
  'claim',
  'control-door',
  'carousel',
  'screen-mirror',
  'review-approval',
  'permission-answer',
  'plan-entry',
  'plan-exit',
  'flow-unavailable',
  'bypass-disabled',
  'crew-lead',
  'unnamed',
] as const

export type ModeTransitionRoad = (typeof MODE_TRANSITION_ROADS)[number]

export type ModeTransition = {
  from: PermissionMode | null
  to: PermissionMode
  road: ModeTransitionRoad
  detail?: string
  held?: true
  atMs: number
}

const RECORD_CAP = 200

let record: ModeTransition[] = []
let announced: ModeTransition | null = null

function push(entry: ModeTransition): ModeTransition {
  record.push(entry)
  if (record.length > RECORD_CAP) record = record.slice(record.length - RECORD_CAP)
  logForDebugging(
    `permission mode ${entry.held ? 'transition HELD' : 'transition'}: ${entry.from ?? '(boot)'} → ${entry.to} via ${entry.road}${entry.detail ? ` — ${entry.detail}` : ''}`,
  )
  return entry
}

export function recordModeTransition(entry: {
  from: PermissionMode | null
  to: PermissionMode
  road: ModeTransitionRoad
  detail?: string
}): ModeTransition {
  const stamped: ModeTransition = { ...entry, atMs: Date.now() }
  if (entry.from !== entry.to) announced = stamped
  return push(stamped)
}

export function holdModeTransition(entry: {
  from: PermissionMode
  to: PermissionMode
  road: ModeTransitionRoad
  detail?: string
}): ModeTransition {
  return push({ ...entry, held: true, atMs: Date.now() })
}

export function auditModeChange(from: PermissionMode, to: PermissionMode): ModeTransition {
  const pending = announced
  announced = null
  if (pending !== null && pending.from === from && pending.to === to) return pending
  return push({ from, to, road: 'unnamed', atMs: Date.now() })
}

export function modeTransitions(): readonly ModeTransition[] {
  return [...record]
}

export function lastModeTransitionFrom(mode: PermissionMode): ModeTransition | undefined {
  for (let i = record.length - 1; i >= 0; i--) {
    const entry = record[i]
    if (entry !== undefined && entry.held !== true && entry.from === mode) return entry
  }
  return undefined
}

export function bootModeTransition(): ModeTransition | undefined {
  return record.find(entry => entry.road === 'boot')
}

export function clearModeTransitions(): void {
  record = []
  announced = null
}

export function describeModeRoad(road: ModeTransitionRoad): string {
  switch (road) {
    case 'boot':
      return 'the launch (the flag or the saved default)'
    case 'claim':
      return "the session's admission (the posture it was born with)"
    case 'control-door':
      return "the operator's mode change (shift+tab)"
    case 'carousel':
      return "the operator's mode change (shift+tab)"
    case 'screen-mirror':
      return "the screen mirroring the focused chat's mode"
    case 'review-approval':
      return "the review card's approval"
    case 'permission-answer':
      return "a consent answer's mode change (a consent card's session tier, a hook, or the host)"
    case 'plan-entry':
      return 'entering strategy mode (the plan tool or /plan)'
    case 'plan-exit':
      return 'leaving strategy mode (the plan exit tool)'
    case 'flow-unavailable':
      return 'the flow gate closing under the session'
    case 'bypass-disabled':
      return "the organisation's bypass kill"
    case 'crew-lead':
      return "the team lead's mode request"
    case 'unnamed':
      return 'an unnamed road (no writer announced the change)'
  }
}
