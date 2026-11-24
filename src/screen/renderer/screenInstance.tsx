import autoBind from 'auto-bind'
import type { ReactNode } from 'react'
import { ConcurrentRoot } from 'react-reconciler/constants.js'
import { onExit } from 'signal-exit'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isMouseCaptureEnabled } from '../../platform/config/derived.js'
import { isMouseTrackingEnabled as mouseTrackingEnabledByEnvironment } from '../fullscreen-layout/fullscreen.js'
import { setStdinRecovery } from '../../platform/processes/process.js'
import { consoleSizeNeedsPolling } from '../../platform/host-os/terminal.js'
import { CharPool, HyperlinkPool, StylePool } from './cell-grid.js'
import App from './elements/App.js'
import type { CursorDeclaration } from './elements/CursorDeclarationContext.js'
import { ScreenInstanceContext } from './elements/ScreenInstanceContext.js'
import { createNode, type DOMElement } from './dom.js'
import type { TextGestureHandler } from './events/text-gesture.js'
import { FocusManager } from './focus.js'
import type { Frame, FrameEvent, Patch } from './frame.js'
import { FrameWriter } from './frame-writer.js'
import type { OverlayRecord } from './geometry/selectionOverlay.js'
import { createSelectionState, hasSelection, type FocusMove, type SelectionState } from './geometry/selection.js'
import type { ParsedKey } from './input/input-decoder.js'
import { getCellLayoutCounters } from './layout/cellLayout.js'
import type { CachedLayout } from './node-cache.js'
import reconciler, { dispatcher } from './reconciler.js'
import type { MatchPosition } from './matchPositions.js'
import createRenderer, { type Renderer } from './renderer.js'
import type { CursorPoint } from './root/cursor-park.js'
import { FrameLedger } from './root/frame-ledger.js'
import type { SearchPositions } from './root/overlay-pass.js'
import { RenderScheduler } from './root/render-scheduler.js'
import { termWrite } from './terminalOut.js'
import { shouldHoldFirstPaintForSyncProbe } from './terminal-session/capabilities.js'
import { TerminalWriteProvider } from './terminalWrite.js'
import { TREE_DUMP_PATH, TREE_DUMP_BUDGET } from './instance/tees.js'
import { DEFAULT_COLUMNS, DEFAULT_ROWS, buildParkPatch, newEmptyFrame, resetLineCount, resetPools } from './instance/frames.js'
import { handleResize, handleWinch, applySettledResize, reconcileSize } from './instance/resize.js'
import { calculateLayout, layoutAfterCommit, subscribeLayout } from './instance/layout.js'
import { onRender, subscribeFrame, setCursorDeclaration } from './instance/frame-loop.js'
export { RENDER_FAULT_RETRY_BUDGET, renderFaultRecoveryPlan } from './instance/frame-loop.js'
import { setAltScreenActive, registerTranscriptScrollTarget, registerArrowKeyOwner, arrowKeysOwned, setMouseTrackingEnabled, awaitTerminalQueries, enterAlternateScreen, exitAlternateScreen, reassertScreenState, armScreenWatchdog, reassertTerminalModes, repaintAfterNestedAltScreenClose, armAltScreenTakeover, armAltScreenEntry, forceRedraw, repaintAltScreen, overwriteScreen, repaint, pause, resume } from './instance/alt-screen.js'
import { attachStopListeners, detachStopListeners, stopForSignal, resumeAfterContinue } from './instance/stop-continue.js'
import { notifySelectionChange, subscribeToSelectionChange, handleSelectionStart, handleMultiClick, handleSelectionDrag, handleSelectionRelease, moveSelectionFocus, copySelectionNoClear, copySelection, copyText, clearTextSelection, setSelectionBgColor } from './instance/selection.js'
import { setSearchHighlight, setSearchPositions, scanElementSubtree } from './instance/search.js'
import { getHyperlinkAt, dispatchClick, dispatchHover, dispatchKeyboardEvent } from './instance/pointer.js'
import { drainStdin, suspendStdin, resumeStdin, recoverStdin } from './instance/stdin.js'
import { patchConsole } from './instance/console-patch.js'
import { unmount, waitUntilExit, detachForShutdown } from './instance/exit.js'
import type { ExitOutcome } from './instance/record.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { startInterval, stopInterval } from '../../platform/async/timers.js'

export { drainStdin }

export type Options = {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
  exitOnCtrlC: boolean
  patchConsole: boolean
  waitUntilExit?: () => Promise<void>
  onFrame?: (event: FrameEvent) => void
}

export default class ScreenInstance {
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
  isUnmounted: boolean = false
  isPaused: boolean = false
  isRendering: boolean = false
  lastRenderTime: number | null = null
  restoreConsole: (() => void) | null = null
  removeTtySubscriptions: (() => void) | null = null
  exitPromise: Promise<void> | null = null
  exitOutcomeLatch: ExitOutcome | null = null
  editorHandoverDepth: number = 0
  altScreenActive: boolean = false
  mouseTracking: boolean
  mouseTrackingPref: boolean
  wheelReportingConfirmed: boolean = false
  transcriptScrollTarget: (() => boolean) | null = null
  readonly arrowKeyOwners: Set<() => boolean> = new Set()
  displayCursor: CursorPoint | null = null
  wholeFrameDue: boolean = false
  resizeEraseDue: boolean = false
  wholeFrameAt = Number.NEGATIVE_INFINITY
  overwriteTimer: ReturnType<typeof setTimeout> | null = null
  resizeSettleTimer: ReturnType<typeof setTimeout> | null = null
  watchdogCommitsRemaining: number = 0
  zeroByteRenderStreak: number = 0
  readonly selection: SelectionState = createSelectionState()
  textGesture: { handler: TextGestureHandler; rect: CachedLayout } | null = null
  readonly selectionListeners: Set<() => void> = new Set()
  glassOverlay: OverlayRecord | null = null
  searchQuery: string = ''
  searchPositions: SearchPositions | null = null
  readonly hoveredNodes: Set<DOMElement> = new Set()
  cursorDeclaration: CursorDeclaration | null = null
  readonly frameListeners: Set<() => void> = new Set()
  readonly layoutListeners: Set<() => void> = new Set()
  onHyperlinkClick: ((url: string) => void) | undefined
  storedReadableListeners: Array<(...args: unknown[]) => void> | null = null
  wasRawMode: boolean = false
  consoleReadHeld: boolean = false
  fittingConsoleBuffer: boolean = false
  stdinRecoveryArmed: boolean = false
  rawModeOffForStop: boolean = false
  stopListenersAttached: boolean = false
  treeDumpBudget = TREE_DUMP_PATH ? TREE_DUMP_BUDGET : 0
  readonly focusManager: FocusManager
  screenReassertCount: number = 0
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
    this.scheduler = new RenderScheduler(this.onRender, undefined, shouldHoldFirstPaintForSyncProbe)
    this.unsubscribeExit = onExit(this.unmount)
    if (this.isTTY) {
      options.stdout.on('resize', this.handleResize)
      process.on('SIGWINCH', this.handleWinch)
      process.on('SIGCONT', this.resumeAfterContinue)
      attachStopListeners.call(this)
      const sizePoll = consoleSizeNeedsPolling() ? startInterval(this.reconcileSize, 5_000) : null
      sizePoll?.unref?.()
      if (options.stdin.isTTY) setStdinRecovery(this.recoverStdin)
      this.removeTtySubscriptions = () => {
        options.stdout.off('resize', this.handleResize)
        process.off('SIGWINCH', this.handleWinch)
        process.off('SIGCONT', this.resumeAfterContinue)
        detachStopListeners.call(this)
        if (sizePoll) stopInterval(sizePoll)
        setStdinRecovery(null)
      }
    }
    this.rootNode = createNode('ink-root')
    this.focusManager = new FocusManager((target, event) => dispatcher.dispatchDiscrete(target, event))
    this.rootNode.focusManager = this.focusManager
    this.renderer = createRenderer(this.rootNode, this.stylePool)
    this.rootNode.onRender = this.scheduleRender
    this.rootNode.onImmediateRender = this.onRender
    this.rootNode.onComputeLayout = this.layoutAfterCommit
    const tell =
      (prefix: string) =>
      (error: Error): void => {
        logForDebugging(`${prefix}${error.stack ?? error.message}`, { level: 'warn' })
      }
    this.container = reconciler.createContainer(
      this.rootNode,
      ConcurrentRoot,
      null,
      false,
      null,
      '',
      tell('Uncaught render error: '),
      tell('Caught render error: '),
      tell('Recoverable render error: '),
      () => {},
    )
  }

  resetLineCount(): void { return resetLineCount.call(this) }
  resetPools(): void { return resetPools.call(this) }
  handleResize = (): void => handleResize.call(this)
  private handleWinch = (): void => handleWinch.call(this)
  applySettledResize = (): void => applySettledResize.call(this)
  reconcileSize(): void { return reconcileSize.call(this) }
  calculateLayout = (): void => calculateLayout.call(this)
  private layoutAfterCommit = (): void => layoutAfterCommit.call(this)
  subscribeLayout(listener: () => void): () => void { return subscribeLayout.call(this, listener) }
  scheduleRender = (): void => this.scheduler.requestFrame()
  renderFaultStreak: number = 0
  firstFrameStamped: boolean = false
  onRender = (): void => onRender.call(this)
  stampFirstFrame(): void {
    this.firstFrameStamped = true
    void import('../../platform/substrate/launchMilestones.js')
      .then(loaded => {
        loaded.recordLaunchMilestone('first-frame')
      })
      .catch(passedOver)
  }
  subscribeFrame(listener: () => void): () => void { return subscribeFrame.call(this, listener) }
  get isAltScreenActive(): boolean { return this.altScreenActive }
  setAltScreenActive(active: boolean, mouseTracking = true): void {
    if (!active) this.resizeEraseDue = false
    setAltScreenActive.call(this, active, mouseTracking)
  }
  isMouseTrackingEnabled(): boolean { return this.mouseTracking }
  confirmWheelReporting(): void { if (this.altScreenActive && this.mouseTracking) this.wheelReportingConfirmed = true }
  isWheelReportingConfirmed(): boolean { return this.wheelReportingConfirmed }
  registerTranscriptScrollTarget(target: () => boolean): () => void { return registerTranscriptScrollTarget.call(this, target) }
  hasScrollableTranscriptTarget(): boolean { return this.transcriptScrollTarget?.() === true }
  registerArrowKeyOwner(owns: () => boolean): () => void { return registerArrowKeyOwner.call(this, owns) }
  arrowKeysOwned(): boolean { return arrowKeysOwned.call(this) }
  isMouseTrackingPreferred(): boolean { return this.mouseTrackingPref }
  setMouseTrackingEnabled(on: boolean): void { return setMouseTrackingEnabled.call(this, on) }
  awaitTerminalQueries(): Promise<void> { return awaitTerminalQueries.call(this) }
  enterAlternateScreen(): void { return enterAlternateScreen.call(this) }
  exitAlternateScreen(): void { return exitAlternateScreen.call(this) }
  reassertScreenState(reason: string, opts: { repaint?: boolean } = {}): void { return reassertScreenState.call(this, reason, opts) }
  armScreenWatchdog(): void { return armScreenWatchdog.call(this) }
  stopForSignal = (signal: NodeJS.Signals): void => stopForSignal.call(this, signal)
  private resumeAfterContinue = (): void => resumeAfterContinue.call(this)
  reassertTerminalModes(includeAltScreen = false): void { return reassertTerminalModes.call(this, includeAltScreen) }
  repaintAfterNestedAltScreenClose(): void { return repaintAfterNestedAltScreenClose.call(this) }
  armAltScreenTakeover(): void { return armAltScreenTakeover.call(this) }
  armAltScreenEntry(bytes: string): void { return armAltScreenEntry.call(this, bytes) }
  isAltEntryPending(): boolean { return this.pendingAltEntry !== null }
  forceRedraw(): void { return forceRedraw.call(this) }
  repaintAltScreen(): void { return repaintAltScreen.call(this) }
  overwriteScreen(): void { return overwriteScreen.call(this) }
  invalidatePrevFrame(): void { return this.ledger.contaminate('overlay-unmount') }
  repaint(): void { return repaint.call(this) }
  pause(): void {
    this.resizeEraseDue = false
    pause.call(this)
  }
  resume(): void { return resume.call(this) }
  notifySelectionChange = (): void => notifySelectionChange.call(this)
  subscribeToSelectionChange(callback: () => void): () => void { return subscribeToSelectionChange.call(this, callback) }
  hasTextSelection(): boolean { return hasSelection(this.selection) }
  handleSelectionStart(col: number, row: number, pressHadAlt = false): void { return handleSelectionStart.call(this, col, row, pressHadAlt) }
  handleMultiClick(col: number, row: number, count: 2 | 3): void { return handleMultiClick.call(this, col, row, count) }
  handleSelectionDrag(col: number, row: number): void { return handleSelectionDrag.call(this, col, row) }
  handleSelectionRelease(col: number, row: number): boolean { return handleSelectionRelease.call(this, col, row) }
  moveSelectionFocus(move: FocusMove): void { return moveSelectionFocus.call(this, move) }
  copySelectionNoClear(): string { return copySelectionNoClear.call(this) }
  copySelection(): string { return copySelection.call(this) }
  copyText(text: string): void { return copyText.call(this, text) }
  clearTextSelection(): void { return clearTextSelection.call(this) }
  setSelectionBgColor(color: string): void { return setSelectionBgColor.call(this, color) }
  setSearchHighlight(query: string): void { return setSearchHighlight.call(this, query) }
  setSearchPositions(state: SearchPositions | null): void { return setSearchPositions.call(this, state) }
  scanElementSubtree(el: DOMElement): MatchPosition[] { return scanElementSubtree.call(this, el) }
  getHyperlinkAt(col: number, row: number): string | undefined { return getHyperlinkAt.call(this, col, row) }
  openHyperlink = (url: string): void => this.onHyperlinkClick?.(url)
  dispatchClick(col: number, row: number): boolean { return dispatchClick.call(this, col, row) }
  dispatchHover(col: number, row: number): void { return dispatchHover.call(this, col, row) }
  dispatchKeyboardEvent(parsedKey: ParsedKey): void { return dispatchKeyboardEvent.call(this, parsedKey) }
  private setCursorDeclaration = (declaration: CursorDeclaration | null, clearIfNode?: DOMElement | null): void => setCursorDeclaration.call(this, declaration, clearIfNode)
  drainStdin(): void { return drainStdin(this.options.stdin) }
  suspendStdin(): void { return suspendStdin.call(this) }
  resumeStdin(): void { return resumeStdin.call(this) }
  recoverStdin = (code: string, syscall: string): void => recoverStdin.call(this, code, syscall)
  patchConsole(): () => void { return patchConsole.call(this) }
  private writeRaw = (data: string): void => termWrite(this.options.stdout, data)

  render(node: ReactNode): void {
    this.currentTree = node
    const tree = (
      <ScreenInstanceContext.Provider value={this}>
        <App
          stdin={this.options.stdin}
          stdout={this.options.stdout}
          stderr={this.options.stderr}
          exitOnCtrlC={this.options.exitOnCtrlC}
          columns={this.cachedColumns}
          rows={this.cachedRows}
          onExit={this.unmount}
          selection={this.selection}
          notifySelectionChange={this.notifySelectionChange}
          dispatchClick={this.dispatchClick}
          dispatchHover={this.dispatchHover}
          dispatchKeyboardEvent={this.dispatchKeyboardEvent}
          getHyperlinkAt={this.getHyperlinkAt}
          openHyperlink={this.openHyperlink}
          handleMultiClick={this.handleMultiClick}
          handleSelectionStart={this.handleSelectionStart}
          handleSelectionDrag={this.handleSelectionDrag}
          handleSelectionRelease={this.handleSelectionRelease}
          setCursorDeclaration={this.setCursorDeclaration}
          onStdinResume={this.onStdinResume}
        >
          <TerminalWriteProvider value={this.isTTY ? this.writeRaw : null}>{node}</TerminalWriteProvider>
        </App>
      </ScreenInstanceContext.Provider>
    )
    reconciler.updateContainerSync(tree, this.container, null, null)
    reconciler.flushSyncWork()
  }

  private onStdinResume = (): void => this.reassertTerminalModes(false)
  unmount = (error?: Error | number | null): void => {
    this.resizeEraseDue = false
    unmount.call(this, error)
  }
  lastFrameText(): string { return this.writer.fullFrameText(this.frontFrame) }
  waitUntilExit(): Promise<void> { return waitUntilExit.call(this) }
  detachForShutdown(): void {
    this.resizeEraseDue = false
    detachForShutdown.call(this)
  }
}
