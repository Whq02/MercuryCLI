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
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const MULTI_CLICK_WINDOW_MS = 500
const MULTI_CLICK_TOLERANCE_CELLS = 1
export const REFOCUS_CLICK_WINDOW_MS = 200
export { coalesceWheelRun }

const OSC_BACKGROUND_COLOR = 11

const RAW_MODE_LEDGER_OWNER = 'app-raw-mode'
const CURSOR_LEDGER_OWNER = 'app-cursor'
type Props = Unbuilt

type State = Unbuilt

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
    return notBuilt('src/ink/components/App.tsx:169')
  }

  override componentWillUnmount(): void {
    return notBuilt('src/ink/components/App.tsx:181')
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    persistCrashReport(error, errorInfo, 'app-root')
    this.handleExit(error)
  }

  override render(): ReactNode {
    return notBuilt('src/ink/components/App.tsx:203')
  }


  handleSetRawMode = (isEnabled: boolean): void => notBuilt('src/ink/components/App.tsx:243')

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
  return notBuilt('src/ink/components/App.tsx:404')
}
