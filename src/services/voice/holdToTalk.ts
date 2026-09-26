import type { Key } from '../../ink/events/input-event.js'
import * as pendingInput from '../../input-core/pending-input.js'
import { HOLD_TO_TALK_MS, cancelVoiceCapture, startVoiceCapture, stopVoiceCapture, voiceSnapshot } from './voiceSession.js'

export { HOLD_TO_TALK_MS }
export const FIRST_REPEAT_WINDOW_MS = 1_000
export const RELEASE_GAP_FLOOR_MS = 150
export const RELEASE_GAP_CEILING_MS = 1_000
export const RELEASE_GAP_FACTOR = 2

export interface HoldEditor {
  text(): string
  cursor(): number
  splice(deleteBefore: number, insert: string): void
}

export interface HoldClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  defer(fn: () => void): void
}

export type HoldPhase = 'holding' | 'opening' | 'recording' | 'spent'

export interface HoldSnapshot {
  phase: HoldPhase
  pressedAt: number
  repeats: number
  heldBack: number
  interval: number | null
}

interface Hold {
  phase: HoldPhase
  pressedAt: number
  lastAt: number
  repeats: number
  heldBack: number
  interval: number | null
  released: boolean
  timer: unknown
}

const realClock: HoldClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: handle => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  defer: fn => {
    setImmediate(fn)
  },
}

let clock: HoldClock = realClock
let editor: HoldEditor | null = null
let hold: Hold | null = null

export function setHoldToTalkEditor(next: HoldEditor | null): void {
  editor = next
}

export function releaseGapMs(interval: number | null): number {
  if (interval === null) return FIRST_REPEAT_WINDOW_MS
  return Math.min(RELEASE_GAP_CEILING_MS, Math.max(RELEASE_GAP_FLOOR_MS, Math.round(interval * RELEASE_GAP_FACTOR)))
}

export function holdToTalkSnapshot(): HoldSnapshot | null {
  if (hold === null) return null
  return { phase: hold.phase, pressedAt: hold.pressedAt, repeats: hold.repeats, heldBack: hold.heldBack, interval: hold.interval }
}

function closeHold(): void {
  if (hold === null) return
  if (hold.timer !== null) clock.clearTimeout(hold.timer)
  hold = null
}

function isPlainText(rawInput: string, key: Key): boolean {
  if (rawInput === '' || key.ctrl || key.meta || key.escape || key.return || key.tab || key.backspace || key.delete) return false
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.home || key.end || key.pageUp || key.pageDown) return false
  return !/[\x00-\x08\x0b-\x1f\x7f]/.test(rawInput)
}

function withdrawTypedSpace(): void {
  if (editor === null) return
  const text = editor.text()
  const at = editor.cursor()
  if (at > 0 && at <= text.length && text[at - 1] === ' ') editor.splice(1, '')
}

function flushHeldBack(count: number): void {
  if (count <= 0 || editor === null) return
  editor.splice(0, ' '.repeat(count))
}

function openTake(current: Hold): void {
  clock.setTimeout(() => {
    if (hold !== current) return
    void startVoiceCapture({ road: 'hold' }).then(outcome => {
      if (hold !== current) return
      if (outcome.kind !== 'started') {
        current.phase = 'spent'
        return
      }
      withdrawTypedSpace()
      if (current.released) {
        cancelVoiceCapture()
        closeHold()
        return
      }
      current.phase = 'recording'
    })
  }, 0)
}

function release(current: Hold): void {
  if (hold !== current) return
  switch (current.phase) {
    case 'holding': {
      const held = current.heldBack
      closeHold()
      flushHeldBack(held)
      return
    }
    case 'opening':
      current.released = true
      return
    case 'recording':
      closeHold()
      stopVoiceCapture()
      return
    default:
      closeHold()
  }
}

function arm(current: Hold): void {
  if (current.timer !== null) clock.clearTimeout(current.timer)
  const armedFor = current.lastAt
  current.timer = clock.setTimeout(() => {
    clock.defer(() => {
      if (hold !== current || current.lastAt !== armedFor) return
      release(current)
    })
  }, releaseGapMs(current.interval))
}

function noteRepeats(current: Hold, now: number, count: number): void {
  for (let i = 0; i < count; i++) {
    if (current.repeats > 0 && now > current.lastAt) current.interval = Math.max(current.interval ?? 0, now - current.lastAt)
    current.repeats += 1
    current.lastAt = now
    if (current.phase === 'holding') {
      if (now - current.pressedAt >= HOLD_TO_TALK_MS) {
        current.phase = 'opening'
        current.heldBack = 0
        openTake(current)
      } else {
        current.heldBack += 1
      }
    } else if (current.phase === 'recording' && voiceSnapshot().phase !== 'recording') {
      current.phase = 'spent'
    }
  }
}

export function holdToTalkKey(rawInput: string, key: Key): string {
  if (key.wheelUp || key.wheelDown) return rawInput
  const spaces = !key.ctrl && !key.meta && !key.isPasted && /^ +$/.test(rawInput) ? rawInput.length : 0
  if (spaces === 0) {
    const current = hold
    if (current === null || current.phase !== 'holding') return rawInput
    const held = current.heldBack
    closeHold()
    return held > 0 && isPlainText(rawInput, key) ? ' '.repeat(held) + rawInput : rawInput
  }
  const now = clock.now()
  if (hold === null) {
    const live = voiceSnapshot()
    if (!live.enabled || pendingInput.mode() !== 'prompt') return rawInput
    const current: Hold = { phase: 'holding', pressedAt: now, lastAt: now, repeats: 0, heldBack: 0, interval: null, released: false, timer: null }
    hold = current
    noteRepeats(current, now, spaces - 1)
    arm(current)
    return ' '
  }
  const current = hold
  noteRepeats(current, now, spaces)
  if (hold === current) arm(current)
  return ''
}

export function configureHoldToTalkForTest(next: HoldClock | null): void {
  closeHold()
  clock = next ?? realClock
}

export function resetHoldToTalkForTest(): void {
  closeHold()
}
