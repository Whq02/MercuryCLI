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

interface RoundEntry {
  ordinal: number
  sequence: number
  toolName: string
  toolUseID: string
  key: string
  digest: string
  unchangedRead: boolean
  preview: string
}

interface LoopGuardState {
  boundary: string | null
  lastKey: string | null
  lastResult: string | null
  run: number
  ring: string[]
  roundID: string | null
  roundEntries: RoundEntry[]
  roundCalls: Map<string, number>
  roundSequence: number
  detections: Map<string, { count: number; tools: string[] }>
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
    roundCalls: new Map(),
    roundSequence: 0,
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

export function reminderText(toolName: string, run: number, preview: string): string {
  if (run <= 3) {
    return 'Loop check: this is the third identical tool call, and its result has not changed. Read the result you already have before calling again, then change the approach or finish if the work is done.'
  }
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

function rowText(cycle: CycleDetection, endTurn: boolean, stopEnabled: boolean): string {
  if (endTurn) {
    return `Loop guard ended the turn: the cycle ${cycle.tools.join(' -> ')} repeated five more times after the loop notice, with identical arguments and results (${LOOP_GUARD_STOP_SETTING})`
  }
  if (cycle.length === 1) {
    return `Loop check: ${cycle.tools[0]} returned the same result five more times for the same call; a run of one call never ends a turn`
  }
  const shape = `the cycle ${cycle.tools.join(' -> ')}`
  if (cycle.detection === 1) {
    return `Loop check: ${shape} repeated five times with identical arguments and results${stopEnabled ? '; the turn ends if it repeats five more times' : ''}`
  }
  return `Loop check: ${shape} repeated five more times with identical arguments and results (detection ${cycle.detection}); the turn continues (${LOOP_GUARD_STOP_SETTING} is off)`
}

function quiet(run: number): LoopGuardVerdict {
  return { run, step: null, cycle: null, endTurn: false, messages: [] }
}

export function canonicalCycleID(keys: readonly string[]): string {
  let best: string | null = null
  for (let start = 0; start < keys.length; start++) {
    const rotation = [...keys.slice(start), ...keys.slice(0, start)].join(CYCLE_SEPARATOR)
    if (best === null || rotation < best) best = rotation
  }
  return best ?? ''
}

function rememberDetection(state: LoopGuardState, keys: readonly string[]): CycleDetection {
  const cycleID = canonicalCycleID(keys)
  const known = state.detections.get(cycleID)
  const tools = known?.tools ?? keys.map(toolOfKey)
  const count = (known?.count ?? 0) + 1
  state.detections.delete(cycleID)
  state.detections.set(cycleID, { count, tools })
  if (state.detections.size > DETECTION_MEMORY) {
    const oldest = state.detections.keys().next().value
    if (oldest !== undefined) state.detections.delete(oldest)
  }
  return { length: keys.length, tools, detection: count }
}

function walkEntry(state: LoopGuardState, entry: RoundEntry, seen: Set<string>): { ringEntry: string; step: number | null } | null {
  const sameCall = state.lastKey === entry.key
  const digest = sameCall && state.lastResult !== null && entry.unchangedRead ? state.lastResult : entry.digest
  const ringEntry = `${entry.key}${KEY_SEPARATOR}${digest}`
  if (seen.has(ringEntry)) return null
  seen.add(ringEntry)
  const learnedNothing = sameCall && state.lastResult === digest
  if (sameCall && !learnedNothing) state.ring.length = 0
  state.run = learnedNothing ? state.run + 1 : 1
  state.lastKey = entry.key
  state.lastResult = digest
  state.ring.push(ringEntry)
  if (state.ring.length > CYCLE_WINDOW) state.ring.splice(0, state.ring.length - CYCLE_WINDOW)
  return { ringEntry, step: IDENTICAL_CALL_REMINDER_STEPS.includes(state.run) ? state.run : null }
}

function takeRound(state: LoopGuardState): RoundEntry[] {
  const entries = state.roundEntries.sort((a, b) => a.ordinal - b.ordinal || a.sequence - b.sequence)
  state.roundEntries = []
  state.roundCalls = new Map()
  state.roundSequence = 0
  state.roundID = null
  return entries
}

function switchRound(state: LoopGuardState, roundID: string): void {
  if (state.roundID === roundID) return
  if (state.roundEntries.length > 0) {
    const seen = new Set<string>()
    for (const entry of takeRound(state)) walkEntry(state, entry, seen)
  }
  state.roundID = roundID
  state.roundEntries = []
  state.roundCalls = new Map()
  state.roundSequence = 0
}

function settleBoundary(state: LoopGuardState, messages: readonly unknown[] | undefined): void {
  const boundary = humanTurnBoundaryOf(messages)
  if (state.boundary !== boundary) {
    Object.assign(state, freshState())
    state.boundary = boundary
  }
}

export function openRoundCall(owner: OwnerKey, roundID: string, toolUseID: string, ordinal: number, messages: readonly unknown[] | undefined): void {
  try {
    const state = store.get(owner)
    settleBoundary(state, messages)
    switchRound(state, roundID)
    state.roundCalls.set(toolUseID, ordinal)
  } catch {
    return
  }
}

export function ambientRound(owner: OwnerKey, parentToolUseID: string | undefined): { id: string; ordinal: number } | null {
  try {
    if (parentToolUseID === undefined) return null
    const state = store.peek(owner)
    if (state === undefined || state.roundID === null) return null
    const parent = state.roundCalls.get(parentToolUseID)
    if (parent === undefined) return null
    return { id: state.roundID, ordinal: parent }
  } catch {
    return null
  }
}

export function recordToolCall(owner: OwnerKey, observation: LoopGuardObservation): void {
  try {
    const state = store.get(owner)
    settleBoundary(state, observation.messages)
    switchRound(state, observation.roundID)
    if (isBookkeepingTool(observation.toolName)) return
    state.roundEntries.push({
      ordinal: observation.roundOrdinal,
      sequence: state.roundSequence++,
      toolName: observation.toolName,
      toolUseID: observation.toolUseID,
      key: toolCallKey(observation.toolName, observation.arguments),
      digest: resultDigest(observation.result, observation.toolUseID),
      unchangedRead: isUnchangedReadAnswer(observation.result),
      preview: argumentPreview(observation.arguments),
    })
  } catch {
    return
  }
}

export function closeRound(owner: OwnerKey, roundID: string, complete = true): LoopGuardVerdict {
  try {
    const state = store.peek(owner)
    if (state === undefined || state.roundID !== roundID) return quiet(state?.run ?? 0)
    const entries = takeRound(state)
    if (!complete || entries.length === 0) return quiet(state.run)
    const seen = new Set<string>()
    const reminders: string[] = []
    const rows: string[] = []
    let step: number | null = null
    let last: RoundEntry = entries[0]!
    for (const entry of entries) {
      const walked = walkEntry(state, entry, seen)
      if (walked === null) continue
      last = entry
      if (walked.step !== null) {
        step = walked.step
        reminders.push(reminderText(entry.toolName, state.run, entry.preview))
        rows.push(`Loop check: ${entry.toolName} called ${state.run} times with identical arguments and the same result`)
      }
    }
    const found = detectCycle(state.ring)
    let cycle: CycleDetection | null = null
    if (found !== null) {
      state.ring.length = 0
      cycle = rememberDetection(state, found.keys)
    }
    if (step === null && cycle === null) return quiet(state.run)
    const stopEnabled = isLoopGuardStopEnabled()
    const endTurn = cycle !== null && cycle.length > 1 && cycle.detection >= 2 && stopEnabled
    const messages: Message[] = []
    if (endTurn && cycle !== null) {
      messages.push(
        createAttachmentMessage({
          type: 'loop_stopped',
          toolUseID: last.toolUseID,
          cycle: cycle.tools,
          message: cycleStopText(cycle),
        }),
      )
      messages.push(createSystemMessage(rowText(cycle, true, stopEnabled), 'warning', last.toolUseID))
      return { run: state.run, step, cycle, endTurn, messages }
    }
    const parts = [...reminders]
    if (cycle !== null && !(cycle.length === 1 && step !== null)) parts.push(cycleNudgeText(cycle, state.run, stopEnabled))
    messages.push(createAttachmentMessage({ type: 'critical_system_reminder', content: parts.join(' ') }))
    if (cycle !== null) {
      const cycleRow = rowText(cycle, false, stopEnabled)
      if (cycle.length === 1 && step !== null) rows.push(`the turn continues (${LOOP_GUARD_STOP_SETTING} is ${stopEnabled ? 'on, and a run of one call never ends a turn' : 'off'})`)
      else rows.push(cycleRow)
    }
    messages.push(createSystemMessage(rows.join('; '), 'info', last.toolUseID))
    return { run: state.run, step, cycle, endTurn, messages }
  } catch {
    return quiet(0)
  }
}

export function observeToolCall(owner: OwnerKey, observation: LoopGuardObservation): LoopGuardVerdict {
  recordToolCall(owner, observation)
  return closeRound(owner, observation.roundID)
}

export function _resetLoopGuardForTesting(): void {
  store.clearAllForShutdown()
}
