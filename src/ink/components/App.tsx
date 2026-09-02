
import React, { PureComponent, type ReactNode } from 'react'
import { signalInputLive } from '../../boot/launchGraph.js'
import { updateLastInteractionTime } from '../../bootstrap/state.js'
import { persistCrashReport } from '../../utils/crashReport.js'
import { logForDebugging } from '../../utils/debug.js'
import { stopCapturingEarlyInput } from '../../utils/earlyInput.js'
import { isMouseClicksDisabled } from '../../utils/fullscreen.js'
import { logError } from '../../utils/log.js'
import { setHoverPointerDown } from '../../utils/cockpit/hoverOwner.js'
import { markOriginalGroundQuerySent } from '../../utils/cockpit/oasisBg.js'
import { setPointerCell } from '../../utils/cockpit/pointerCell.js'
import {
  applyWarmBackground,
  isWarmBackgroundEnabled,
} from '../../utils/cockpit/warmBackground.js'
import { EventEmitter } from '../events/emitter.js'
import {
  bumpInputEventSeqForMouse,
  inputConsumedThroughSeq,
  InputEvent,
} from '../events/input-event.js'
import { TerminalFocusEvent } from '../events/terminal-focus-event.js'
import {
  finishSelection,
  hasSelection,
  selectionBounds,
  startSelection,
  type SelectionState,
} from '../geometry/selection.js'
import {
  INITIAL_STATE,
  type KeyParseState,
  nonAlphanumericKeys,
  parseMultipleKeypresses,
  type ParsedInput,
  type ParsedKey,
  type ParsedMouse,
} from '../input/input-decoder.js'
import { DECRPM_STATUS } from '../input/interpreter.js'
import instances from '../instances.js'
import reconciler from '../reconciler.js'
import { hasElevatedSurface } from '../recessLayer.js'
import {
  extendedKeysReenable,
  rawModeArmBytes,
  rawModeDisarmBytes,
} from '../root/screen-session.js'
import { noteModeAcquired, noteModeReleased } from '../root/terminalModeLedger.js'
import {
  extendedKeysSupportedNow,
  isDecrqmProbeSafe,
  isXtermJs,
  markSyncProbeOutstanding,
  setXtversionName,
  upgradeExtendedKeysSupport,
  upgradeSyncOutputSupport,
} from '../session/capabilities.js'
import { getTerminalFocused, setTerminalFocused } from '../session/focus-store.js'
import { decrqm, kittyKeyboard, oscColor, TerminalQuerier, xtversion } from '../session/querier.js'
import { resolveTerminalExperience } from '../session/terminalExperience.js'
import { cockpitEngine } from '../../render-engine/cockpit/engineMount.js'
import { termWrite } from '../../render-engine/cockpit/terminalOut.js'
import { resolveAlternateScrollIntent } from '../termio/alternateScrollPolicy.js'
import { FOCUS_IN, FOCUS_OUT } from '../termio/csi.js'
import {
  DFE,
  DISABLE_MOUSE_TRACKING,
  EFE,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from '../termio/dec.js'
import AppContext from './AppContext.js'
import { ClockProvider } from './ClockContext.js'
import CursorDeclarationContext, {
  type CursorDeclarationSetter,
} from './CursorDeclarationContext.js'
import ErrorOverview from './ErrorOverview.js'
import StdinContext from './StdinContext.js'
import { TerminalFocusProvider } from './TerminalFocusContext.js'
import { LiveTerminalSizeContext, TerminalSizeContext, type TerminalSize } from './TerminalSizeContext.js'

const STDIN_GAP_REASSERT_MS = 5000
const INCOMPLETE_SEQUENCE_TIMEOUT_MS = 50
const PASTE_MODE_TIMEOUT_MS = 500
const LONE_ESCAPE_GRACE_REARMS = 2
const LONE_ESCAPE_MOUSE_WINDOW_MS = 500
const MULTI_CLICK_WINDOW_MS = 500
const MULTI_CLICK_TOLERANCE_CELLS = 1
const REFOCUS_CLICK_WINDOW_MS = 200

const OSC_BACKGROUND_COLOR = 11

const RAW_MODE_LEDGER_OWNER = 'app-raw-mode'
const CURSOR_LEDGER_OWNER = 'app-cursor'

const FUNCTIONAL_NAMES = new Set<string>(nonAlphanumericKeys)

type Props = {
  readonly children: ReactNode
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
  readonly exitOnCtrlC: boolean
  readonly onExit: (error?: Error) => void
  readonly columns: number
  readonly rows: number
  readonly selection: SelectionState
  readonly notifySelectionChange: () => void
  readonly dispatchClick: (col: number, row: number) => boolean
  readonly dispatchHover: (col: number, row: number) => void
  readonly getHyperlinkAt: (col: number, row: number) => string | undefined
  readonly openHyperlink: (url: string) => void
  readonly handleMultiClick: (col: number, row: number, count: 2 | 3) => void
  readonly handleSelectionDrag: (col: number, row: number) => void
  readonly handleSelectionStart?: (col: number, row: number) => void
  readonly onStdinResume: () => void
  readonly setCursorDeclaration?: CursorDeclarationSetter
  readonly dispatchKeyboardEvent: (key: ParsedKey) => void
}

type State = {
  readonly error?: Error
}

const noopCursorDeclaration: CursorDeclarationSetter = () => {}

const SUPPORTS_SUSPEND = process.platform !== 'win32'

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

const MOTION_BIT = 0x20
const ALT_MODIFIER_BIT = 0x08

export default class App extends PureComponent<Props, State> {
  static displayName = 'InternalApp'

  override state: State = {}

  private rawModeEnabledCount = 0
  private readonly internal_eventEmitter = new EventEmitter()
  private keyParseState: KeyParseState = INITIAL_STATE
  private incompleteEscapeTimer: ReturnType<typeof setTimeout> | null = null
  private loneEscapeGraceUsed = 0
  private lastMouseEventTime = 0
  private readonly querier: TerminalQuerier
  readonly gesture = {
    lastClickTime: 0,
    lastClickCol: -1,
    lastClickRow: -1,
    clickCount: 0,
    pendingHyperlinkTimer: null as ReturnType<typeof setTimeout> | null,
    lastHoverCol: -1,
    lastHoverRow: -1,
    refocusedAt: -1,
    swallowRelease: false,
  }
  private lastStdinTime = Date.now()
  private terminalSize: TerminalSize = { columns: 0, rows: 0 }

  constructor(props: Props) {
    super(props)
    this.querier = new TerminalQuerier(props.stdout)
  }

  private get isRawModeSupported(): boolean {
    return this.props.stdin.isTTY === true
  }


  override componentDidMount() {
    if (
      this.props.stdout.isTTY &&
      !resolveTerminalExperience().accessibility.effective
    ) {
      termWrite(this.props.stdout, HIDE_CURSOR, 'mode')
      noteModeAcquired(CURSOR_LEDGER_OWNER, 'cursor-hidden')
    }
    import('../../substrate/launchMilestones.js')
      .then(m => m.recordLaunchMilestone('first-frame'))
      .catch(() => {})
  }

  override componentWillUnmount(): void {
    if (this.props.stdout.isTTY) {
      termWrite(this.props.stdout, SHOW_CURSOR, 'mode')
      noteModeReleased(CURSOR_LEDGER_OWNER, 'cursor-hidden')
    }
    if (this.incompleteEscapeTimer) {
      clearTimeout(this.incompleteEscapeTimer)
      this.incompleteEscapeTimer = null
    }
    if (this.gesture.pendingHyperlinkTimer) {
      clearTimeout(this.gesture.pendingHyperlinkTimer)
      this.gesture.pendingHyperlinkTimer = null
    }
    if (this.isRawModeSupported) this.handleSetRawMode(false)
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    persistCrashReport(error, errorInfo, 'app-root')
    this.handleExit(error)
  }

  override render(): ReactNode {
    const { columns, rows } = this.props
    if (this.terminalSize.columns !== columns || this.terminalSize.rows !== rows) {
      this.terminalSize = { columns, rows }
    }
    return (
      <LiveTerminalSizeContext.Provider value={this.terminalSize}>
      <TerminalSizeContext.Provider value={this.terminalSize}>
        <AppContext.Provider value={{ exit: this.handleExit }}>
          <StdinContext.Provider
            value={{
              stdin: this.props.stdin,
              setRawMode: this.handleSetRawMode,
              isRawModeSupported: this.isRawModeSupported,
              internal_exitOnCtrlC: this.props.exitOnCtrlC,
              internal_eventEmitter: this.internal_eventEmitter,
              internal_querier: this.querier,
            }}
          >
            <TerminalFocusProvider>
              <ClockProvider>
                <CursorDeclarationContext.Provider
                  value={this.props.setCursorDeclaration ?? noopCursorDeclaration}
                >
                  {this.state.error ? (
                    <ErrorOverview error={this.state.error} />
                  ) : (
                    this.props.children
                  )}
                </CursorDeclarationContext.Provider>
              </ClockProvider>
            </TerminalFocusProvider>
          </StdinContext.Provider>
        </AppContext.Provider>
      </TerminalSizeContext.Provider>
      </LiveTerminalSizeContext.Provider>
    )
  }


  handleSetRawMode = (isEnabled: boolean): void => {
    const { stdin } = this.props
    if (!this.isRawModeSupported) {
      if (stdin === process.stdin) {
        throw new Error(
          'Raw mode is not supported on the current process.stdin, which the app uses as an input stream by default. See the raw-mode documentation for how to prevent this error.',
        )
      }
      throw new Error(
        'Raw mode is not supported on the stdin provided to the app. See the raw-mode documentation for how to prevent this error.',
      )
    }
    stdin.setEncoding('utf8')

    if (isEnabled) {
      if (this.rawModeEnabledCount === 0) {
        stopCapturingEarlyInput()
        stdin.ref()
        stdin.setRawMode(true)
        stdin.addListener('readable', this.handleReadable)
        signalInputLive();
        const extendedKeys = extendedKeysSupportedNow()
        termWrite(this.props.stdout, rawModeArmBytes(extendedKeys), 'mode')
        noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'bracketed-paste')
        noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'focus-events')
        if (extendedKeys) noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'kitty-kbd')
        void this.probeTerminalIdentity()
      }
      this.rawModeEnabledCount++
      return
    }

    if (--this.rawModeEnabledCount === 0) {
      termWrite(this.props.stdout, rawModeDisarmBytes(), 'mode')
      noteModeReleased(RAW_MODE_LEDGER_OWNER, 'kitty-kbd')
      noteModeReleased(RAW_MODE_LEDGER_OWNER, 'focus-events')
      noteModeReleased(RAW_MODE_LEDGER_OWNER, 'bracketed-paste')
      stdin.setRawMode(false)
      stdin.removeListener('readable', this.handleReadable)
      stdin.unref()
    }
  }

  private async probeTerminalIdentity(): Promise<void> {
    try {
      const versionQuery = this.querier.send(xtversion())
      let backgroundQuery: Promise<{ type: 'osc'; code: number; data: string } | undefined> =
        Promise.resolve(undefined)
      const warmBackground = isWarmBackgroundEnabled()
      if (warmBackground) {
        markOriginalGroundQuerySent()
        backgroundQuery = this.querier.send(oscColor(OSC_BACKGROUND_COLOR))
      }
      if (isDecrqmProbeSafe()) markSyncProbeOutstanding(true)
      const syncQuery = isDecrqmProbeSafe() ? this.querier.send(decrqm(2026)) : Promise.resolve(undefined)
      const kittyQuery = this.querier.send(kittyKeyboard())
      const [version, background, sync, kitty] = await Promise.all([
        versionQuery,
        backgroundQuery,
        syncQuery,
        kittyQuery,
        this.querier.flush(),
      ])
      if (version) {
        setXtversionName(version.name)
        logForDebugging(`Terminal identified via XTVERSION: ${version.name}`)
      } else {
        logForDebugging('XTVERSION query ignored by the terminal')
      }
      if (warmBackground) {
        if (background && background.type === 'osc' && typeof background.data === 'string') {
          applyWarmBackground(background.data, this.props.stdout)
        } else {
          logForDebugging('Warm background enabled but the OSC 11 query got no reply — canvas not painted')
        }
      }
      if (
        sync &&
        (sync.status === DECRPM_STATUS.SET || sync.status === DECRPM_STATUS.RESET)
      ) {
        upgradeSyncOutputSupport()
        logForDebugging('Synchronized output (DEC 2026) recognised by the terminal probe')
      }
      markSyncProbeOutstanding(false)
      if (kitty !== undefined) {
        const wasActive = extendedKeysSupportedNow()
        upgradeExtendedKeysSupport()
        if (!wasActive && this.rawModeEnabledCount > 0) {
          termWrite(this.props.stdout, extendedKeysReenable(true), 'mode')
          noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'kitty-kbd')
        }
        logForDebugging(
          `Kitty keyboard protocol proved by the terminal probe (flags=${kitty.flags})${wasActive ? '' : ' — extended keys pushed'}`,
        )
      }
    } catch (error) {
      markSyncProbeOutstanding(false)
      logError(error)
    }
  }


  handleReadable = (): void => {
    const now = Date.now()
    const quietSpell = now - this.lastStdinTime > STDIN_GAP_REASSERT_MS
    let sawInput = false
    try {
      let chunk: string | Buffer | null
      while ((chunk = this.props.stdin.read() as string | Buffer | null) !== null) {
        if (!sawInput) {
          sawInput = true
          this.lastStdinTime = now
          if (quietSpell) this.props.onStdinResume()
        }
        this.handleInput(chunk)
      }
    } catch (error) {
      logError(error)
      if (
        this.rawModeEnabledCount > 0 &&
        !this.props.stdin.listeners('readable').includes(this.handleReadable)
      ) {
        this.props.stdin.addListener('readable', this.handleReadable)
        logForDebugging('stdin readable handler re-attached after an exception', {
          level: 'warn',
        })
      }
    }
  }

  private handleInput(chunk: string | Buffer | null): void {
    if (chunk !== null) this.loneEscapeGraceUsed = 0
    if (chunk !== null) cockpitEngine()?.noteKeystroke()

    const [atoms, nextState] = parseMultipleKeypresses(this.keyParseState, chunk)
    this.keyParseState = nextState

    if (atoms.some(isMouseClass)) this.lastMouseEventTime = Date.now()

    let start = 0
    for (let i = 0; i < atoms.length; i++) {
      if (!isActingNamedKey(atoms[i]!)) continue
      if (i > start) {
        const run = atoms.slice(start, i)
        this.dispatchDiscrete(run)
        reconciler.flushSyncWork()
      }
      this.dispatchDiscrete([atoms[i]!])
      reconciler.flushSyncWork()
      start = i + 1
    }
    if (start < atoms.length) {
      this.dispatchDiscrete(atoms.slice(start))
    }

    const state = this.keyParseState
    if (
      state.incomplete ||
      (state.pendingBytes && state.pendingBytes.length > 0) ||
      state.mode === 'IN_PASTE' ||
      state.heldCR
    ) {
      if (this.incompleteEscapeTimer) clearTimeout(this.incompleteEscapeTimer)
      this.incompleteEscapeTimer = setTimeout(
        this.handleIncompleteFlush,
        state.mode === 'IN_PASTE' ? PASTE_MODE_TIMEOUT_MS : INCOMPLETE_SEQUENCE_TIMEOUT_MS,
      )
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

  private handleIncompleteFlush = (): void => {
    this.incompleteEscapeTimer = null
    const state = this.keyParseState
    if (!state.incomplete && state.mode !== 'IN_PASTE' && !state.heldCR) return

    if ((this.props.stdin.readableLength ?? 0) > 0) {
      this.incompleteEscapeTimer = setTimeout(
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
      this.incompleteEscapeTimer = setTimeout(
        this.handleIncompleteFlush,
        INCOMPLETE_SEQUENCE_TIMEOUT_MS,
      )
      return
    }

    this.loneEscapeGraceUsed = 0
    this.handleInput(null)
  }


  private dispatchBatch(rawAtoms: ParsedInput[]): void {
    const instance = instances.get(this.props.stdout)
    const atoms = instance
      ? resolveAlternateScrollIntent(rawAtoms, {
          altScreenActive: instance.isAltScreenActive,
          mouseTrackingEnabled: instance.isMouseTrackingEnabled(),
          elevatedSurfaceActive: hasElevatedSurface(),
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

    for (const atom of atoms) {
      if (atom.kind === 'response') {
        this.querier.onResponse(atom.response)
        continue
      }
      if (atom.kind === 'mouse') {
        const isClickClass = (atom.button & MOTION_BIT) === 0
        if (chunkConsumed && isClickClass) continue
        handleMouseEvent(this, atom)
        continue
      }
      if (atom.sequence === FOCUS_IN) {
        this.gesture.refocusedAt = Date.now()
        setTerminalFocused(true)
        this.internal_eventEmitter.emit('terminalfocus', new TerminalFocusEvent('terminalfocus'))
        continue
      }
      if (atom.sequence === FOCUS_OUT) {
        setTerminalFocused(false)
        if (this.props.selection.isDragging) {
          finishSelection(this.props.selection)
          this.props.notifySelectionChange()
        }
        this.internal_eventEmitter.emit('terminalblur', new TerminalFocusEvent('terminalblur'))
        continue
      }
      if (!getTerminalFocused()) setTerminalFocused(true)

      const item = atom
      if (item.name === 'z' && item.ctrl && SUPPORTS_SUSPEND) {
        this.handleSuspend()
        continue
      }
      if (chunkConsumed) continue

      this.handleRawInput(atom)
      const event = new InputEvent(atom)
      this.internal_eventEmitter.emit('input', event)
      if (event.seq <= inputConsumedThroughSeq()) {
        chunkConsumed = true
        continue
      }
      this.props.dispatchKeyboardEvent(atom)
      if (event.seq <= inputConsumedThroughSeq()) chunkConsumed = true
    }
  }

  private handleRawInput(key: ParsedKey): void {
    if (key.sequence === '\x03' && this.props.exitOnCtrlC) {
      this.handleExit()
    }
  }


  handleExit = (error?: Error): void => {
    if (this.isRawModeSupported) this.handleSetRawMode(false)
    this.props.onExit(error)
  }

  setTerminalFocus(focused: boolean): void {
    setTerminalFocused(focused)
  }

  private handleSuspend(): void {
    if (!this.isRawModeSupported) return
    const savedCount = this.rawModeEnabledCount
    while (this.rawModeEnabledCount > 0) this.handleSetRawMode(false)
    if (this.props.stdout.isTTY) {
      termWrite(this.props.stdout, SHOW_CURSOR + DFE + DISABLE_MOUSE_TRACKING, 'mode')
    }
    this.internal_eventEmitter.emit('suspend')
    const onContinue = (): void => {
      for (let i = 0; i < savedCount; i++) this.handleSetRawMode(true)
      if (
        this.props.stdout.isTTY &&
        !resolveTerminalExperience().accessibility.effective
      ) {
        termWrite(this.props.stdout, HIDE_CURSOR, 'mode')
      }
      termWrite(this.props.stdout, EFE, 'mode')
      this.internal_eventEmitter.emit('resume')
      process.removeListener('SIGCONT', onContinue)
    }
    process.on('SIGCONT', onContinue)
    process.kill(process.pid, 'SIGSTOP')
  }

}

function toCell(atom: ParsedMouse): { col: number; row: number } {
  return { col: atom.col - 1, row: atom.row - 1 }
}

export function isRefocusPress(state: { focused: boolean; refocusedAt: number; now: number }): boolean {
  if (!state.focused) return true
  return state.refocusedAt >= 0 && state.now - state.refocusedAt <= REFOCUS_CLICK_WINDOW_MS
}

export function handleMouseEvent(app: App, atom: ParsedMouse): void {
  if (isMouseClicksDisabled()) return

  bumpInputEventSeqForMouse()

  const { col, row } = toCell(atom)
  setPointerCell(col, row)
  const baseButton = atom.button & 3
  const isMotion = (atom.button & MOTION_BIT) !== 0
  const props = app.props
  const selection = props.selection
  const m = app.gesture

  if (atom.action === 'press') {
    if (isMotion && baseButton === 3) {
      if (selection.isDragging) {
        finishSelection(selection)
        props.notifySelectionChange()
      }
      setHoverPointerDown(false)
      if (col === m.lastHoverCol && row === m.lastHoverRow) return
      m.lastHoverCol = col
      m.lastHoverRow = row
      props.dispatchHover(col, row)
      return
    }
    if (baseButton !== 0) {
      m.clickCount = 0
      return
    }
    if (isMotion) {
      props.handleSelectionDrag(col, row)
      return
    }
    if (selection.isDragging) {
      finishSelection(selection)
      props.notifySelectionChange()
    }
    const now = Date.now()
    if (isRefocusPress({ focused: getTerminalFocused(), refocusedAt: m.refocusedAt, now })) {
      setTerminalFocused(true)
      m.refocusedAt = -1
      m.swallowRelease = true
      m.clickCount = 0
      return
    }
    setHoverPointerDown(true)
    const nearLast =
      now - m.lastClickTime <= MULTI_CLICK_WINDOW_MS &&
      Math.abs(col - m.lastClickCol) <= MULTI_CLICK_TOLERANCE_CELLS &&
      Math.abs(row - m.lastClickRow) <= MULTI_CLICK_TOLERANCE_CELLS
    m.clickCount = nearLast ? m.clickCount + 1 : 1
    m.lastClickTime = now
    m.lastClickCol = col
    m.lastClickRow = row
    if (m.clickCount >= 2) {
      if (m.pendingHyperlinkTimer) {
        clearTimeout(m.pendingHyperlinkTimer)
        m.pendingHyperlinkTimer = null
      }
      const count: 2 | 3 = m.clickCount >= 3 ? 3 : 2
      m.clickCount = Math.min(m.clickCount, 3)
      props.handleMultiClick(col, row, count)
      return
    }
    if (props.handleSelectionStart) {
      props.handleSelectionStart(col, row)
    } else {
      startSelection(selection, col, row)
    }
    selection.lastPressHadAlt = (atom.button & ALT_MODIFIER_BIT) !== 0
    props.notifySelectionChange()
    return
  }

  setHoverPointerDown(false)
  if (m.swallowRelease) {
    m.swallowRelease = false
    return
  }
  if (baseButton !== 0) {
    if (!selection.isDragging) return
    finishSelection(selection)
    props.notifySelectionChange()
    return
  }

  const bounds = selectionBounds(selection)
  const slop =
    selection.anchorSpan === null &&
    bounds !== null &&
    selection.anchor !== null &&
    bounds.start.row === bounds.end.row &&
    Math.abs(bounds.end.col - bounds.start.col) <= MULTI_CLICK_TOLERANCE_CELLS
  if (slop) {
    selection.focus = null
    selection.isDragging = false
  } else {
    finishSelection(selection)
  }

  const isClick = slop || (!hasSelection(selection) && selection.anchor !== null)
  if (isClick) {
    const consumed = props.dispatchClick(col, row)
    if (!consumed) {
      const url = props.getHyperlinkAt(col, row)
      const embeddedWebTerminal = process.env.TERM_PROGRAM === 'vscode' || isXtermJs()
      if (url && !embeddedWebTerminal) {
        if (m.pendingHyperlinkTimer) clearTimeout(m.pendingHyperlinkTimer)
        m.pendingHyperlinkTimer = setTimeout(() => {
          m.pendingHyperlinkTimer = null
          props.openHyperlink(url)
        }, MULTI_CLICK_WINDOW_MS)
      }
    }
  }
  props.notifySelectionChange()
}
