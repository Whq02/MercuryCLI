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
  readonly handleSelectionStart?: (col: number, row: number, pressHadAlt: boolean) => void
  readonly handleSelectionRelease?: (col: number, row: number) => boolean
  readonly onStdinResume: () => void
  readonly setCursorDeclaration?: CursorDeclarationSetter
  readonly dispatchKeyboardEvent: (key: ParsedKey) => void
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
    if (prevProps.stdin === this.props.stdin || this.rawModeEnabledCount === 0) return
    prevProps.stdin.removeListener('readable', this.inputLoop.handleReadable)
    const { stdin } = this.props
    if (!stdin.isTTY) return
    stdin.setEncoding('utf8')
    stdin.ref()
    stdin.setRawMode(true)
    stdin.addListener('readable', this.inputLoop.handleReadable)
    logForDebugging(`stdin reader moved to a fresh terminal stream (raw=${stdin.isRaw === true})`, { level: 'warn' })
  }

  override componentWillUnmount(): void {
    if (this.props.stdout.isTTY) {
      termWrite(this.props.stdout, SHOW_CURSOR)
      noteModeReleased(CURSOR_LEDGER_OWNER, 'cursor-hidden')
    }
    this.inputLoop.dispose()
    if (this.gesture.pendingHyperlinkTimer) {
      stopTimeout(this.gesture.pendingHyperlinkTimer)
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
                    <LayoutChromeProvider fullscreen={this.props.stdout.isTTY ? undefined : false}>{this.props.children}</LayoutChromeProvider>
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
        signalInputLive();
        const extendedKeys = extendedKeysSupportedNow()
        termWrite(this.props.stdout, rawModeArmBytes(extendedKeys))
        noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'bracketed-paste')
        noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'focus-events')
        if (extendedKeys) noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'kitty-kbd')
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
    let finishWidthProbe: (() => void) | null = null
    try {
      const versionQuery = isExtendedCsiSafe() ? this.querier.send(xtversion()) : Promise.resolve(undefined)
      let backgroundQuery: Promise<{ type: 'osc'; code: number; data: string } | undefined> =
        Promise.resolve(undefined)
      const warmBackground = isWarmBackgroundEnabled()
      if (warmBackground) {
        markOriginalGroundQuerySent()
        backgroundQuery = this.querier.send(oscColor(OSC_BACKGROUND_COLOR))
      }
      if (isDecrqmProbeSafe()) markSyncProbeOutstanding(true)
      const syncQuery = isDecrqmProbeSafe() ? this.querier.send(decrqm(2026)) : Promise.resolve(undefined)
      const kittyQuery = isExtendedCsiSafe() ? this.querier.send(kittyKeyboard()) : Promise.resolve(undefined)
      const ink = instances.get(this.props.stdout)
      const queueWidthProbe = (): (() => void) | null =>
        queueTerminalWidthProbe(this.querier, this.props.stdout, () => {
          instances.get(this.props.stdout)?.forceRedraw()
        }, instances.get(this.props.stdout)?.isAltScreenActive === true)
      if (ink?.isAltEntryPending() === true) {
        const stop = ink.subscribeFrame(() => {
          if (ink.isAltEntryPending()) return
          stop()
          if (this.rawModeEnabledCount === 0) return
          const finish = queueWidthProbe()
          if (finish !== null) void this.querier.flush().then(finish, finish)
        })
      } else {
        finishWidthProbe = queueWidthProbe()
      }
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
          termWrite(this.props.stdout, extendedKeysReenable(true))
          noteModeAcquired(RAW_MODE_LEDGER_OWNER, 'kitty-kbd')
        }
        logForDebugging(
          `Kitty keyboard protocol proved by the terminal probe (flags=${kitty.flags})${wasActive ? '' : ' — extended keys pushed'}`,
        )
      }
    } catch (error) {
      markSyncProbeOutstanding(false)
      logError(error)
    } finally {
      finishWidthProbe?.()
    }
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
      if (!m.swallowRelease) props.handleSelectionDrag(col, row)
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
    m.swallowRelease = false
    if (clickOutsideElevatedSurface(col, row)) {
      if (m.pendingHyperlinkTimer) {
        stopTimeout(m.pendingHyperlinkTimer)
        m.pendingHyperlinkTimer = null
      }
      m.swallowRelease = true
      m.clickCount = 0
      dismissByOutsidePress(() => app.pressEscape())
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
        stopTimeout(m.pendingHyperlinkTimer)
        m.pendingHyperlinkTimer = null
      }
      const count: 2 | 3 = m.clickCount >= 3 ? 3 : 2
      m.clickCount = Math.min(m.clickCount, 3)
      props.handleMultiClick(col, row, count)
      return
    }
    const pressHadAlt = (atom.button & ALT_MODIFIER_BIT) !== 0
    if (props.handleSelectionStart) {
      props.handleSelectionStart(col, row, pressHadAlt)
    } else {
      startSelection(selection, col, row)
      selection.lastPressHadAlt = pressHadAlt
      props.notifySelectionChange()
    }
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
  if (props.handleSelectionRelease?.(col, row)) return

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
      const embeddedWebTerminal = hostEnv().TERM_PROGRAM === 'vscode' || isXtermJs()
      if (url && !embeddedWebTerminal) {
        if (m.pendingHyperlinkTimer) stopTimeout(m.pendingHyperlinkTimer)
        m.pendingHyperlinkTimer = startTimeout(() => {
          m.pendingHyperlinkTimer = null
          props.openHyperlink(url)
        }, MULTI_CLICK_WINDOW_MS)
      }
    }
  }
  props.notifySelectionChange()
}
