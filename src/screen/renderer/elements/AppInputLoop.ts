import { updateLastInteractionTime } from '../../../boot/process-state/processState.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { startImmediate, startTimeout, stopImmediate, stopTimeout } from '../../../platform/async/timers.js'
import { terminalSupportsJobControl } from '../../../platform/host-os/terminal.js'
import type { EventEmitter } from '../events/emitter.js'
import { inputConsumedThroughSeq, InputEvent } from '../events/input-event.js'
import { TerminalFocusEvent } from '../events/terminal-focus-event.js'
import { finishSelection, type SelectionState } from '../geometry/selection.js'
import {
  INITIAL_STATE,
  type KeyParseState,
  nonAlphanumericKeys,
  parseMultipleKeypresses,
  type ParsedInput,
  type ParsedKey,
  type ParsedMouse,
} from '../input/input-decoder.js'
import instances from '../instances.js'
import reconciler from '../reconciler.js'
import { hasElevatedSurface } from '../recessLayer.js'
import { getTerminalFocused, setTerminalFocused } from '../terminal-session/terminalFocusStore.js'
import type { TerminalQuerier } from '../terminal-session/terminalQuerier.js'
import { resolveAlternateScrollIntent } from '../termio/alternateScrollPolicy.js'
import { FOCUS_IN, FOCUS_OUT } from '../termio/csi.js'

const STDIN_GAP_REASSERT_MS = 5000
const INCOMPLETE_SEQUENCE_TIMEOUT_MS = 50
const PASTE_MODE_TIMEOUT_MS = 500
const LONE_ESCAPE_GRACE_REARMS = 2
const LONE_ESCAPE_MOUSE_WINDOW_MS = 500
const FUNCTIONAL_NAMES = new Set<string>(nonAlphanumericKeys)
const WHEEL_ROWS_PER_NOTCH = 3
const MOTION_BIT = 0x20

const ESCAPE_ATOM: ParsedKey = {
  kind: 'key',
  fn: false,
  name: 'escape',
  ctrl: false,
  meta: false,
  shift: false,
  option: false,
  super: false,
  sequence: '\x1b',
  raw: '\x1b',
  isPasted: false,
}

function isReportedWheel(atom: ParsedInput): atom is ParsedKey {
  return atom.kind === 'key' && (atom.name === 'wheelup' || atom.name === 'wheeldown') && atom.x !== undefined && atom.y !== undefined
}

export function coalesceWheelRun(atoms: readonly ParsedInput[], start: number, pageRows: number): { end: number; atom: ParsedKey | null; steps: number } {
  let end = start
  let net = 0
  let up: ParsedKey | null = null
  let down: ParsedKey | null = null
  while (end < atoms.length) {
    const atom = atoms[end]!
    if (!isReportedWheel(atom)) break
    if (atom.name === 'wheeldown') {
      net++
      down = atom
    } else {
      net--
      up = atom
    }
    end++
  }
  const atom = net > 0 ? down : net < 0 ? up : null
  const steps = atom === null ? 0 : Math.min(Math.abs(net), Math.max(1, Math.floor(pageRows / WHEEL_ROWS_PER_NOTCH)))
  return { end, atom, steps }
}

function isMouseClass(atom: ParsedInput): boolean {
  if (atom.kind === 'mouse') return true
  if (atom.kind !== 'key') return false
  return atom.name === 'mouse' || atom.name === 'wheelup' || atom.name === 'wheeldown'
}

function isActingNamedKey(atom: ParsedInput): boolean {
  if (atom.kind !== 'key') return false
  const name = atom.name
  if (typeof name !== 'string') return false
  if (!FUNCTIONAL_NAMES.has(name)) return false
  return name !== 'wheelup' && name !== 'wheeldown' && name !== 'mouse'
}

function isDragMotion(atom: ParsedInput): boolean {
  return (
    atom.kind === 'mouse' &&
    atom.action === 'press' &&
    (atom.button & MOTION_BIT) !== 0 &&
    (atom.button & 3) === 0
  )
}

type AppInputHost = {
  stdin: () => NodeJS.ReadStream
  stdout: () => NodeJS.WriteStream
  rows: () => number
  exitOnCtrlC: () => boolean
  selection: () => SelectionState
  isRawModeEnabled: () => boolean
  querier: TerminalQuerier
  eventEmitter: EventEmitter
  gesture: { refocusedAt: number }
  onStdinResume: () => void
  notifySelectionChange: () => void
  dispatchKeyboardEvent: (key: ParsedKey) => void
  onMouseEvent: (atom: ParsedMouse) => void
  onSuspend: () => void
  onExit: () => void
}

export class AppInputLoop {
  private keyParseState: KeyParseState = INITIAL_STATE
  private readonly inputBatches: Array<{ atoms: ParsedInput[]; flush: boolean }> = []
  private inputBatchIndex = 0
  private inputDrain: ReturnType<typeof setImmediate> | null = null
  private incompleteEscapeTimer: ReturnType<typeof setTimeout> | null = null
  private loneEscapeGraceUsed = 0
  private lastMouseEventTime = 0
  private lastStdinTime = Date.now()

  constructor(private readonly host: AppInputHost) {
    this.keyParseState = { ...INITIAL_STATE, stringReplyOwed: () => host.querier.stringReplyOwed() }
  }

  dispose(): void {
    if (this.inputDrain) stopImmediate(this.inputDrain)
    this.inputDrain = null
    this.inputBatches.length = 0
    this.inputBatchIndex = 0
    if (this.incompleteEscapeTimer) {
      stopTimeout(this.incompleteEscapeTimer)
      this.incompleteEscapeTimer = null
    }
  }

  handleReadable = (): void => {
    const now = Date.now()
    const quietSpell = now - this.lastStdinTime > STDIN_GAP_REASSERT_MS
    let sawInput = false
    try {
      let chunk: string | Buffer | null
      while ((chunk = this.host.stdin().read() as string | Buffer | null) !== null) {
        if (!sawInput) {
          sawInput = true
          this.lastStdinTime = now
          if (quietSpell) this.host.onStdinResume()
        }
        this.handleInput(chunk)
      }
    } catch (error) {
      logError(error)
      if (
        this.host.isRawModeEnabled() &&
        !this.host.stdin().listeners('readable').includes(this.handleReadable)
      ) {
        this.host.stdin().addListener('readable', this.handleReadable)
        logForDebugging('stdin readable handler re-attached after an exception', {
          level: 'warn',
        })
      }
    }
  }

  private handleInput(chunk: string | Buffer | null): void {
    if (chunk !== null) this.loneEscapeGraceUsed = 0

    const [atoms, nextState] = parseMultipleKeypresses(this.keyParseState, chunk)
    this.keyParseState = nextState

    if (atoms.some(isMouseClass)) this.lastMouseEventTime = Date.now()

    let start = 0
    for (let i = 0; i < atoms.length; i++) {
      const wheel = isReportedWheel(atoms[i]!)
      if (!wheel && !isActingNamedKey(atoms[i]!)) continue
      if (i > start) this.inputBatches.push({ atoms: atoms.slice(start, i), flush: true })
      if (wheel) {
        const gesture = coalesceWheelRun(atoms, i, this.host.rows() - 1)
        for (let step = 0; step < gesture.steps; step++) {
          this.inputBatches.push({ atoms: [gesture.atom!], flush: true })
        }
        start = gesture.end
        i = gesture.end - 1
        continue
      }
      this.inputBatches.push({ atoms: [atoms[i]!], flush: true })
      start = i + 1
    }
    if (start < atoms.length) this.inputBatches.push({ atoms: atoms.slice(start), flush: false })
    if (this.inputDrain === null) this.drainInput()

    const state = this.keyParseState
    if (
      state.incomplete ||
      (state.pendingBytes && state.pendingBytes.length > 0) ||
      state.mode === 'IN_PASTE' ||
      state.heldCR
    ) {
      if (this.incompleteEscapeTimer) stopTimeout(this.incompleteEscapeTimer)
      this.incompleteEscapeTimer = startTimeout(
        this.handleIncompleteFlush,
        state.mode === 'IN_PASTE' ? PASTE_MODE_TIMEOUT_MS : INCOMPLETE_SEQUENCE_TIMEOUT_MS,
      )
    }
  }

  private drainInput = (): void => {
    this.inputDrain = null
    while (this.inputBatchIndex < this.inputBatches.length) {
      const batch = this.inputBatches[this.inputBatchIndex++]!
      const last = this.inputBatchIndex === this.inputBatches.length
      if (last) {
        this.inputBatches.length = 0
        this.inputBatchIndex = 0
      }
      this.inputDrain = startImmediate(this.drainInput)
      try {
        this.dispatchDiscrete(batch.atoms)
        if (batch.flush || !last) reconciler.flushSyncWork()
      } catch (error) {
        logError(error)
      }
      if (batch.flush) return
      if (this.inputDrain) stopImmediate(this.inputDrain)
      this.inputDrain = null
    }
  }

  private dispatchDiscrete(atoms: ParsedInput[]): void {
    reconciler.discreteUpdates(
      () => this.dispatchBatch(atoms),
      undefined,
      undefined,
      undefined,
      undefined,
    )
  }

  pressEscape(): void {
    this.dispatchDiscrete([ESCAPE_ATOM])
    reconciler.flushSyncWork()
  }

  private handleIncompleteFlush = (): void => {
    this.incompleteEscapeTimer = null
    const state = this.keyParseState
    if (!state.incomplete && state.mode !== 'IN_PASTE' && !state.heldCR) return

    if ((this.host.stdin().readableLength ?? 0) > 0) {
      this.incompleteEscapeTimer = startTimeout(
        this.handleIncompleteFlush,
        INCOMPLETE_SEQUENCE_TIMEOUT_MS,
      )
      return
    }

    if (
      state.incomplete === '\x1b' &&
      this.loneEscapeGraceUsed < LONE_ESCAPE_GRACE_REARMS &&
      Date.now() - this.lastMouseEventTime < LONE_ESCAPE_MOUSE_WINDOW_MS
    ) {
      this.loneEscapeGraceUsed++
      this.incompleteEscapeTimer = startTimeout(
        this.handleIncompleteFlush,
        INCOMPLETE_SEQUENCE_TIMEOUT_MS,
      )
      return
    }

    this.loneEscapeGraceUsed = 0
    this.handleInput(null)
  }

  private dispatchBatch(rawAtoms: ParsedInput[]): void {
    const instance = instances.get(this.host.stdout())
    if (rawAtoms.some(atom => isReportedWheel(atom) && atom.sequence?.startsWith('\x1b[<'))) {
      instance?.confirmWheelReporting()
    }
    const atoms = instance
      ? resolveAlternateScrollIntent(rawAtoms, {
          altScreenActive: instance.isAltScreenActive,
          mouseTrackingEnabled: instance.isMouseTrackingEnabled(),
          wheelReportingConfirmed: instance.isWheelReportingConfirmed(),
          scrollableTranscript: instance.hasScrollableTranscriptTarget(),
          elevatedSurfaceActive: hasElevatedSurface(),
          arrowKeysOwned: instance.arrowKeysOwned(),
        })
      : rawAtoms

    if (
      atoms.some(
        atom =>
          atom.kind === 'key' ||
          (atom.kind === 'mouse' &&
            !((atom.button & MOTION_BIT) !== 0 && (atom.button & 3) === 3)),
      )
    ) {
      updateLastInteractionTime()
    }

    let chunkConsumed = false

    for (let i = 0; i < atoms.length; i++) {
      const atom = atoms[i]!
      if (atom.kind === 'response') {
        this.host.querier.onResponse(atom.response)
        continue
      }
      if (atom.kind === 'mouse') {
        const isClickClass = (atom.button & MOTION_BIT) === 0
        if (chunkConsumed && isClickClass) continue
        if (isDragMotion(atom) && i + 1 < atoms.length && isDragMotion(atoms[i + 1]!)) continue
        this.host.onMouseEvent(atom)
        continue
      }
      if (atom.sequence === FOCUS_IN) {
        this.host.gesture.refocusedAt = Date.now()
        setTerminalFocused(true)
        instance?.overwriteScreen()
        this.host.eventEmitter.emit('terminalfocus', new TerminalFocusEvent('terminalfocus'))
        continue
      }
      if (atom.sequence === FOCUS_OUT) {
        setTerminalFocused(false)
        const selection = this.host.selection()
        if (selection.isDragging) {
          finishSelection(selection)
          this.host.notifySelectionChange()
        }
        this.host.eventEmitter.emit('terminalblur', new TerminalFocusEvent('terminalblur'))
        continue
      }
      if (!getTerminalFocused()) setTerminalFocused(true)

      const item = atom
      if (item.name === 'z' && item.ctrl && terminalSupportsJobControl()) {
        this.host.onSuspend()
        continue
      }
      if (chunkConsumed) continue

      this.handleRawInput(atom)
      const alternateWheel = atom !== rawAtoms[i] && instance?.isMouseTrackingEnabled() === true
      const event = new InputEvent(atom, isReportedWheel(atom) || alternateWheel)
      this.host.eventEmitter.emit('input', event)
      if (event.wheelStep && !event.didStopImmediatePropagation()) this.host.eventEmitter.emit('wheel', event)
      if (event.seq <= inputConsumedThroughSeq()) {
        chunkConsumed = true
        continue
      }
      this.host.dispatchKeyboardEvent(atom)
      if (event.seq <= inputConsumedThroughSeq()) chunkConsumed = true
    }
  }

  private handleRawInput(key: ParsedKey): void {
    if (key.sequence === '\x03' && this.host.exitOnCtrlC()) {
      this.host.onExit()
    }
  }
}
