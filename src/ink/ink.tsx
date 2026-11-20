
import autoBind from 'auto-bind'
import type { ReactNode } from 'react'
import { ConcurrentRoot } from 'react-reconciler/constants.js'
import { onExit } from 'signal-exit'
import { logForDebugging } from '../utils/debug.js'
import { isMouseCaptureEnabled } from '../utils/config/derived.js'
import { isMouseTrackingEnabled as mouseTrackingEnabledByEnvironment } from '../utils/fullscreen.js'
import { setStdinRecovery } from '../utils/process.js'
import { CharPool, HyperlinkPool, StylePool } from './cell-grid.js'
import App from './components/App.js'
import type { CursorDeclaration } from './components/CursorDeclarationContext.js'
import { InkInstanceContext } from './components/InkInstanceContext.js'
import { createNode, type DOMElement } from './dom.js'
import type { TextGestureHandler } from './events/text-gesture.js'
import { FocusManager } from './focus.js'
import type { Frame, FrameEvent, Patch } from './frame.js'
import { FrameWriter } from './frame-writer.js'
import type { OverlayRecord } from './geometry/overlay.js'
import { createSelectionState, hasSelection, type FocusMove, type SelectionState } from './geometry/selection.js'
import type { ParsedKey } from './input/input-decoder.js'
import { getCellLayoutCounters } from './layout/cellLayout.js'
import type { CachedLayout } from './node-cache.js'
import reconciler, { dispatcher } from './reconciler.js'
import type { MatchPosition } from './render-to-screen.js'
import createRenderer, { type Renderer } from './renderer.js'
import type { CursorPoint } from './root/cursor-park.js'
import { FrameLedger } from './root/frame-ledger.js'
import type { SearchPositions } from './root/overlay-pass.js'
import { RenderScheduler } from './root/render-scheduler.js'
import { termWrite } from './terminalOut.js'
import { shouldHoldFirstPaintForSyncProbe } from './session/capabilities.js'
import { TerminalWriteProvider } from './terminalWrite.js'
import { TREE_DUMP_PATH, TREE_DUMP_BUDGET } from './ink/tees.js'
import { DEFAULT_COLUMNS, DEFAULT_ROWS, buildParkPatch, newEmptyFrame, resetLineCount, resetPools } from './ink/frames.js'
import { handleResize, handleWinch, applySettledResize, reconcileSize } from './ink/resize.js'
import { calculateLayout, layoutAfterCommit, subscribeLayout } from './ink/layout.js'
import { onRender, subscribeFrame, setCursorDeclaration } from './ink/frame-loop.js'
export { RENDER_FAULT_RETRY_BUDGET, renderFaultRecoveryPlan } from './ink/frame-loop.js'
import { setAltScreenActive, registerTranscriptScrollTarget, registerArrowKeyOwner, arrowKeysOwned, setMouseTrackingEnabled, awaitTerminalQueries, enterAlternateScreen, exitAlternateScreen, reassertScreenState, armScreenWatchdog, reassertTerminalModes, repaintAfterNestedAltScreenClose, armAltScreenTakeover, armAltScreenEntry, forceRedraw, repaintAltScreen, overwriteScreen, repaint, pause, resume } from './ink/alt-screen.js'
import { attachStopListeners, detachStopListeners, stopForSignal, resumeAfterContinue } from './ink/stop-continue.js'
import { notifySelectionChange, subscribeToSelectionChange, handleSelectionStart, handleMultiClick, handleSelectionDrag, handleSelectionRelease, moveSelectionFocus, copySelectionNoClear, copySelection, copyText, clearTextSelection, setSelectionBgColor } from './ink/selection.js'
import { setSearchHighlight, setSearchPositions, scanElementSubtree } from './ink/search.js'
import { getHyperlinkAt, dispatchClick, dispatchHover, dispatchKeyboardEvent } from './ink/pointer.js'
import { drainStdin, suspendStdin, resumeStdin, recoverStdin } from './ink/stdin.js'
import { patchConsole } from './ink/console-patch.js'
import { unmount, waitUntilExit, detachForShutdown } from './ink/exit.js'
import type { ExitOutcome } from './ink/record.js'
import { passedOver } from '../utils/passedOver.js'
import { startInterval, stopInterval } from '../utils/timers.js'

export { drainStdin }

export type Options = {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  exitOnCtrlC: boolean
  patchConsole: boolean
  waitUntilExit?: () => Promise<void>
  onFrame?: (event: FrameEvent) => void
}

export default class Ink {
  readonly options: Options
  readonly isTTY: boolean
  readonly stylePool = new StylePool()
  charPool = new CharPool()
  hyperlinkPool = new HyperlinkPool()
  frontFrame: Frame
  backFrame: Frame
  cachedColumns: number
  cachedRows: number
  parkPatch: Patch
  pendingAltEntry: string | null = null
  lastPoolReset = Date.now()
  readonly rootNode: DOMElement
  readonly renderer: Renderer
  readonly container: unknown
  readonly writer: FrameWriter
  readonly scheduler: RenderScheduler
  readonly ledger = new FrameLedger()
  lastAssignedWidth: number | null = null
  lastAssignedMaxHeight: number | null = null
  layoutCounters = getCellLayoutCounters()
  currentTree: ReactNode | null = null
  isUnmounted = false
  isPaused = false
  isRendering = false
  lastRenderTime: number | null = null
  restoreConsole: (() => void) | null = null
  removeTtySubscriptions: (() => void) | null = null
  exitPromise: Promise<void> | null = null
  exitOutcomeLatch: ExitOutcome | null = null
  editorHandoverDepth = 0;
  altScreenActive = false
  mouseTracking: boolean
  mouseTrackingPref: boolean
  wheelReportingConfirmed = false
  transcriptScrollTarget: (() => boolean) | null = null
  readonly arrowKeyOwners = new Set<() => boolean>()
  displayCursor: CursorPoint | null = null
  wholeFrameDue = false
  wholeFrameAt = -Infinity
  overwriteTimer: ReturnType<typeof setTimeout> | null = null
  resizeSettleTimer: ReturnType<typeof setTimeout> | null = null
  watchdogCommitsRemaining = 0
  zeroByteRenderStreak = 0
  readonly selection: SelectionState = createSelectionState()
  textGesture: { handler: TextGestureHandler; rect: CachedLayout } | null = null
  readonly selectionListeners = new Set<() => void>()
  glassOverlay: OverlayRecord | null = null
  searchQuery = ''
  searchPositions: SearchPositions | null = null
  readonly hoveredNodes = new Set<DOMElement>()
  cursorDeclaration: CursorDeclaration | null = null
  readonly frameListeners = new Set<() => void>()
  readonly layoutListeners = new Set<() => void>()
  onHyperlinkClick: ((url: string) => void) | undefined
  storedReadableListeners: Array<(...args: unknown[]) => void> | null = null
  wasRawMode = false
  consoleReadHeld = false
  fittingConsoleBuffer = false
  stdinRecoveryArmed = false
  rawModeOffForStop = false
  stopListenersAttached = false
  treeDumpBudget = TREE_DUMP_PATH ? TREE_DUMP_BUDGET : 0
  readonly focusManager: FocusManager
  screenReassertCount = 0
  exitOutcome: ExitOutcome | null = null
  unsubscribeExit: () => void
  resolveExitPromise: () => void = () => {}
  rejectExitPromise: (reason?: Error) => void = () => {}

  constructor(options: Options) {
    autoBind(this)
    this.options = options
    this.isTTY = options.stdout.isTTY === true
    if (options.patchConsole) this.restoreConsole = this.patchConsole()

    this.cachedColumns = options.stdout.columns || DEFAULT_COLUMNS
    this.cachedRows = options.stdout.rows || DEFAULT_ROWS
    this.parkPatch = buildParkPatch.call(this)
    this.frontFrame = newEmptyFrame.call(this)
    this.backFrame = newEmptyFrame.call(this)
    this.mouseTracking = mouseTrackingEnabledByEnvironment()
    this.mouseTrackingPref = this.mouseTracking && isMouseCaptureEnabled()

    this.writer = new FrameWriter({ isTTY: this.isTTY, stylePool: this.stylePool })
    this.scheduler = new RenderScheduler(
      this.onRender,
      undefined,
      shouldHoldFirstPaintForSyncProbe,
    )
    this.unsubscribeExit = onExit(this.unmount)

    if (this.isTTY) {
      options.stdout.on('resize', this.handleResize)
      process.on('SIGWINCH', this.handleWinch)
      process.on('SIGCONT', this.resumeAfterContinue)
      attachStopListeners.call(this)
      const win32SizeTimer: ReturnType<typeof setInterval> | null =
        process.platform === 'win32'
          ? startInterval(() => this.reconcileSize(), 5_000)
          : null
      win32SizeTimer?.unref?.();
      if (options.stdin.isTTY) setStdinRecovery(this.recoverStdin)
      this.removeTtySubscriptions = () => {
        options.stdout.off('resize', this.handleResize)
        process.off('SIGWINCH', this.handleWinch)
        process.off('SIGCONT', this.resumeAfterContinue)
        detachStopListeners.call(this)
        if (win32SizeTimer !== null) stopInterval(win32SizeTimer)
        setStdinRecovery(null)
      }
    }

    this.rootNode = createNode('ink-root')
    this.focusManager = new FocusManager((target, event) => {
      dispatcher.dispatchDiscrete(target, event)
    })
    this.rootNode.focusManager = this.focusManager
    this.renderer = createRenderer(this.rootNode, this.stylePool)
    this.rootNode.onRender = this.scheduleRender
    this.rootNode.onImmediateRender = this.onRender
    this.rootNode.onComputeLayout = this.layoutAfterCommit

    this.container = reconciler.createContainer(
      this.rootNode,
      ConcurrentRoot,
      null,
      false,
      null,
      '',
      (error: Error) => {
        logForDebugging(`Uncaught render error: ${error.stack ?? error.message}`, {
          level: 'warn',
        })
      },
      (error: Error) => {
        logForDebugging(`Caught render error: ${error.stack ?? error.message}`, {
          level: 'warn',
        })
      },
      (error: Error) => {
        logForDebugging(`Recoverable render error: ${error.stack ?? error.message}`, {
          level: 'warn',
        })
      },
      () => {},
    )
  }

  resetLineCount(): void { resetLineCount.call(this) }
  resetPools(): void { resetPools.call(this) }
  handleResize = (): void => handleResize.call(this)
  private handleWinch = (): void => handleWinch.call(this)
  applySettledResize = (): void => applySettledResize.call(this)
  reconcileSize(): void { reconcileSize.call(this) }
  calculateLayout = (): void => calculateLayout.call(this)
  private layoutAfterCommit = (): void => layoutAfterCommit.call(this)
  subscribeLayout(listener: () => void): () => void { return subscribeLayout.call(this, listener) }
  scheduleRender = (): void => { this.scheduler.requestFrame() }
  renderFaultStreak = 0
  firstFrameStamped = false
  onRender = (): void => onRender.call(this)
  stampFirstFrame(): void {
    this.firstFrameStamped = true
    try {
      const { recordLaunchMilestone } = require('../substrate/launchMilestones.js') as typeof import('../substrate/launchMilestones.js')
      recordLaunchMilestone('first-frame')
    } catch (error) {
      passedOver(error)
    }
  }
  subscribeFrame(listener: () => void): () => void { return subscribeFrame.call(this, listener) }
  get isAltScreenActive(): boolean { return this.altScreenActive }
  setAltScreenActive(active: boolean, mouseTracking = true): void { setAltScreenActive.call(this, active, mouseTracking) }
  isMouseTrackingEnabled(): boolean { return this.mouseTracking }
  confirmWheelReporting(): void { if (this.altScreenActive && this.mouseTracking) this.wheelReportingConfirmed = true }
  isWheelReportingConfirmed(): boolean { return this.wheelReportingConfirmed }
  registerTranscriptScrollTarget(target: () => boolean): () => void { return registerTranscriptScrollTarget.call(this, target) }
  hasScrollableTranscriptTarget(): boolean { return this.transcriptScrollTarget?.() === true }
  registerArrowKeyOwner(owns: () => boolean): () => void { return registerArrowKeyOwner.call(this, owns) }
  arrowKeysOwned(): boolean { return arrowKeysOwned.call(this) }
  isMouseTrackingPreferred(): boolean { return this.mouseTrackingPref }
  setMouseTrackingEnabled(on: boolean): void { setMouseTrackingEnabled.call(this, on) }
  awaitTerminalQueries(): Promise<void> { return awaitTerminalQueries.call(this) }
  enterAlternateScreen(): void { enterAlternateScreen.call(this) }
  exitAlternateScreen(): void { exitAlternateScreen.call(this) }
  reassertScreenState(reason: string, opts: { repaint?: boolean } = {}): void { reassertScreenState.call(this, reason, opts) }
  armScreenWatchdog(): void { armScreenWatchdog.call(this) }
  stopForSignal = (signal: NodeJS.Signals): void => stopForSignal.call(this, signal)
  private resumeAfterContinue = (): void => resumeAfterContinue.call(this)
  reassertTerminalModes(includeAltScreen = false): void { reassertTerminalModes.call(this, includeAltScreen) }
  repaintAfterNestedAltScreenClose(): void { repaintAfterNestedAltScreenClose.call(this) }
  armAltScreenTakeover(): void { armAltScreenTakeover.call(this) }
  armAltScreenEntry(bytes: string): void { armAltScreenEntry.call(this, bytes) }
  isAltEntryPending(): boolean { return this.pendingAltEntry !== null }
  forceRedraw(): void { forceRedraw.call(this) }
  repaintAltScreen(): void { repaintAltScreen.call(this) }
  overwriteScreen(): void { overwriteScreen.call(this) }
  invalidatePrevFrame(): void { this.ledger.contaminate('overlay-unmount') }
  repaint(): void { repaint.call(this) }
  pause(): void { pause.call(this) }
  resume(): void { resume.call(this) }
  notifySelectionChange = (): void => notifySelectionChange.call(this)
  subscribeToSelectionChange(callback: () => void): () => void { return subscribeToSelectionChange.call(this, callback) }
  hasTextSelection(): boolean { return hasSelection(this.selection) }
  handleSelectionStart(col: number, row: number, pressHadAlt = false): void { handleSelectionStart.call(this, col, row, pressHadAlt) }
  handleMultiClick(col: number, row: number, count: 2 | 3): void { handleMultiClick.call(this, col, row, count) }
  handleSelectionDrag(col: number, row: number): void { handleSelectionDrag.call(this, col, row) }
  handleSelectionRelease(col: number, row: number): boolean { return handleSelectionRelease.call(this, col, row) }
  moveSelectionFocus(move: FocusMove): void { moveSelectionFocus.call(this, move) }
  copySelectionNoClear(): string { return copySelectionNoClear.call(this) }
  copySelection(): string { return copySelection.call(this) }
  copyText(text: string): void { copyText.call(this, text) }
  clearTextSelection(): void { clearTextSelection.call(this) }
  setSelectionBgColor(color: string): void { setSelectionBgColor.call(this, color) }
  setSearchHighlight(query: string): void { setSearchHighlight.call(this, query) }
  setSearchPositions(state: SearchPositions | null): void { setSearchPositions.call(this, state) }
  scanElementSubtree(el: DOMElement): MatchPosition[] { return scanElementSubtree.call(this, el) }
  getHyperlinkAt(col: number, row: number): string | undefined { return getHyperlinkAt.call(this, col, row) }
  openHyperlink = (url: string): void => { this.onHyperlinkClick?.(url) }
  dispatchClick(col: number, row: number): boolean { return dispatchClick.call(this, col, row) }
  dispatchHover(col: number, row: number): void { dispatchHover.call(this, col, row) }
  dispatchKeyboardEvent(parsedKey: ParsedKey): void { dispatchKeyboardEvent.call(this, parsedKey) }
  private setCursorDeclaration = (declaration: CursorDeclaration | null, clearIfNode?: DOMElement | null): void => setCursorDeclaration.call(this, declaration, clearIfNode)
  drainStdin(): void { drainStdin(this.options.stdin) }
  suspendStdin(): void { suspendStdin.call(this) }
  resumeStdin(): void { resumeStdin.call(this) }
  recoverStdin = (code: string, syscall: string): void => recoverStdin.call(this, code, syscall)
  patchConsole(): () => void { return patchConsole.call(this) }
  private writeRaw = (data: string): void => { termWrite(this.options.stdout, data) }

  render(node: ReactNode): void {
    this.currentTree = node
    const tree = (
      <InkInstanceContext.Provider value={this}>
        <App
          stdin={this.options.stdin}
          stdout={this.options.stdout}
          stderr={this.options.stderr}
          exitOnCtrlC={this.options.exitOnCtrlC}
          onExit={this.unmount}
          columns={this.cachedColumns}
          rows={this.cachedRows}
          selection={this.selection}
          notifySelectionChange={this.notifySelectionChange}
          dispatchClick={this.dispatchClick.bind(this)}
          dispatchHover={this.dispatchHover.bind(this)}
          getHyperlinkAt={this.getHyperlinkAt.bind(this)}
          openHyperlink={this.openHyperlink}
          handleMultiClick={this.handleMultiClick.bind(this)}
          handleSelectionDrag={this.handleSelectionDrag.bind(this)}
          handleSelectionStart={this.handleSelectionStart.bind(this)}
          handleSelectionRelease={this.handleSelectionRelease.bind(this)}
          onStdinResume={this.onStdinResume}
          setCursorDeclaration={this.setCursorDeclaration}
          dispatchKeyboardEvent={this.dispatchKeyboardEvent.bind(this)}
        >
          {}
          <TerminalWriteProvider value={this.isTTY ? this.writeRaw : null}>{node}</TerminalWriteProvider>
        </App>
      </InkInstanceContext.Provider>
    )
    reconciler.updateContainerSync(tree, this.container, null, null)
    reconciler.flushSyncWork()
  }

  private onStdinResume = (): void => { this.reassertTerminalModes(false) }
  unmount = (error?: Error | number | null): void => unmount.call(this, error)
  lastFrameText(): string { return this.writer.fullFrameText(this.frontFrame) }
  waitUntilExit(): Promise<void> { return waitUntilExit.call(this) }
  detachForShutdown(): void { detachForShutdown.call(this) }
}
