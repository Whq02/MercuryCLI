import autoBind from 'auto-bind'
import type { ReactNode } from 'react'
import { ConcurrentRoot } from 'react-reconciler/constants.js'
import { onExit } from 'signal-exit'
import { logForDebugging } from '../utils/debug.js'
import { isMouseCaptureEnabled } from '../utils/config/derived.js'
import { isMouseTrackingEnabled as mouseTrackingEnabledByEnvironment } from '../utils/fullscreen.js'
import { setStdinRecovery } from '../utils/process.js'
import { consoleSizeNeedsPolling } from '../utils/platform/terminal.js'
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
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export { drainStdin }

export type Options = Unbuilt

export default class Ink {
  readonly options: Options
  readonly isTTY: boolean
  readonly stylePool: Unbuilt = unbuilt('src/ink/ink.tsx:68')
  charPool: Unbuilt = unbuilt('src/ink/ink.tsx:69')
  hyperlinkPool: Unbuilt = unbuilt('src/ink/ink.tsx:70')
  frontFrame: Frame
  backFrame: Frame
  cachedColumns: number
  cachedRows: number
  parkPatch: Patch
  pendingAltEntry: string | null = unbuilt('src/ink/ink.tsx:76')
  lastPoolReset: Unbuilt = unbuilt('src/ink/ink.tsx:77')
  readonly rootNode: DOMElement
  readonly renderer: Renderer
  readonly container: unknown
  readonly writer: FrameWriter
  readonly scheduler: RenderScheduler
  readonly ledger: Unbuilt = unbuilt('src/ink/ink.tsx:83')
  lastAssignedWidth: number | null = unbuilt('src/ink/ink.tsx:84')
  lastAssignedMaxHeight: number | null = unbuilt('src/ink/ink.tsx:85')
  layoutCounters: Unbuilt = unbuilt('src/ink/ink.tsx:86')
  currentTree: ReactNode | null = unbuilt('src/ink/ink.tsx:87')
  isUnmounted: boolean = unbuilt('src/ink/ink.tsx:88')
  isPaused: boolean = unbuilt('src/ink/ink.tsx:89')
  isRendering: boolean = unbuilt('src/ink/ink.tsx:90')
  lastRenderTime: number | null = unbuilt('src/ink/ink.tsx:91')
  restoreConsole: (() => void) | null = unbuilt('src/ink/ink.tsx:92')
  removeTtySubscriptions: (() => void) | null = unbuilt('src/ink/ink.tsx:93')
  exitPromise: Promise<void> | null = unbuilt('src/ink/ink.tsx:94')
  exitOutcomeLatch: ExitOutcome | null = unbuilt('src/ink/ink.tsx:95')
  editorHandoverDepth: number = unbuilt('src/ink/ink.tsx:96');
  altScreenActive: boolean = unbuilt('src/ink/ink.tsx:97')
  mouseTracking: boolean
  mouseTrackingPref: boolean
  wheelReportingConfirmed: boolean = unbuilt('src/ink/ink.tsx:100')
  transcriptScrollTarget: (() => boolean) | null = unbuilt('src/ink/ink.tsx:101')
  readonly arrowKeyOwners: Set<() => boolean> = unbuilt('src/ink/ink.tsx:102')
  displayCursor: CursorPoint | null = unbuilt('src/ink/ink.tsx:103')
  wholeFrameDue: boolean = unbuilt('src/ink/ink.tsx:104')
  resizeEraseDue: boolean = unbuilt('src/ink/ink.tsx:105')
  wholeFrameAt: Unbuilt = unbuilt('src/ink/ink.tsx:106')
  overwriteTimer: ReturnType<typeof setTimeout> | null = unbuilt('src/ink/ink.tsx:107')
  resizeSettleTimer: ReturnType<typeof setTimeout> | null = unbuilt('src/ink/ink.tsx:108')
  watchdogCommitsRemaining: number = unbuilt('src/ink/ink.tsx:109')
  zeroByteRenderStreak: number = unbuilt('src/ink/ink.tsx:110')
  readonly selection: SelectionState = unbuilt('src/ink/ink.tsx:111')
  textGesture: { handler: TextGestureHandler; rect: CachedLayout } | null = unbuilt('src/ink/ink.tsx:112')
  readonly selectionListeners: Set<() => void> = unbuilt('src/ink/ink.tsx:113')
  glassOverlay: OverlayRecord | null = unbuilt('src/ink/ink.tsx:114')
  searchQuery: string = unbuilt('src/ink/ink.tsx:115')
  searchPositions: SearchPositions | null = unbuilt('src/ink/ink.tsx:116')
  readonly hoveredNodes: Set<DOMElement> = unbuilt('src/ink/ink.tsx:117')
  cursorDeclaration: CursorDeclaration | null = unbuilt('src/ink/ink.tsx:118')
  readonly frameListeners: Set<() => void> = unbuilt('src/ink/ink.tsx:119')
  readonly layoutListeners: Set<() => void> = unbuilt('src/ink/ink.tsx:120')
  onHyperlinkClick: ((url: string) => void) | undefined
  storedReadableListeners: Array<(...args: unknown[]) => void> | null = unbuilt('src/ink/ink.tsx:122')
  wasRawMode: boolean = unbuilt('src/ink/ink.tsx:123')
  consoleReadHeld: boolean = unbuilt('src/ink/ink.tsx:124')
  fittingConsoleBuffer: boolean = unbuilt('src/ink/ink.tsx:125')
  stdinRecoveryArmed: boolean = unbuilt('src/ink/ink.tsx:126')
  rawModeOffForStop: boolean = unbuilt('src/ink/ink.tsx:127')
  stopListenersAttached: boolean = unbuilt('src/ink/ink.tsx:128')
  treeDumpBudget: Unbuilt = unbuilt('src/ink/ink.tsx:129')
  readonly focusManager: FocusManager
  screenReassertCount: number = unbuilt('src/ink/ink.tsx:131')
  exitOutcome: ExitOutcome | null = unbuilt('src/ink/ink.tsx:132')
  unsubscribeExit: () => void
  resolveExitPromise: () => void = () => notBuilt('src/ink/ink.tsx:134')
  rejectExitPromise: (reason?: Error) => void = () => notBuilt('src/ink/ink.tsx:135')

  constructor(options: Options) {
    notBuilt('src/ink/ink.tsx:137')
  }

  resetLineCount(): void {
    return notBuilt('src/ink/ink.tsx:216')
  }
  resetPools(): void {
    return notBuilt('src/ink/ink.tsx:217')
  }
  handleResize = (): void => notBuilt('src/ink/ink.tsx:218')
  private handleWinch = (): void => notBuilt('src/ink/ink.tsx:219')
  applySettledResize = (): void => notBuilt('src/ink/ink.tsx:220')
  reconcileSize(): void {
    return notBuilt('src/ink/ink.tsx:221')
  }
  calculateLayout = (): void => notBuilt('src/ink/ink.tsx:222')
  private layoutAfterCommit = (): void => notBuilt('src/ink/ink.tsx:223')
  subscribeLayout(listener: () => void): () => void {
    return notBuilt('src/ink/ink.tsx:224')
  }
  scheduleRender = (): void => notBuilt('src/ink/ink.tsx:225')
  renderFaultStreak: number = unbuilt('src/ink/ink.tsx:226')
  firstFrameStamped: boolean = unbuilt('src/ink/ink.tsx:227')
  onRender = (): void => notBuilt('src/ink/ink.tsx:228')
  stampFirstFrame(): void {
    return notBuilt('src/ink/ink.tsx:229')
  }
  subscribeFrame(listener: () => void): () => void {
    return notBuilt('src/ink/ink.tsx:238')
  }
  get isAltScreenActive(): boolean {
    return notBuilt('src/ink/ink.tsx:239')
  }
  setAltScreenActive(active: boolean, mouseTracking?: boolean): void {
    return notBuilt('src/ink/ink.tsx:240')
  }
  isMouseTrackingEnabled(): boolean {
    return notBuilt('src/ink/ink.tsx:244')
  }
  confirmWheelReporting(): void {
    return notBuilt('src/ink/ink.tsx:245')
  }
  isWheelReportingConfirmed(): boolean {
    return notBuilt('src/ink/ink.tsx:246')
  }
  registerTranscriptScrollTarget(target: () => boolean): () => void {
    return notBuilt('src/ink/ink.tsx:247')
  }
  hasScrollableTranscriptTarget(): boolean {
    return notBuilt('src/ink/ink.tsx:248')
  }
  registerArrowKeyOwner(owns: () => boolean): () => void {
    return notBuilt('src/ink/ink.tsx:249')
  }
  arrowKeysOwned(): boolean {
    return notBuilt('src/ink/ink.tsx:250')
  }
  isMouseTrackingPreferred(): boolean {
    return notBuilt('src/ink/ink.tsx:251')
  }
  setMouseTrackingEnabled(on: boolean): void {
    return notBuilt('src/ink/ink.tsx:252')
  }
  awaitTerminalQueries(): Promise<void> {
    return notBuilt('src/ink/ink.tsx:253')
  }
  enterAlternateScreen(): void {
    return notBuilt('src/ink/ink.tsx:254')
  }
  exitAlternateScreen(): void {
    return notBuilt('src/ink/ink.tsx:255')
  }
  reassertScreenState(reason: string, opts?: { repaint?: boolean }): void {
    return notBuilt('src/ink/ink.tsx:256')
  }
  armScreenWatchdog(): void {
    return notBuilt('src/ink/ink.tsx:257')
  }
  stopForSignal = (signal: NodeJS.Signals): void => notBuilt('src/ink/ink.tsx:258')
  private resumeAfterContinue = (): void => notBuilt('src/ink/ink.tsx:259')
  reassertTerminalModes(includeAltScreen?: boolean): void {
    return notBuilt('src/ink/ink.tsx:260')
  }
  repaintAfterNestedAltScreenClose(): void {
    return notBuilt('src/ink/ink.tsx:261')
  }
  armAltScreenTakeover(): void {
    return notBuilt('src/ink/ink.tsx:262')
  }
  armAltScreenEntry(bytes: string): void {
    return notBuilt('src/ink/ink.tsx:263')
  }
  isAltEntryPending(): boolean {
    return notBuilt('src/ink/ink.tsx:264')
  }
  forceRedraw(): void {
    return notBuilt('src/ink/ink.tsx:265')
  }
  repaintAltScreen(): void {
    return notBuilt('src/ink/ink.tsx:266')
  }
  overwriteScreen(): void {
    return notBuilt('src/ink/ink.tsx:267')
  }
  invalidatePrevFrame(): void {
    return notBuilt('src/ink/ink.tsx:268')
  }
  repaint(): void {
    return notBuilt('src/ink/ink.tsx:269')
  }
  pause(): void {
    return notBuilt('src/ink/ink.tsx:270')
  }
  resume(): void {
    return notBuilt('src/ink/ink.tsx:274')
  }
  notifySelectionChange = (): void => notBuilt('src/ink/ink.tsx:275')
  subscribeToSelectionChange(callback: () => void): () => void {
    return notBuilt('src/ink/ink.tsx:276')
  }
  hasTextSelection(): boolean {
    return notBuilt('src/ink/ink.tsx:277')
  }
  handleSelectionStart(col: number, row: number, pressHadAlt?: boolean): void {
    return notBuilt('src/ink/ink.tsx:278')
  }
  handleMultiClick(col: number, row: number, count: 2 | 3): void {
    return notBuilt('src/ink/ink.tsx:279')
  }
  handleSelectionDrag(col: number, row: number): void {
    return notBuilt('src/ink/ink.tsx:280')
  }
  handleSelectionRelease(col: number, row: number): boolean {
    return notBuilt('src/ink/ink.tsx:281')
  }
  moveSelectionFocus(move: FocusMove): void {
    return notBuilt('src/ink/ink.tsx:282')
  }
  copySelectionNoClear(): string {
    return notBuilt('src/ink/ink.tsx:283')
  }
  copySelection(): string {
    return notBuilt('src/ink/ink.tsx:284')
  }
  copyText(text: string): void {
    return notBuilt('src/ink/ink.tsx:285')
  }
  clearTextSelection(): void {
    return notBuilt('src/ink/ink.tsx:286')
  }
  setSelectionBgColor(color: string): void {
    return notBuilt('src/ink/ink.tsx:287')
  }
  setSearchHighlight(query: string): void {
    return notBuilt('src/ink/ink.tsx:288')
  }
  setSearchPositions(state: SearchPositions | null): void {
    return notBuilt('src/ink/ink.tsx:289')
  }
  scanElementSubtree(el: DOMElement): MatchPosition[] {
    return notBuilt('src/ink/ink.tsx:290')
  }
  getHyperlinkAt(col: number, row: number): string | undefined {
    return notBuilt('src/ink/ink.tsx:291')
  }
  openHyperlink = (url: string): void => notBuilt('src/ink/ink.tsx:292')
  dispatchClick(col: number, row: number): boolean {
    return notBuilt('src/ink/ink.tsx:293')
  }
  dispatchHover(col: number, row: number): void {
    return notBuilt('src/ink/ink.tsx:294')
  }
  dispatchKeyboardEvent(parsedKey: ParsedKey): void {
    return notBuilt('src/ink/ink.tsx:295')
  }
  private setCursorDeclaration = (declaration: CursorDeclaration | null, clearIfNode?: DOMElement | null): void => notBuilt('src/ink/ink.tsx:296')
  drainStdin(): void {
    return notBuilt('src/ink/ink.tsx:297')
  }
  suspendStdin(): void {
    return notBuilt('src/ink/ink.tsx:298')
  }
  resumeStdin(): void {
    return notBuilt('src/ink/ink.tsx:299')
  }
  recoverStdin = (code: string, syscall: string): void => notBuilt('src/ink/ink.tsx:300')
  patchConsole(): () => void {
    return notBuilt('src/ink/ink.tsx:301')
  }
  private writeRaw = (data: string): void => notBuilt('src/ink/ink.tsx:302')

  render(node: ReactNode): void {
    return notBuilt('src/ink/ink.tsx:304')
  }

  private onStdinResume = (): void => notBuilt('src/ink/ink.tsx:339')
  unmount = (error?: Error | number | null): void => notBuilt('src/ink/ink.tsx:340')
  lastFrameText(): string {
    return notBuilt('src/ink/ink.tsx:344')
  }
  waitUntilExit(): Promise<void> {
    return notBuilt('src/ink/ink.tsx:345')
  }
  detachForShutdown(): void {
    return notBuilt('src/ink/ink.tsx:346')
  }
}
