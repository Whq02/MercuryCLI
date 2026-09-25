import { createHash } from 'node:crypto'
import { FILE_UNCHANGED_STUB } from '../../tools/FileReadTool/prompt.js'
import type { Message } from '../../types/message.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import { createSystemMessage } from '../../utils/messages/systemMessages.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'

export const IDENTICAL_CALL_REMINDER_STEPS: readonly number[] = [3, 5, 8]
export const CYCLE_WINDOW = 25
export const CYCLE_MAX_LENGTH = 5
export const CYCLE_REPEATS = 5
export const ARGUMENT_PREVIEW_CHARS = 160
export const LOOP_GUARD_NAME = 'Loop guard'
export const LOOP_GUARD_STOP_SETTING = 'loopGuardStopEnabled'

const BOOKKEEPING_PREFIXES = ['Task', 'Todo']
const BOOKKEEPING_NAMES = new Set(['Checkpoint', 'Rewind', 'Sleep', 'Monitor'])
const KEY_SEPARATOR = '\u0000'
const CYCLE_SEPARATOR = '\u0001'
const DETECTION_MEMORY = 16

export interface LoopGuardObservation {
  toolName: string
  toolUseID: string
  roundID: string
  roundOrdinal: number
  arguments: unknown
  result: ToolResultBlockParam | undefined
  messages: readonly unknown[] | undefined
}

export interface CycleDetection {
  length: number
  tools: string[]
  detection: number
}

export interface LoopGuardVerdict {
  run: number
  step: number | null
  cycle: CycleDetection | null
  endTurn: boolean
  messages: Message[]
}

interface LoopGuardState {
  boundary: string | null
  lastKey: string | null
  lastResult: string | null
  run: number
  ring: string[]
  roundID: string | null
  roundEntries: Array<{ ordinal: number; entry: string }>
  detections: Map<string, number>
}

function freshState(): LoopGuardState {
  return {
    boundary: null,
    lastKey: null,
    lastResult: null,
    run: 0,
    ring: [],
    roundID: null,
    roundEntries: [],
    detections: new Map(),
  }
}

const store = new OwnerScopedStore<LoopGuardState>({
  name: 'loop-guard',
  create: () => freshState(),
  cap: 64,
})
registerOwnerScopedStore(store)

export function isLoopGuardStopEnabled(): boolean {
  try {
    return getInitialSettings().loopGuardStopEnabled === true
  } catch {
    return false
  }
}

export function isBookkeepingTool(name: string): boolean {
  if (BOOKKEEPING_NAMES.has(name)) return true
  return BOOKKEEPING_PREFIXES.some(prefix => name.startsWith(prefix))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = sortKeysDeep(source[key])
    }
    return out
  }
  return value
}

export function canonicalArguments(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? 'undefined'
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function toolCallKey(toolName: string, args: unknown): string {
  return `${toolName}${KEY_SEPARATOR}${shortHash(canonicalArguments(args))}`
}

function toolOfKey(key: string): string {
  return key.slice(0, key.indexOf(KEY_SEPARATOR))
}

export function toolResultBlockOf(message: Message | undefined, toolUseID: string): ToolResultBlockParam | undefined {
  if (message === undefined || message.type !== 'user') return undefined
  const content = message.message.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block.type === 'tool_result' && block.tool_use_id === toolUseID) return block
  }
  return undefined
}

export function resultDigest(block: ToolResultBlockParam | undefined, toolUseID: string): string {
  const material = canonicalArguments({
    content: block?.content ?? null,
    error: block?.is_error === true,
  })
  return shortHash(toolUseID.length > 0 ? material.split(toolUseID).join('') : material)
}

export function isUnchangedReadAnswer(block: ToolResultBlockParam | undefined): boolean {
  return block?.is_error !== true && block?.content === FILE_UNCHANGED_STUB
}

function argumentPreview(args: unknown): string {
  const whole = canonicalArguments(args)
  if (whole.length <= ARGUMENT_PREVIEW_CHARS) return whole
  return `${whole.slice(0, ARGUMENT_PREVIEW_CHARS)}...`
}

type FrameShape = {
  type?: unknown
  uuid?: unknown
  isMeta?: unknown
  toolUseResult?: unknown
  sourceToolAssistantUUID?: unknown
  message?: { content?: unknown }
  attachment?: { type?: unknown; isMeta?: unknown; origin?: unknown; commandMode?: unknown }
}

function carriesToolResult(frame: FrameShape): boolean {
  if (frame.sourceToolAssistantUUID !== undefined || frame.toolUseResult !== undefined) return true
  const content = frame.message?.content
  return Array.isArray(content) && content.some(block => (block as { type?: unknown })?.type === 'tool_result')
}

function isHumanTurnFrame(frame: FrameShape): boolean {
  if (frame.type === 'user') return frame.isMeta !== true && !carriesToolResult(frame)
  if (frame.type !== 'attachment') return false
  const attachment = frame.attachment
  return (
    attachment?.type === 'queued_command' &&
    attachment.isMeta !== true &&
    attachment.origin === undefined &&
    attachment.commandMode !== 'task-notification'
  )
}

export function humanTurnBoundaryOf(messages: readonly unknown[] | undefined): string | null {
  if (messages === undefined) return null
  for (let index = messages.length - 1; index >= 0; index--) {
    const frame = messages[index] as FrameShape | undefined
    if (frame === undefined || frame === null || !isHumanTurnFrame(frame)) continue
    return typeof frame.uuid === 'string' ? frame.uuid : String(index)
  }
  return null
}

export function detectCycle(ring: readonly string[]): { length: number; keys: string[] } | null {
  for (let length = 1; length <= CYCLE_MAX_LENGTH; length++) {
    const span = length * CYCLE_REPEATS
    if (ring.length < span) break
    const tail = ring.slice(ring.length - span)
    let repeats = true
    for (let i = length; i < span; i++) {
      if (tail[i] !== tail[i % length]) {
        repeats = false
        break
      }
    }
    if (repeats) return { length, keys: tail.slice(0, length) }
  }
  return null
}

export function reminderText(toolName: string, run: number, args: unknown): string {
  if (run <= 3) {
    return 'Loop check: this is the third identical tool call, and its result has not changed. Read the result you already have before calling again, then change the approach or finish if the work is done.'
  }
  const preview = argumentPreview(args)
  if (run <= 5) {
    return `Loop notice: ${toolName} has been called ${run} times with identical arguments (${preview}) and the result has not changed. Inspect the result you already have, then take a different action or finish.`
  }
  return `Loop notice: ${toolName} has been called ${run} times with identical arguments (${preview}) and the result has not changed. Repeating it has not produced anything new. Stop, state what you found so far, and either change the approach or end the turn.`
}

function cycleShape(cycle: CycleDetection): string {
  return cycle.length === 1 ? `the same ${cycle.tools[0]} call` : `the same cycle of tool calls (${cycle.tools.join(' -> ')})`
}

export function cycleNudgeText(cycle: CycleDetection, run: number, stopEnabled: boolean): string {
  if (cycle.length === 1) {
    return `Loop notice: ${cycle.tools[0]} has returned the same result ${run} times for the same call. This pattern is not making progress: inspect the result you already have, change the approach, or end the turn and report what you found.`
  }
  const span = cycle.length * CYCLE_REPEATS
  const escalation = stopEnabled ? ' If the same cycle repeats five more times, the turn will be ended.' : ''
  if (cycle.detection === 1) {
    return `Loop notice: your last ${span} tool calls repeat the same cycle five times (${cycle.tools.join(' -> ')}) with identical arguments and identical results each time. This pattern is not making progress: inspect the results, change the approach, or end the turn and report what you found.${escalation}`
  }
  return `Loop notice: ${cycleShape(cycle)} has repeated five more times since the last loop notice, with identical arguments and identical results each time (${cycle.detection} detections this turn). It is not making progress: stop repeating it, change the approach, or end the turn and report what you found.`
}

export function cycleStopText(cycle: CycleDetection): string {
  return `The loop guard ended the turn: ${cycleShape(cycle)} repeated five more times after the loop notice, with identical arguments and identical results each time. When the turn resumes, report what was found and what a different approach would be.`
}

function rowText(toolName: string, run: number, step: number | null, cycle: CycleDetection | null, endTurn: boolean, stopEnabled: boolean): string {
  if (endTurn && cycle !== null) {
    return `Loop guard ended the turn: the cycle ${cycle.tools.join(' -> ')} repeated five more times after the loop notice, with identical arguments and results (${LOOP_GUARD_STOP_SETTING})`
  }
  const parts: string[] = []
  if (step !== null) parts.push(`Loop check: ${toolName} called ${run} times with identical arguments and the same result`)
  if (cycle !== null && cycle.length === 1 && step === null) parts.push(`Loop check: ${cycle.tools[0]} called ${run} times with identical arguments and the same result`)
  if (cycle !== null && cycle.length > 1) {
    const shape = `the cycle ${cycle.tools.join(' -> ')}`
    if (cycle.detection === 1) parts.push(`Loop check: ${shape} repeated five times with identical arguments and results${stopEnabled ? '; the turn ends if it repeats five more times' : ''}`)
    else parts.push(`Loop check: ${shape} repeated five more times with identical arguments and results (detection ${cycle.detection}); the turn continues (${LOOP_GUARD_STOP_SETTING} is off)`)
  }
  return parts.join('; ')
}

function quiet(run: number): LoopGuardVerdict {
  return { run, step: null, cycle: null, endTurn: false, messages: [] }
}

function rememberDetection(state: LoopGuardState, cycleID: string): number {
  const count = (state.detections.get(cycleID) ?? 0) + 1
  state.detections.delete(cycleID)
  state.detections.set(cycleID, count)
  if (state.detections.size > DETECTION_MEMORY) {
    const oldest = state.detections.keys().next().value
    if (oldest !== undefined) state.detections.delete(oldest)
  }
  return count
}

export function observeToolCall(owner: OwnerKey, observation: LoopGuardObservation): LoopGuardVerdict {
  try {
    const state = store.get(owner)
    const boundary = humanTurnBoundaryOf(observation.messages)
    if (state.boundary !== boundary) {
      Object.assign(state, freshState())
      state.boundary = boundary
    }
    if (isBookkeepingTool(observation.toolName)) return quiet(state.run)
    const key = toolCallKey(observation.toolName, observation.arguments)
    const sameCall = state.lastKey === key
    const digest =
      sameCall && state.lastResult !== null && isUnchangedReadAnswer(observation.result)
        ? state.lastResult
        : resultDigest(observation.result, observation.toolUseID)
    const entry = `${key}${KEY_SEPARATOR}${digest}`
    if (state.roundID !== observation.roundID) {
      state.ring.push(...state.roundEntries.map(item => item.entry))
      if (state.ring.length > CYCLE_WINDOW) state.ring.splice(0, state.ring.length - CYCLE_WINDOW)
      state.roundID = observation.roundID
      state.roundEntries = []
    } else if (state.roundEntries.some(item => item.entry === entry)) {
      return quiet(state.run)
    }
    const learnedNothing = sameCall && state.lastResult === digest
    if (sameCall && !learnedNothing) {
      state.ring.length = 0
      state.roundEntries.length = 0
    }
    state.run = learnedNothing ? state.run + 1 : 1
    state.lastKey = key
    state.lastResult = digest
    state.roundEntries.push({ ordinal: observation.roundOrdinal, entry })
    state.roundEntries.sort((a, b) => a.ordinal - b.ordinal)
    const view = [...state.ring, ...state.roundEntries.map(item => item.entry)].slice(-CYCLE_WINDOW)
    const step = IDENTICAL_CALL_REMINDER_STEPS.includes(state.run) ? state.run : null
    const found = detectCycle(view)
    let cycle: CycleDetection | null = null
    if (found !== null) {
      state.ring.length = 0
      state.roundEntries.length = 0
      const detection = rememberDetection(state, found.keys.join(CYCLE_SEPARATOR))
      cycle = { length: found.length, tools: found.keys.map(toolOfKey), detection }
    }
    if (step === null && cycle === null) return quiet(state.run)
    const stopEnabled = isLoopGuardStopEnabled()
    const endTurn = cycle !== null && cycle.length > 1 && cycle.detection >= 2 && stopEnabled
    const messages: Message[] = []
    if (endTurn && cycle !== null) {
      messages.push(
        createAttachmentMessage({
          type: 'loop_stopped',
          toolUseID: observation.toolUseID,
          cycle: cycle.tools,
          message: cycleStopText(cycle),
        }),
      )
    } else {
      const parts: string[] = []
      if (step !== null) parts.push(reminderText(observation.toolName, state.run, observation.arguments))
      if (cycle !== null && !(cycle.length === 1 && step !== null)) parts.push(cycleNudgeText(cycle, state.run, stopEnabled))
      messages.push(createAttachmentMessage({ type: 'critical_system_reminder', content: parts.join(' ') }))
    }
    messages.push(
      createSystemMessage(
        rowText(observation.toolName, state.run, step, cycle, endTurn, stopEnabled),
        endTurn ? 'warning' : 'info',
        observation.toolUseID,
      ),
    )
    return { run: state.run, step, cycle, endTurn, messages }
  } catch {
    return quiet(0)
  }
}

export function _resetLoopGuardForTesting(): void {
  store.clearAllForShutdown()
}
