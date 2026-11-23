import React, { PureComponent, type ReactNode } from 'react'
import { LayoutChromeProvider } from '../../context/layoutChromeContext.js'
import { signalInputLive } from '../../boot/launchGraph.js'
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
import { bumpInputEventSeqForMouse } from '../events/input-event.js'
import {
  finishSelection,
  hasSelection,
  selectionBounds,
  startSelection,
  type SelectionState,
} from '../geometry/selection.js'
import type { ParsedKey, ParsedMouse } from '../input/input-decoder.js'
import { DECRPM_STATUS } from '../input/interpreter.js'
import instances from '../instances.js'
import { dismissByOutsidePress, elevatedSurfaceContains } from '../recessLayer.js'
import { anyModalOverlayActive } from '../../context/overlayStack.js'
import {
  extendedKeysReenable,
  rawModeArmBytes,
  rawModeDisarmBytes,
} from '../root/screen-session.js'
import { noteModeAcquired, noteModeReleased } from '../root/terminalModeLedger.js'
import {
  extendedKeysSupportedNow,
  isDecrqmProbeSafe,
  isExtendedCsiSafe,
  isXtermJs,
  markSyncProbeOutstanding,
  setXtversionName,
  upgradeExtendedKeysSupport,
  upgradeSyncOutputSupport,
} from '../session/capabilities.js'
import { getTerminalFocused, setTerminalFocused } from '../session/focus-store.js'
import { decrqm, kittyKeyboard, oscColor, TerminalQuerier, terminalQuerySettleMs, xtversion } from '../session/querier.js'
import { resolveTerminalExperience } from '../session/terminalExperience.js'
import { queueTerminalWidthProbe } from '../session/widthProbe.js'
import { termWrite } from '../terminalOut.js'
import { HIDE_CURSOR, SHOW_CURSOR } from '../termio/dec.js'
import AppContext from './AppContext.js'
import { AppInputLoop, coalesceWheelRun } from './AppInputLoop.js'
import { ClockProvider } from './ClockContext.js'
import CursorDeclarationContext, {
  type CursorDeclarationSetter,
} from './CursorDeclarationContext.js'
import ErrorOverview from './ErrorOverview.js'
import StdinContext from './StdinContext.js'
import { TerminalFocusProvider } from './TerminalFocusContext.js'
import { LiveTerminalSizeContext, TerminalSizeContext, type TerminalSize } from './TerminalSizeContext.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'
import { notBuilt } from '../../pi/holes.js'

const MULTI_CLICK_WINDOW_MS = 500
const MULTI_CLICK_TOLERANCE_CELLS = 1
export const REFOCUS_CLICK_WINDOW_MS = 200
export { coalesceWheelRun }

const OSC_BACKGROUND_COLOR = 11

const RAW_MODE_LEDGER_OWNER = 'app-raw-mode'
const CURSOR_LEDGER_OWNER = 'app-cursor'
type Props = {
  readonly children: ReactNode
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
  readonly columns: number
  readonly rows: number
  readonly exitOnCtrlC: boolean
  readonly onExit: (error?: Error) => void
  readonly dispatchKeyboardEvent: (parsedKey: ParsedKey) => void
  readonly onStdinResume: () => void
  readonly selection: SelectionState
  readonly notifySelectionChange: () => void
  readonly handleMultiClick: (col: number, row: number, count: 2 | 3) => void
  readonly handleSelectionDrag: (col: number, row: number) => void
  readonly handleSelectionStart?: (col: number, row: number, pressHadAlt: boolean) => void
  readonly handleSelectionRelease?: (col: number, row: number) => boolean
  readonly dispatchClick: (col: number, row: number) => boolean
  readonly dispatchHover: (col: number, row: number) => void
  readonly getHyperlinkAt: (col: number, row: number) => string | undefined
  readonly openHyperlink: (url: string) => void
  readonly setCursorDeclaration?: CursorDeclarationSetter
}

type State = {
  readonly error?: Error
}

const noopCursorDeclaration: CursorDeclarationSetter = () => {}

const MOTION_BIT = 0x20
const ALT_MODIFIER_BIT = 0x08

function clickOutsideElevatedSurface(col: number, row: number): boolean {
  return anyModalOverlayActive() && elevatedSurfaceContains(col, row) === false
}
export default class App extends PureComponent<Props, State> {
  static displayName = 'InternalApp'

  override state: State = {}

  private rawModeEnabledCount = 0
  private identityProbed = false
  private readonly internal_eventEmitter = new EventEmitter()
  private readonly querier: TerminalQuerier
  private readonly inputLoop: AppInputLoop
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
  private terminalSize: TerminalSize = { columns: 0, rows: 0 }

  constructor(props: Props) {
    super(props)
    this.querier = new TerminalQuerier(props.stdout)
    this.inputLoop = new AppInputLoop({
      stdin: () => this.props.stdin,
      stdout: () => this.props.stdout,
      rows: () => this.props.rows,
      exitOnCtrlC: () => this.props.exitOnCtrlC,
      selection: () => this.props.selection,
      isRawModeEnabled: () => this.rawModeEnabledCount > 0,
      querier: this.querier,
      eventEmitter: this.internal_eventEmitter,
      gesture: this.gesture,
      onStdinResume: () => this.props.onStdinResume(),
      notifySelectionChange: () => this.props.notifySelectionChange(),
      dispatchKeyboardEvent: key => this.props.dispatchKeyboardEvent(key),
      onMouseEvent: atom => handleMouseEvent(this, atom),
      onSuspend: () => this.handleSuspend(),
      onExit: () => this.handleExit(),
    })
  }
  private get isRawModeSupported(): boolean {
    return this.props.stdin.isTTY === true
  }


  override componentDidMount() {
    if (
      this.props.stdout.isTTY &&
      !resolveTerminalExperience().accessibility.effective
    ) {
      termWrite(this.props.stdout, HIDE_CURSOR)
      noteModeAcquired(CURSOR_LEDGER_OWNER, 'cursor-hidden')
    }
  }

  override componentDidUpdate(prevProps: Props): void {
    if (prevProps.stdin === this.props.stdin || this.rawModeEnabledCount <= 0) return
    prevProps.stdin.removeListener('readable', this.inputLoop.handleReadable)
    if (!this.isRawModeSupported) return
    const { stdin } = this.props
    stdin.setEncoding('utf8')
    stdin.ref()
    stdin.setRawMode(true)
    stdin.addListener('readable', this.inputLoop.handleReadable)
    logForDebugging(
      `stdin reader moved to a fresh terminal stream (raw=${stdin.isRaw ? 'true' : 'false'})`,
      { level: 'warn' },
    )
  }

  override componentWillUnmount(): void {
    if (this.props.stdout.isTTY) {
      termWrite(this.props.stdout, SHOW_CURSOR)
      noteModeReleased(CURSOR_LEDGER_OWNER, 'cursor-hidden')
    }
    this.inputLoop.dispose()
    if (this.gesture.pendingHyperlinkTimer !== null) {
      stopTimeout(this.gesture.pendingHyperlinkTimer)
      this.gesture.pendingHyperlinkTimer = null
    }
    if (this.isRawModeSupported) {
      this.handleSetRawMode(false)
    }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    persistCrashReport(error, errorInfo, 'app-root')
    this.handleExit(error)
  }

  override render(): ReactNode {
    if (
      this.terminalSize.columns !== this.props.columns ||
      this.terminalSize.rows !== this.props.rows
    ) {
      this.terminalSize = {
        columns: this.props.columns,
        rows: this.props.rows,
      }
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
                      <LayoutChromeProvider
                        fullscreen={this.props.stdout.isTTY ? undefined : false}
                      >
                        {this.props.children}
                      </LayoutChromeProvider>
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
        stdin.addListener('readable', this.inputLoop.handleReadable)
        signalInputLive()
        const extendedKeys = extendedKeysSupportedNow()
        termWrite(this.props.stdout, rawModeArmBytes(extendedKeys))
        noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'bracketed-paste')
        noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'focus-events')
        if (extendedKeys) {
          noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'kitty-kbd')
        }
        if (!this.identityProbed) {
          this.identityProbed = true
          void this.probeTerminalIdentity()
        }
      }
      this.rawModeEnabledCount++
      return
    }

    if (--this.rawModeEnabledCount === 0) {
      termWrite(this.props.stdout, rawModeDisarmBytes())
      noteModeReleased(RAW_MODE_LEDGER_OWNER, 'kitty-kbd')
      noteModeReleased(RAW_MODE_LEDGER_OWNER, 'focus-events')
      noteModeReleased(RAW_MODE_LEDGER_OWNER, 'bracketed-paste')
      stdin.setRawMode(false)
      stdin.removeListener('readable', this.inputLoop.handleReadable)
      stdin.unref()
    }
  }

  private async probeTerminalIdentity(): Promise<void> {
    return notBuilt('src/ink/components/App.tsx:289')
  }

  pressEscape(): void {
    this.inputLoop.pressEscape()
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
    void this.querier.whenSettled(terminalQuerySettleMs()).then(() => this.stopForSuspend())
  }

  private stopForSuspend(): void {
    this.internal_eventEmitter.emit('suspend')
    const onContinue = (): void => {
      this.internal_eventEmitter.emit('resume')
      process.removeListener('SIGCONT', onContinue)
    }
    process.on('SIGCONT', onContinue)
    process.kill(process.pid, 'SIGTSTP')
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

  const button = atom.button & 3
  const isMotion = (atom.button & MOTION_BIT) !== 0
  const hadAlt = (atom.button & ALT_MODIFIER_BIT) !== 0
  const { props, gesture } = app
  const { selection } = props

  const cancelPendingHyperlink = (): void => {
    if (gesture.pendingHyperlinkTimer !== null) {
      stopTimeout(gesture.pendingHyperlinkTimer)
      gesture.pendingHyperlinkTimer = null
    }
  }

  if (atom.action === 'press') {
    if (isMotion && button === 3) {
      if (selection.isDragging) {
        finishSelection(selection)
        props.notifySelectionChange()
      }
      setHoverPointerDown(false)
      if (gesture.lastHoverCol !== col || gesture.lastHoverRow !== row) {
        gesture.lastHoverCol = col
        gesture.lastHoverRow = row
        props.dispatchHover(col, row)
      }
      return
    }

    if (button !== 0) {
      gesture.clickCount = 0
      return
    }

    if (isMotion) {
      if (!gesture.swallowRelease) {
        props.handleSelectionDrag(col, row)
      }
      return
    }

    if (selection.isDragging) {
      finishSelection(selection)
      props.notifySelectionChange()
    }

    const now = Date.now()
    if (
      isRefocusPress({
        focused: getTerminalFocused(),
        refocusedAt: gesture.refocusedAt,
        now,
      })
    ) {
      setTerminalFocused(true)
      gesture.refocusedAt = -1
      gesture.swallowRelease = true
      gesture.clickCount = 0
      return
    }

    gesture.swallowRelease = false
    if (clickOutsideElevatedSurface(col, row)) {
      cancelPendingHyperlink()
      gesture.swallowRelease = true
      gesture.clickCount = 0
      dismissByOutsidePress(() => app.pressEscape())
      return
    }

    setHoverPointerDown(true)
    const continuesRun =
      now - gesture.lastClickTime <= MULTI_CLICK_WINDOW_MS &&
      Math.abs(col - gesture.lastClickCol) <= MULTI_CLICK_TOLERANCE_CELLS &&
      Math.abs(row - gesture.lastClickRow) <= MULTI_CLICK_TOLERANCE_CELLS
    gesture.clickCount = continuesRun ? gesture.clickCount + 1 : 1
    gesture.lastClickTime = now
    gesture.lastClickCol = col
    gesture.lastClickRow = row

    if (gesture.clickCount >= 2) {
      cancelPendingHyperlink()
      const count: 2 | 3 = gesture.clickCount >= 3 ? 3 : 2
      gesture.clickCount = count
      props.handleMultiClick(col, row, count)
    } else if (props.handleSelectionStart) {
      props.handleSelectionStart(col, row, hadAlt)
    } else {
      startSelection(selection, col, row)
      selection.lastPressHadAlt = hadAlt
      props.notifySelectionChange()
    }
    return
  }

  setHoverPointerDown(false)
  if (gesture.swallowRelease) {
    gesture.swallowRelease = false
    return
  }

  if (button !== 0) {
    if (selection.isDragging) {
      finishSelection(selection)
      props.notifySelectionChange()
    }
    return
  }

  if (props.handleSelectionRelease?.(col, row)) {
    return
  }

  const bounds = selectionBounds(selection)
  const isSlop =
    selection.anchorSpan === null &&
    selection.anchor !== null &&
    bounds !== null &&
    bounds.start.row === bounds.end.row &&
    bounds.end.col - bounds.start.col <= 1

  if (isSlop) {
    selection.focus = null
    selection.isDragging = false
  } else {
    finishSelection(selection)
  }

  const isClick = isSlop || (selection.anchor !== null && !hasSelection(selection))
  if (isClick) {
    if (!props.dispatchClick(col, row)) {
      const url = props.getHyperlinkAt(col, row)
      if (url && hostEnv().TERM_PROGRAM !== 'vscode' && !isXtermJs()) {
        cancelPendingHyperlink()
        gesture.pendingHyperlinkTimer = startTimeout(() => {
          gesture.pendingHyperlinkTimer = null
          props.openHyperlink(url)
        }, MULTI_CLICK_WINDOW_MS)
      }
    }
  }

  props.notifySelectionChange()
}
