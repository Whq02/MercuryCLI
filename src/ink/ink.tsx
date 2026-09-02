
import { appendFileSync } from 'node:fs'
import { closeSync, openSync, readSync, constants as fsConstants } from 'node:fs'
import { format as formatArgs } from 'node:util'
import autoBind from 'auto-bind'
import type { ReactNode } from 'react'
import { ConcurrentRoot } from 'react-reconciler/constants.js'
import { onExit } from 'signal-exit'
import { flushInteractionTime } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { fluxFrame, fluxMark } from '../utils/flux/fluxProbe.js'
import { isMouseTrackingEnabled as mouseTrackingEnabledByEnvironment } from '../utils/fullscreen.js'
import { logError } from '../utils/log.js'
import { notePulseFrameWritten } from '../utils/pulse/turnTrace.js'
import { applyPointerShape, resetPointerShape } from '../utils/cockpit/pointerShape.js'
import {
  CharPool,
  charInCellAt,
  cellAt,
  CellWidth,
  createScreen,
  HyperlinkPool,
  isEmptyCellAt,
  migrateScreenPools,
  StylePool,
  type Screen,
} from './cell-grid.js'
import { colorize } from './colorize.js'
import ComposeBuffer from './compose-buffer.js'
import composeTree from './compose-walk.js'
import App from './components/App.js'
import type { CursorDeclaration } from './components/CursorDeclarationContext.js'
import { InkInstanceContext } from './components/InkInstanceContext.js'
import { createNode, findOwnerChainAtRow, markDirty, type DOMElement } from './dom.js'
import { KeyboardEvent } from './events/keyboard-event.js'
import { FocusManager } from './focus.js'
import { emptyFrame, type FlickerRecord, type Frame, type FrameEvent, type Patch } from './frame.js'
import { FrameWriter } from './frame-writer.js'
import {
  dispatchClick as dispatchClickInTree,
  dispatchHover as dispatchHoverInTree,
  hitTest,
} from './geometry/hit.js'
import {
  captureScrolledRows,
  clearSelection,
  createSelectionState,
  extendSelection,
  findPlainTextUrlAt,
  getSelectedText,
  hasSelection,
  moveFocus,
  selectLineAt,
  selectWordAt,
  setSelectionClipBand,
  shiftSelection,
  startSelection,
  updateSelection,
  type FocusMove,
  type SelectionState,
} from './geometry/selection.js'
import type { ParsedKey } from './input/input-decoder.js'
import instances from './instances.js'
import { getCellLayoutCounters } from './layout/cellLayout.js'
import { nodeCache } from './node-cache.js'
import { optimizePatches } from './patch-stream.js'
import reconciler, {
  dispatcher,
  getLastCommitMs,
  getLastYogaMs,
  isDebugRepaintsEnabled,
  noteSlowLayout,
  recordLayoutMs,
  resetProfileCounters,
} from './reconciler.js'
import { scanPositions, type MatchPosition } from './render-to-screen.js'
import createRenderer, { type Renderer } from './renderer.js'
import { refreshConsoleSize } from './root/console-size.js'
import { planCursor, type CursorPoint } from './root/cursor-park.js'
import { FrameLedger, type ContaminationReason } from './root/frame-ledger.js'
import { applyOverlayPass, type SearchPositions } from './root/overlay-pass.js'
import { RenderScheduler } from './root/render-scheduler.js'
import {
  enterEditorBytes,
  exitEditorBytes,
  exitEditorRearmBytes,
  reassertModesBytes,
  reenterAltBytes,
  wakeReenterAltBytes,
  resizeReassertBytes,
} from './root/screen-session.js'
import { cockpitEngine, mountCockpitEngine, type CockpitEngine } from '../render-engine/cockpit/engineMount.js'
import { flushDoorSync, termWrite } from '../render-engine/cockpit/terminalOut.js'
import { RESIZE_SETTLE_MS } from './constants.js'
import { runTeardownSuite } from './root/teardown.js'
import { noteModeAcquired, noteModeReleased } from './root/terminalModeLedger.js'
import { extendedKeysSupportedNow, regionScrollTrustedNow, shouldHoldFirstPaintForSyncProbe, syncOutputSupportedNow } from './session/capabilities.js'
import { streamTakesWrites, writeAllSync, writeDiffToTerminal } from './session/delivery.js'
import { cursorPosition, ERASE_SCREEN, CURSOR_HOME } from './termio/csi.js'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
} from './termio/dec.js'
import { setClipboard, supportsTabStatus } from './termio/osc.js'
import { TerminalWriteProvider } from './useTerminalNotification.js'

export const RENDER_FAULT_RETRY_BUDGET = 3

export function renderFaultRecoveryPlan(streak: number, budget: number = RENDER_FAULT_RETRY_BUDGET): 'repaint' | 'loud' {
  return streak > budget ? 'loud' : 'repaint'
}
const POOL_RESET_INTERVAL_MS = 5 * 60_000
const WATCHDOG_COMMIT_BUDGET = 12
const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24
const ALT_SCREEN_SESSION_OWNER = 'alt-screen-session'

const TREE_DUMP_PATH = process.env.INK_TREE_DUMP
const COMPOSED_TEE_PATH = process.env.INK_COMPOSED_TEE
const COMMIT_TEE_PATH = process.env.INK_COMMIT_TEE
const WRITE_TEE_PATH = process.env.INK_WRITE_TEE
const WRITE_TEE_PROBE = process.env.INK_TEE_PROBE
const TREE_DUMP_BUDGET = 24
const TREE_DUMP_MAX_DEPTH = 16
const TREE_DUMP_NODE_BUDGET = 700

const CONSOLE_DEBUG_METHODS = [
  'log',
  'info',
  'debug',
  'dir',
  'dirxml',
  'count',
  'countReset',
  'group',
  'groupCollapsed',
  'groupEnd',
  'table',
  'time',
  'timeEnd',
  'timeLog',
] as const
const CONSOLE_ERROR_METHODS = ['warn', 'error', 'trace'] as const

export type Options = {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  exitOnCtrlC: boolean
  patchConsole: boolean
  waitUntilExit?: () => Promise<void>
  onFrame?: (event: FrameEvent) => void
}

type ExitOutcome = { kind: 'ok' } | { kind: 'error'; error: Error }

const HOME_CURSOR = Object.freeze({ x: 0, y: 0, visible: false })

function safeAppend(path: string, line: string): void {
  try {
    appendFileSync(path, line)
  } catch {
  }
}

export function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) return
  try {
    while (stdin.read() !== null) {
    }
  } catch {
  }
  if (process.platform === 'win32') return

  let fd: number | null = null
  let rawWasOn = false
  let rawChanged = false
  try {
    rawWasOn = stdin.isRaw === true
    if (!rawWasOn) {
      stdin.setRawMode(true)
      rawChanged = true
    }
    fd = openSync('/dev/tty', fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    const buffer = Buffer.alloc(1024)
    for (let i = 0; i < 64; i++) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
      }
    }
    if (rawChanged) {
      try {
        stdin.setRawMode(false)
      } catch {
      }
    }
  }
}

export default class Ink {
  private readonly options: Options
  private readonly isTTY: boolean

  private readonly stylePool = new StylePool()
  private charPool = new CharPool()
  private hyperlinkPool = new HyperlinkPool()
  private frontFrame: Frame
  private backFrame: Frame
  private cachedColumns: number
  private cachedRows: number
  private parkPatch: Patch
  private pendingAltEntry: string | null = null
  private lastPoolReset = Date.now()

  private readonly rootNode: DOMElement
  private readonly renderer: Renderer
  private readonly container: unknown
  private readonly writer: FrameWriter
  private readonly scheduler: RenderScheduler
  private readonly engine: CockpitEngine | null
  private readonly ledger = new FrameLedger()
  private lastAssignedWidth: number | null = null
  private layoutCounters = getCellLayoutCounters()
  private currentTree: ReactNode | null = null

  private isUnmounted = false
  private isPaused = false
  private lastRenderTime: number | null = null
  private restoreConsole: (() => void) | null = null
  private removeTtySubscriptions: (() => void) | null = null
  private exitPromise: Promise<void> | null = null
  private exitOutcomeLatch: ExitOutcome | null = null
  private editorHandoverDepth = 0;

  private altScreenActive = false
  private mouseTracking: boolean
  private mouseTrackingPref: boolean
  private displayCursor: CursorPoint | null = null
  private needsEraseBeforePaint = false
  private resizeSettleTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogCommitsRemaining = 0
  private zeroByteRenderStreak = 0

  readonly selection: SelectionState = createSelectionState()
  private readonly selectionListeners = new Set<() => void>()
  private searchQuery = ''
  private searchPositions: SearchPositions | null = null
  private readonly hoveredNodes = new Set<DOMElement>()
  private cursorDeclaration: CursorDeclaration | null = null
  onHyperlinkClick: ((url: string) => void) | undefined

  private storedReadableListeners: Array<(...args: unknown[]) => void> | null = null
  private wasRawMode = false

  private treeDumpBudget = TREE_DUMP_PATH ? TREE_DUMP_BUDGET : 0

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
    this.parkPatch = this.buildParkPatch()
    this.frontFrame = this.newEmptyFrame()
    this.backFrame = this.newEmptyFrame()
    this.mouseTracking = mouseTrackingEnabledByEnvironment()
    this.mouseTrackingPref = this.mouseTracking

    this.writer = new FrameWriter({ isTTY: this.isTTY, stylePool: this.stylePool })
    this.scheduler = new RenderScheduler(
      this.onRender,
      undefined,
      shouldHoldFirstPaintForSyncProbe,
    )
    this.engine = mountCockpitEngine({
      stdout: options.stdout as Parameters<typeof mountCockpitEngine>[0]['stdout'],
      columns: this.cachedColumns,
      syncOutputNow: syncOutputSupportedNow,
    })
    this.engine?.armResize({
      onStormEntered: () => {
        this.scheduler.holdForSettle()
        const { columns, rows } = this.liveSize()
        this.paintResizeHold(columns, rows)
      },
      onSettle: () => {
        this.applySettledResize()
      },
    })
    this.unsubscribeExit = onExit(this.unmount)

    if (this.isTTY) {
      options.stdout.on('resize', this.handleResize)
      process.on('SIGCONT', this.resumeAfterContinue)
      const win32SizeTimer: ReturnType<typeof setInterval> | null =
        process.platform === 'win32'
          ? setInterval(() => this.reconcileSize(), 5_000)
          : null
      win32SizeTimer?.unref?.();
      this.removeTtySubscriptions = () => {
        options.stdout.off('resize', this.handleResize)
        process.off('SIGCONT', this.resumeAfterContinue)
        if (win32SizeTimer !== null) clearInterval(win32SizeTimer)
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
    this.rootNode.onComputeLayout = this.calculateLayout

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

    if (process.env.NODE_ENV === 'development') {
      import('./devtools.js')
        .then(devtools => {
          const inject = (devtools as { default?: { injectIntoDevTools?: (config: unknown) => void } })
            .default?.injectIntoDevTools
          inject?.({ bundleType: 0, version: '19', rendererPackageName: 'ink' })
        })
        .catch(() => {})
    }
  }


  private newEmptyFrame(): Frame {
    return emptyFrame(
      this.cachedRows,
      this.cachedColumns,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
  }

  private buildParkPatch(): Patch {
    return { type: 'stdout', content: cursorPosition(this.cachedRows, 1) }
  }

  private liveSize(): { columns: number; rows: number } {
    return {
      columns: this.options.stdout.columns || DEFAULT_COLUMNS,
      rows: this.options.stdout.rows || DEFAULT_ROWS,
    }
  }

  private resetFramesForAltScreen(): void {
    const make = (): Frame => ({
      screen: createScreen(
        this.cachedColumns,
        this.cachedRows,
        this.stylePool,
        this.charPool,
        this.hyperlinkPool,
      ),
      viewport: { width: this.cachedColumns, height: this.cachedRows + 1 },
      cursor: { x: 0, y: 0, visible: true },
    })
    this.frontFrame = make()
    this.backFrame = make()
    this.ledger.syncAfterDeliberateReset()
    this.writer.reset()
    this.displayCursor = null
    this.ledger.contaminate('blank-reset')
  }

  private repaintMainScreen(): void {
    const rebuild = (frame: Frame): Frame =>
      emptyFrame(
        frame.viewport.height,
        frame.viewport.width,
        this.stylePool,
        this.charPool,
        this.hyperlinkPool,
      )
    this.frontFrame = rebuild(this.frontFrame)
    this.backFrame = rebuild(this.backFrame)
    this.ledger.syncAfterDeliberateReset()
    this.writer.reset()
    this.displayCursor = null
  }

  resetLineCount(): void {
    if (this.altScreenActive || !this.isTTY) return
    this.backFrame = this.frontFrame
    this.frontFrame = emptyFrame(
      this.frontFrame.viewport.height,
      this.frontFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.writer.reset()
    this.displayCursor = null
  }

  resetPools(): void {
    this.charPool = new CharPool()
    this.hyperlinkPool = new HyperlinkPool()
    migrateScreenPools(this.frontFrame.screen, this.charPool, this.hyperlinkPool)
    this.backFrame.screen.charPool = this.charPool
    this.backFrame.screen.hyperlinkPool = this.hyperlinkPool
    this.lastPoolReset = Date.now()
  }

  private handleResize = (): void => {
    const { columns, rows } = this.liveSize()
    if (this.engine !== null) {
      if (
        !this.engine.inResizeStorm() &&
        columns === this.cachedColumns &&
        rows === this.cachedRows
      ) {
        return
      }
      this.engine.winch(columns, rows)
      return
    }
    if (this.resizeSettleTimer === null) {
      if (columns === this.cachedColumns && rows === this.cachedRows) return
      this.scheduler.holdForSettle()
      this.paintResizeHold(columns, rows)
    } else {
      clearTimeout(this.resizeSettleTimer)
    }
    this.resizeSettleTimer = setTimeout(this.applySettledResize, RESIZE_SETTLE_MS)
  }

  private paintResizeHold(columns: number, rows: number): void {
    if (!this.altScreenActive || this.isPaused || !this.isTTY) return
    const patches = this.writer.holdingClipPaint(this.frontFrame, columns, rows)
    if (patches.length === 0) return
    writeDiffToTerminal(
      { stdout: this.options.stdout, stderr: this.options.stderr },
      patches,
      !syncOutputSupportedNow(),
    )
    this.displayCursor = null
  }

  private applySettledResize = (): void => {
    this.resizeSettleTimer = null
    const { columns, rows } = this.liveSize()
    this.cachedColumns = columns
    this.cachedRows = rows
    this.parkPatch = this.buildParkPatch()
    if (this.altScreenActive && !this.isPaused && this.isTTY) {
      termWrite(this.options.stdout, resizeReassertBytes(this.mouseTracking), 'mode')
      this.resetFramesForAltScreen()
      this.needsEraseBeforePaint = true
    }
    this.scheduler.releaseSettleHold(false)
    if (this.currentTree !== null) this.render(this.currentTree)
  }

  private clearResizeSettle(): void {
    if (this.resizeSettleTimer !== null) {
      clearTimeout(this.resizeSettleTimer)
      this.resizeSettleTimer = null
    }
    this.scheduler.releaseSettleHold(false)
  }

  reconcileSize(): void {
    if (process.platform !== 'win32') return;
    if (!refreshConsoleSize(this.options.stdout)) this.handleResize();
  }


  private calculateLayout = (): void => {
    if (this.isUnmounted) return
    const layout = this.rootNode.layoutNode
    if (!layout) return
    if (this.lastAssignedWidth !== this.cachedColumns) {
      layout.setWidth(this.cachedColumns)
      this.lastAssignedWidth = this.cachedColumns
    }
    const started = performance.now()
    layout.calculateLayout(this.cachedColumns, undefined)
    const elapsed = performance.now() - started
    recordLayoutMs(elapsed)
    this.layoutCounters = getCellLayoutCounters()
    noteSlowLayout(elapsed, this.layoutCounters)
    if (COMMIT_TEE_PATH) this.teeCommitGeometry(elapsed)
  }

  private teeCommitGeometry(layoutMs: number): void {
    try {
      const rectOf = (node: DOMElement) => {
        const l = node.layoutNode
        return l
          ? {
              x: l.getComputedLeft(),
              y: l.getComputedTop(),
              w: l.getComputedWidth(),
              h: l.getComputedHeight(),
            }
          : null
      }
      const elements = (node: DOMElement): DOMElement[] =>
        node.childNodes.filter((c): c is DOMElement => c.nodeName !== '#text')
      let rowNode: DOMElement | null = null
      const find = (node: DOMElement, depth: number): void => {
        if (rowNode || depth > 12) return
        if (
          node.style.flexDirection === 'row' &&
          elements(node).some(c => typeof c.style.width === 'number')
        ) {
          rowNode = node
          return
        }
        for (const child of elements(node)) find(child, depth + 1)
      }
      find(this.rootNode, 0)
      let record: Record<string, unknown> = { phase: 'commit', at: Date.now(), layoutMs }
      if (rowNode) {
        const row = rowNode as DOMElement
        const children = elements(row)
        const flexible = children.find(c => typeof c.style.width !== 'number')
        let scroll: DOMElement | null = null
        const findScroll = (node: DOMElement, depth: number): void => {
          if (scroll || depth > 12) return
          if (node.scroll?.scrollHeight !== undefined) {
            scroll = node
            return
          }
          for (const child of elements(node)) findScroll(child, depth + 1)
        }
        if (flexible) findScroll(flexible, 0)
        const scrollNode = scroll as DOMElement | null
        record = {
          ...record,
          row: children.map(rectOf),
          slot: flexible ? elements(flexible).map(rectOf) : [],
          scroll: scrollNode
            ? {
                top: scrollNode.scroll?.scrollTop,
                height: scrollNode.scroll?.scrollHeight,
                viewport: scrollNode.scroll?.scrollViewportHeight,
              }
            : null,
        }
      }
      safeAppend(COMMIT_TEE_PATH!, `${JSON.stringify(record)}\n`)
    } catch {
    }
  }


  scheduleRender = (): void => {
    this.scheduler.requestFrame()
  }

  private renderFaultStreak = 0

  onRender = (): void => {
    if (this.isUnmounted || this.isPaused) return
    try {
      this.renderFrame()
      this.renderFaultStreak = 0
    } catch (error) {
      this.recoverFromRenderFault(error)
    }
  }

  private recoverFromRenderFault(error: unknown): void {
    this.renderFaultStreak += 1
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`[ink] render fault ${this.renderFaultStreak}/${RENDER_FAULT_RETRY_BUDGET}: ${message}`, { level: 'warn' })
    if (renderFaultRecoveryPlan(this.renderFaultStreak) === 'loud') {
      this.renderFaultStreak = 0
      throw error
    }
    logError(error instanceof Error ? error : new Error(message))
    if (this.altScreenActive) {
      this.resetFramesForAltScreen()
      this.needsEraseBeforePaint = true
    }
    this.ledger.contaminate('self-heal')
    this.scheduleRender()
  }

  private renderFrame(): void {
    const frameStart = performance.now()
    fluxMark('paint:entry')
    this.scheduler.onRenderEntry()
    flushInteractionTime()

    const now = Date.now()
    if (
      this.altScreenActive &&
      this.lastRenderTime !== null &&
      now - this.lastRenderTime > 30_000
    ) {
      this.resetFramesForAltScreen()
      this.ledger.contaminate('self-heal');
    }
    this.lastRenderTime = now

    const { columns, rows } = this.liveSize()
    const wasContaminated = this.ledger.isContaminated()
    const regionScrollUsable =
      this.altScreenActive && syncOutputSupportedNow() && regionScrollTrustedNow()
    const rendererStart = performance.now()
    const { frame, signals } = this.renderer({
      frontFrame: this.frontFrame,
      backFrame: this.backFrame,
      isTTY: this.isTTY,
      terminalWidth: columns,
      terminalRows: rows,
      altScreen: this.altScreenActive,
      prevFrameContaminated: wasContaminated,
      regionScrollUsable,
    })
    const rendererMs = performance.now() - rendererStart

    const overlay = applyOverlayPass({
      altScreen: this.altScreenActive,
      follow: signals.consumeFollowScroll(),
      selection: this.selection,
      captureScreen: this.frontFrame.screen,
      screen: frame.screen,
      stylePool: this.stylePool,
      searchQuery: this.searchQuery,
      searchPositions: this.searchPositions,
      onSelectionCleared: () => {
        for (const listener of this.selectionListeners) listener()
      },
    })

    if (
      signals.layoutShifted ||
      overlay.selActive ||
      overlay.hlActive ||
      wasContaminated
    ) {
      const screen = frame.screen
      const bandTop = signals.shiftBandTop()
      const shiftOnly = !overlay.selActive && !overlay.hlActive && !wasContaminated
      if (
        shiftOnly &&
        bandTop !== null &&
        bandTop > 0 &&
        bandTop < screen.height
      ) {
        const existing = screen.damage
        const top = existing ? Math.min(existing.y, bandTop) : bandTop
        screen.damage = { x: 0, y: top, width: screen.width, height: screen.height - top }
      } else {
        screen.damage = { x: 0, y: 0, width: screen.width, height: screen.height }
      }
      if (this.treeDumpBudget > 0 && signals.layoutShifted) this.dumpTree(signals.shiftReason)
      if (COMPOSED_TEE_PATH && this.altScreenActive) {
        safeAppend(
          COMPOSED_TEE_PATH,
          `${JSON.stringify({
            fullDamage: true,
            layoutShift: signals.layoutShifted,
            shiftReason: signals.shiftReason,
            shiftLog: signals.shiftLog,
            selection: overlay.selActive,
            highlight: overlay.hlActive,
            contaminated: wasContaminated,
          })}\n`,
        )
      }
    }

    this.ledger.assertBaseDeliverable()

    const baseFrame: Frame = this.altScreenActive
      ? { ...this.frontFrame, cursor: HOME_CURSOR }
      : this.frontFrame

    if (WRITE_TEE_PATH) this.teeBeforeDiff(baseFrame, frame)

    const diffStart = performance.now()
    const patches = this.writer.render(baseFrame, frame, this.altScreenActive, regionScrollUsable)
    const diffMs = performance.now() - diffStart

    this.backFrame = this.frontFrame
    this.frontFrame = frame
    this.ledger.commitFrame()

    if (Date.now() - this.lastPoolReset > POOL_RESET_INTERVAL_MS) this.resetPools()

    const flickers: FlickerRecord[] = []
    for (const patch of patches) {
      if (patch.type !== 'clearTerminal') continue
      flickers.push({
        desiredHeight: frame.screen.height,
        availableHeight: frame.viewport.height,
        reason: patch.reason,
      })
      if (isDebugRepaintsEnabled() && patch.debug) {
        const chain = findOwnerChainAtRow(this.rootNode, patch.debug.triggerY)
        logForDebugging(
          `Full reset (${patch.reason}) at row ${patch.debug.triggerY}: prev=${JSON.stringify(patch.debug.prevLine)} next=${JSON.stringify(patch.debug.nextLine)} owners=${chain.join(' > ')}`,
          { level: 'warn' },
        )
      }
    }

    const optimizeStart = performance.now()
    const optimized = optimizePatches(patches)
    const optimizeMs = performance.now() - optimizeStart

    const hasDiff = optimized.length > 0
    const plan = planCursor({
      altScreen: this.altScreenActive,
      hasDiff,
      needsErase: this.needsEraseBeforePaint,
      parkPatch: this.parkPatch,
      target: this.resolveCursorTarget(),
      parked: this.displayCursor,
      prevCursor: { x: baseFrame.cursor.x, y: baseFrame.cursor.y },
      frameCursor: { x: frame.cursor.x, y: frame.cursor.y },
      rows,
      cols: columns,
    })
    if (plan.consumedErase) this.needsEraseBeforePaint = false
    this.displayCursor = plan.nextParked
    const finalPatches = [...plan.prelude, ...optimized, ...plan.postlude]
    if (this.pendingAltEntry !== null && this.altScreenActive && hasDiff) {
      finalPatches.unshift({ type: 'stdout', content: this.pendingAltEntry })
      this.pendingAltEntry = null
    }

    const writeStart = performance.now()
    const delivered = writeDiffToTerminal(
      { stdout: this.options.stdout, stderr: this.options.stderr },
      finalPatches,
      !syncOutputSupportedNow(),
    )
    const writeMs = performance.now() - writeStart
    if (WRITE_TEE_PATH) this.teeAfterDiff(finalPatches)

    if (this.watchdogCommitsRemaining > 0) {
      this.watchdogCommitsRemaining -= 1;
      if (this.altScreenActive && !hasDiff) {
        this.zeroByteRenderStreak += 1;
        if (this.zeroByteRenderStreak >= 5) {
          this.zeroByteRenderStreak = 0;
          this.watchdogCommitsRemaining = 0;
          this.reassertScreenState('zero-byte-watchdog', { repaint: false })
        }
      } else {
        this.zeroByteRenderStreak = 0;
      }
    }

    const contamination: ContaminationReason | null = overlay.selActive
      ? 'selection-overlay'
      : overlay.hlActive
        ? 'search-overlay'
        : null
    this.ledger.settle(delivered, contamination)
    notePulseFrameWritten(delivered)

    if (!delivered) {
      logForDebugging(
        'Frame write was not fully delivered; the next frame will fully re-emit',
        { level: 'warn' },
      )
      if (this.altScreenActive) this.needsEraseBeforePaint = true
    }

    if (frame.scrollDrainPending) this.scheduler.requestDrain()

    const durationMs = performance.now() - frameStart
    this.engine?.notePaintCost(durationMs, 'normal')
    fluxFrame(durationMs, patches.length)
    const commitMs = getLastCommitMs()
    const yogaMs = getLastYogaMs()
    resetProfileCounters()
    this.options.onFrame?.({
      durationMs,
      phases: {
        renderer: rendererMs,
        diff: diffMs,
        optimize: optimizeMs,
        write: writeMs,
        patches: patches.length,
        yoga: yogaMs,
        commit: commitMs,
        yogaVisited: this.layoutCounters.visited,
        yogaMeasured: this.layoutCounters.measured,
        yogaCacheHits: this.layoutCounters.cacheHits,
        yogaLive: this.layoutCounters.live,
      },
      flickers,
    })
  }

  private resolveCursorTarget(): CursorPoint | null {
    const declaration = this.cursorDeclaration
    if (!declaration) return null
    const rect = nodeCache.get(declaration.node)
    if (!rect) return null
    return { x: rect.x + declaration.relativeX, y: rect.y + declaration.relativeY }
  }

  private rowText(screen: Screen, y: number): string {
    let text = ''
    for (let x = 0; x < screen.width; x++) text += charInCellAt(screen, x, y) ?? ' '
    return text
  }

  private teeBeforeDiff(base: Frame, next: Frame): void {
    if (!WRITE_TEE_PATH) return
    try {
      const probe = WRITE_TEE_PROBE ?? ''
      const rows = new Set<number>()
      let differing = 0
      const height = Math.max(base.screen.height, next.screen.height)
      const width = Math.max(base.screen.width, next.screen.width)
      let probeInBase = false
      let probeInNext = false
      for (let y = 0; y < height; y++) {
        const a = y < base.screen.height ? this.rowText(base.screen, y) : ''
        const b = y < next.screen.height ? this.rowText(next.screen, y) : ''
        if (probe && a.includes(probe)) probeInBase = true
        if (probe && b.includes(probe)) probeInNext = true
        for (let x = 0; x < width; x++) {
          if ((a[x] ?? ' ') !== (b[x] ?? ' ')) {
            differing++
            rows.add(y)
          }
        }
      }
      safeAppend(
        WRITE_TEE_PATH,
        `${JSON.stringify({
          phase: 'before-diff',
          sameScreen: base.screen === next.screen,
          sharedCharPool: base.screen.charPool === next.screen.charPool,
          probeInBase,
          probeInNext,
          differingCells: differing,
          differingRows: [...rows].sort((p, q) => p - q),
          baseDamage: base.screen.damage ?? null,
          nextDamage: next.screen.damage ?? null,
        })}\n`,
      )
    } catch {
    }
  }

  private teeAfterDiff(patches: Patch[]): void {
    if (!WRITE_TEE_PATH) return
    try {
      const probe = WRITE_TEE_PROBE ?? ''
      let serialized = ''
      const kinds = new Set<string>()
      for (const patch of patches) {
        kinds.add(patch.type)
        if (patch.type === 'stdout') serialized += patch.content
        else if (patch.type === 'styleStr') serialized += patch.str
      }
      safeAppend(
        WRITE_TEE_PATH,
        `${JSON.stringify({
          phase: 'after-diff',
          patches: patches.length,
          bytes: serialized.length,
          probeInOutput: probe ? serialized.includes(probe) : false,
          kinds: [...kinds],
        })}\n`,
      )
    } catch {
    }
  }

  private dumpTree(reason: string | null): void {
    if (!TREE_DUMP_PATH || this.treeDumpBudget <= 0) return
    this.treeDumpBudget--
    try {
      const lines: string[] = [`--- tree dump (${reason ?? 'layout shift'}) ---`]
      let budget = TREE_DUMP_NODE_BUDGET
      const STYLE_KEYS = [
        'width',
        'minWidth',
        'maxWidth',
        'flexGrow',
        'flexShrink',
        'flexBasis',
        'flexDirection',
        'position',
        'overflow',
        'overflowX',
        'display',
        'alignItems',
        'alignSelf',
      ] as const
      const visit = (node: DOMElement, depth: number): void => {
        if (budget-- <= 0 || depth > TREE_DUMP_MAX_DEPTH) return
        const indent = '  '.repeat(depth)
        const layout = node.layoutNode
        const geometry = layout
          ? `${layout.getComputedLeft()},${layout.getComputedTop()} ${layout.getComputedWidth()}x${layout.getComputedHeight()}`
          : 'no-layout'
        const style = STYLE_KEYS.filter(key => node.style[key] !== undefined)
          .map(key => `${key}=${String(node.style[key])}`)
          .join(' ')
        const owners = (node.debugOwnerChain ?? []).slice(0, 4).join('>')
        lines.push(`${indent}${node.nodeName} [${geometry}] ${style} ${owners}`.trimEnd())
        for (const child of node.childNodes) {
          if (child.nodeName === '#text') {
            lines.push(
              `${indent}  #text ${JSON.stringify(child.nodeValue.slice(0, 28))}`,
            )
          } else {
            visit(child, depth + 1)
          }
        }
      }
      visit(this.rootNode, 0)
      safeAppend(COMPOSED_TEE_PATH ?? TREE_DUMP_PATH, `${lines.join('\n')}\n`)
    } catch {
    }
  }


  get isAltScreenActive(): boolean {
    return this.altScreenActive
  }

  setAltScreenActive(active: boolean, mouseTracking = true): void {
    if (active === this.altScreenActive) return
    this.altScreenActive = active
    this.mouseTracking = active && mouseTracking
    if (active) {
      this.resetFramesForAltScreen()
    } else {
      this.pendingAltEntry = null
      resetPointerShape(s => termWrite(this.options.stdout, s, 'mode'))
      this.repaintMainScreen()
      this.ledger.contaminate('blank-reset')
    }
  }

  isMouseTrackingEnabled(): boolean {
    return this.mouseTracking
  }

  isMouseTrackingPreferred(): boolean {
    return this.mouseTrackingPref
  }

  setMouseTrackingEnabled(on: boolean): void {
    this.mouseTrackingPref = on
    if (on === this.mouseTracking) return
    this.mouseTracking = on
    if (!this.altScreenActive) return
    if (!on) resetPointerShape(s => termWrite(this.options.stdout, s, 'mode'))
    termWrite(this.options.stdout, on ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING, 'mode')
    if (on) noteModeAcquired(ALT_SCREEN_SESSION_OWNER, 'mouse-tracking')
    else noteModeReleased(ALT_SCREEN_SESSION_OWNER, 'mouse-tracking')
  }

  enterAlternateScreen(): void {
    this.pause()
    this.suspendStdin()
    this.editorHandoverDepth += 1;
    this.engine?.noteOverlay(true, true)
    termWrite(
      this.options.stdout,
      enterEditorBytes({ altActive: this.altScreenActive, mouseTracking: this.mouseTracking }),
      'mode',
    )
  }

  exitAlternateScreen(): void {
    if (this.editorHandoverDepth === 0) {
      this.reassertScreenState('unmatched-exit-collapsed');
      return;
    }
    this.editorHandoverDepth -= 1;
    termWrite(
      this.options.stdout,
      exitEditorBytes({ altActive: this.altScreenActive, mouseTracking: this.mouseTracking }),
      'mode',
    )
    this.resumeStdin()
    if (this.altScreenActive) {
      this.resetFramesForAltScreen();
      this.needsEraseBeforePaint = true;
    } else {
      this.repaintMainScreen()
      this.ledger.contaminate('blank-reset')
    }
    this.resume()
    termWrite(this.options.stdout, exitEditorRearmBytes(extendedKeysSupportedNow()), 'mode')
  }

  reassertScreenState(reason: string, opts: { repaint?: boolean } = {}): void {
    if (this.isUnmounted) return
    this.screenReassertCount += 1
    logForDebugging(
      `Screen-state re-assert (${reason}): belief=${this.altScreenActive ? 'alt-screen' : 'main-screen'}`,
    )
    if (this.altScreenActive) {
      termWrite(this.options.stdout, ENTER_ALT_SCREEN, 'mode');
      this.resetFramesForAltScreen();
      this.needsEraseBeforePaint = true;
    }
    this.ledger.contaminate('self-heal');
    if (opts.repaint !== false) this.repaint();
  }

  armScreenWatchdog(): void {
    this.watchdogCommitsRemaining = WATCHDOG_COMMIT_BUDGET
    this.zeroByteRenderStreak = 0
  }

  private reenterAltScreen(): void {
    termWrite(this.options.stdout, reenterAltBytes(this.mouseTracking), 'mode')
    this.resetFramesForAltScreen()
  }

  private resumeAfterContinue = (): void => {
    if (!this.isTTY) return
    if (this.altScreenActive) {
      this.reenterAltScreen();
      this.armScreenWatchdog();
      return
    }
    this.frontFrame = emptyFrame(
      this.frontFrame.viewport.height,
      this.frontFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.backFrame = emptyFrame(
      this.backFrame.viewport.height,
      this.backFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.ledger.syncAfterDeliberateReset()
    this.writer.reset()
    this.displayCursor = null
    this.ledger.contaminate('blank-reset')
  }

  reassertTerminalModes(includeAltScreen = false): void {
    if (!this.isTTY) return
    if (this.isPaused || this.isUnmounted) return
    if (!streamTakesWrites(this.options.stdout)) return
    termWrite(
      this.options.stdout,
      reassertModesBytes({
        extendedKeys: extendedKeysSupportedNow(),
        altActive: this.altScreenActive,
        mouseTracking: this.mouseTracking,
      }),
      'mode',
    )
    if (includeAltScreen && this.altScreenActive) {
      termWrite(this.options.stdout, wakeReenterAltBytes(this.mouseTracking), 'mode')
      this.resetFramesForAltScreen()
      this.needsEraseBeforePaint = true
      this.scheduleRender()
    }
  }

  repaintAfterNestedAltScreenClose(): void {
    if (!this.altScreenActive) return
    this.resetFramesForAltScreen()
    this.needsEraseBeforePaint = true
    this.scheduleRender()
  }

  armAltScreenTakeover(): void {
    this.needsEraseBeforePaint = true;
    this.ledger.contaminate('takeover')
  }

  armAltScreenEntry(bytes: string): void {
    this.pendingAltEntry = bytes
    this.ledger.contaminate('takeover')
  }

  forceRedraw(): void {
    if (!this.isTTY || this.isUnmounted || this.isPaused) return
    termWrite(this.options.stdout, ERASE_SCREEN + CURSOR_HOME, 'mode')
    if (this.altScreenActive) {
      this.resetFramesForAltScreen()
      this.ledger.contaminate('force-redraw')
    } else {
      this.repaintMainScreen()
      this.ledger.contaminate('force-redraw')
    }
    this.onRender()
  }

  repaintAltScreen(): void {
    if (!this.isTTY || this.isUnmounted || this.isPaused) return
    if (!this.altScreenActive) {
      this.forceRedraw()
      return
    }
    this.resetFramesForAltScreen()
    this.ledger.contaminate('blank-reset')
    this.onRender()
  }

  invalidatePrevFrame(): void {
    this.ledger.contaminate('overlay-unmount')
  }

  repaint(): void {
    if (this.altScreenActive) {
      this.resetFramesForAltScreen()
    } else {
      this.repaintMainScreen()
      this.ledger.contaminate('blank-reset')
    }
    this.onRender()
  }

  pause(): void {
    reconciler.flushSyncWork()
    this.onRender()
    this.isPaused = true
  }

  resume(): void {
    this.isPaused = false
    this.onRender()
  }


  private notifySelectionChange = (): void => {
    this.onRender()
    for (const listener of this.selectionListeners) listener()
  }

  subscribeToSelectionChange(callback: () => void): () => void {
    this.selectionListeners.add(callback)
    return () => {
      this.selectionListeners.delete(callback)
    }
  }

  hasTextSelection(): boolean {
    return hasSelection(this.selection)
  }

  private applySelectionClipBand(col: number, row: number): void {
    try {
      const hit = hitTest(this.rootNode, col, row)
      let owner: DOMElement | null = null
      let node: DOMElement | undefined = hit ?? undefined
      while (node) {
        if (node.scroll?.scrollTop !== undefined || node.scroll?.scrollHeight !== undefined) {
          owner = node
          break
        }
        node = node.parentNode
      }
      const region = owner ?? hit
      const rect = region ? nodeCache.get(region) : undefined
      if (!rect) {
        clearSelection(this.selection)
        return
      }
      setSelectionClipBand(
        this.selection,
        rect.x,
        rect.x + rect.width - 1,
        this.frontFrame.screen.width,
      )
    } catch {
      clearSelection(this.selection)
    }
  }

  handleSelectionStart(col: number, row: number): void {
    if (!this.altScreenActive) return
    startSelection(this.selection, col, row)
    this.applySelectionClipBand(col, row)
    this.notifySelectionChange()
  }

  handleMultiClick(col: number, row: number, count: 2 | 3): void {
    if (!this.altScreenActive) return
    startSelection(this.selection, col, row)
    this.applySelectionClipBand(col, row)
    const screen = this.frontFrame.screen
    if (count === 2) selectWordAt(this.selection, screen, col, row)
    else selectLineAt(this.selection, screen, row)
    if (this.selection.focus === null && this.selection.anchor) {
      this.selection.focus = { ...this.selection.anchor }
    }
    this.notifySelectionChange()
  }

  handleSelectionDrag(col: number, row: number): void {
    if (!this.altScreenActive) return
    if (this.selection.anchorSpan) {
      extendSelection(this.selection, this.frontFrame.screen, col, row)
    } else {
      updateSelection(this.selection, col, row)
    }
    this.notifySelectionChange()
  }

  shiftSelectionForScroll(dRow: number, minRow: number, maxRow: number): void {
    const hadSelection = hasSelection(this.selection)
    shiftSelection(this.selection, dRow, minRow, maxRow, this.frontFrame.screen.width)
    if (hadSelection && !hasSelection(this.selection)) {
      for (const listener of this.selectionListeners) listener()
    }
  }

  moveSelectionFocus(move: FocusMove): void {
    if (!this.altScreenActive) return
    const focus = this.selection.focus
    if (!focus) return
    const width = this.frontFrame.screen.width
    const height = this.frontFrame.screen.height
    let { col, row } = focus
    switch (move) {
      case 'left':
        if (col > 0) col--
        else if (row > 0) {
          row--
          col = width - 1
        }
        break
      case 'right':
        if (col < width - 1) col++
        else if (row < height - 1) {
          row++
          col = 0
        }
        break
      case 'up':
        row = Math.max(0, row - 1)
        break
      case 'down':
        row = Math.min(height - 1, row + 1)
        break
      case 'lineStart':
        col = 0
        break
      case 'lineEnd':
        col = width - 1
        break
    }
    if (col === focus.col && row === focus.row) return
    moveFocus(this.selection, col, row)
    this.notifySelectionChange()
  }

  captureScrolledRows(firstRow: number, lastRow: number, side: 'above' | 'below'): void {
    captureScrolledRows(this.selection, this.frontFrame.screen, firstRow, lastRow, side)
  }

  copySelectionNoClear(): string {
    if (!hasSelection(this.selection)) return ''
    const text = getSelectedText(this.selection, this.frontFrame.screen)
    if (text) {
      void setClipboard(text)
        .then(sequence => {
          if (sequence) termWrite(this.options.stdout, sequence, 'mode')
        })
        .catch(logError)
    }
    return text
  }

  copySelection(): string {
    if (!hasSelection(this.selection)) return ''
    const text = this.copySelectionNoClear()
    clearSelection(this.selection)
    this.notifySelectionChange()
    return text
  }

  clearTextSelection(): void {
    if (!hasSelection(this.selection)) return
    clearSelection(this.selection)
    this.notifySelectionChange()
  }

  setSelectionBgColor(color: string): void {
    const marker = '\0'
    const painted = colorize(marker, color, 'background')
    const index = painted.indexOf(marker)
    if (index <= 0 || index >= painted.length - 1) {
      this.stylePool.setSelectionBg(null)
      return
    }
    this.stylePool.setSelectionBg({
      type: 'ansi',
      code: painted.slice(0, index),
      endCode: painted.slice(index + 1),
    })
  }

  setSearchHighlight(query: string): void {
    if (query === this.searchQuery) return
    this.searchQuery = query
    this.scheduleRender()
  }

  setSearchPositions(state: SearchPositions | null): void {
    this.searchPositions = state
    this.scheduleRender()
  }

  scanElementSubtree(el: DOMElement): MatchPosition[] {
    if (!this.searchQuery) return []
    const layout = el.layoutNode
    if (!layout) return []
    const width = Math.ceil(layout.getComputedWidth())
    const height = Math.ceil(layout.getComputedHeight())
    if (width <= 0 || height <= 0) return []
    const screen = createScreen(width, height, this.stylePool, this.charPool, this.hyperlinkPool)
    const buffer = new ComposeBuffer({ width, height, stylePool: this.stylePool, screen })
    composeTree(el, buffer, {
      offsetX: -layout.getComputedLeft(),
      offsetY: -layout.getComputedTop(),
      prevScreen: undefined,
    })
    const composed = buffer.get()
    markDirty(el)
    const positions = scanPositions(composed, this.searchQuery)
    logForDebugging(
      `scanElementSubtree: query=${JSON.stringify(this.searchQuery)} ${width}x${height} matches=${positions.length} first=${JSON.stringify(positions.slice(0, 3))}`,
    )
    return positions
  }

  getHyperlinkAt(col: number, row: number): string | undefined {
    if (!this.altScreenActive) return undefined
    const screen = this.frontFrame.screen
    const cell = cellAt(screen, col, row)
    if (cell?.hyperlink) return cell.hyperlink
    if (cell?.width === CellWidth.SpacerTail && col > 0) {
      const head = cellAt(screen, col - 1, row)
      if (head?.hyperlink) return head.hyperlink
    }
    return findPlainTextUrlAt(screen, col, row)
  }

  openHyperlink = (url: string): void => {
    this.onHyperlinkClick?.(url)
  }

  dispatchClick(col: number, row: number): boolean {
    if (!this.altScreenActive) return false
    const blank = isEmptyCellAt(this.frontFrame.screen, col, row)
    return dispatchClickInTree(this.rootNode, col, row, blank)
  }

  dispatchHover(col: number, row: number): void {
    if (!this.altScreenActive) return
    const screen = this.frontFrame.screen
    const selectable =
      col >= 0 &&
      row >= 0 &&
      col < screen.width &&
      row < screen.height &&
      screen.noSelect[row * screen.width + col] !== 1 &&
      !isEmptyCellAt(screen, col, row)
    applyPointerShape(selectable, s => termWrite(this.options.stdout, s, 'mode'))
    dispatchHoverInTree(this.rootNode, col, row, this.hoveredNodes)
  }

  dispatchKeyboardEvent(parsedKey: ParsedKey): void {
    const target = this.focusManager.activeElement ?? this.rootNode
    const event = new KeyboardEvent(parsedKey)
    const notPrevented = dispatcher.dispatchDiscrete(target, event)
    if (notPrevented && event.key === 'tab' && !event.ctrl && !event.meta) {
      if (event.shift) this.focusManager.focusPrevious(this.rootNode)
      else this.focusManager.focusNext(this.rootNode)
    }
  }

  private setCursorDeclaration = (
    declaration: CursorDeclaration | null,
    clearIfNode?: DOMElement | null,
  ): void => {
    if (declaration === null && clearIfNode) {
      if (this.cursorDeclaration?.node !== clearIfNode) return
    }
    this.cursorDeclaration = declaration
  }


  drainStdin(): void {
    drainStdin(this.options.stdin)
  }

  suspendStdin(): void {
    const { stdin } = this.options
    if (!stdin.isTTY) return
    const listeners = stdin.listeners('readable') as Array<(...args: unknown[]) => void>
    for (const listener of listeners) stdin.removeListener('readable', listener)
    this.storedReadableListeners = listeners
    const rawWasOn = stdin.isRaw === true
    logForDebugging(
      `suspendStdin: removed ${listeners.length} readable listener(s), raw=${rawWasOn}`,
    )
    if (rawWasOn) {
      stdin.setRawMode(false)
      this.wasRawMode = true
    }
  }

  resumeStdin(): void {
    const { stdin } = this.options
    if (!stdin.isTTY) return
    if (
      (this.storedReadableListeners === null || this.storedReadableListeners.length === 0) &&
      !this.wasRawMode
    ) {
      logForDebugging('resumeStdin: nothing stored — possible desync, re-asserting screen state', {
        level: 'warn',
      })
      this.reassertScreenState('resume-desync')
    }
    for (const listener of this.storedReadableListeners ?? []) {
      stdin.addListener('readable', listener)
    }
    this.storedReadableListeners = null
    if (this.wasRawMode) {
      stdin.setRawMode(true)
      this.wasRawMode = false;
    }
    this.reconcileSize();
    this.armScreenWatchdog();
  }


  patchConsole(): () => void {
    const restorers: Array<() => void> = []
    const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => void>
    for (const method of CONSOLE_DEBUG_METHODS) {
      const original = consoleRecord[method]
      if (typeof original !== 'function') continue
      consoleRecord[method] = (...args: unknown[]) => {
        logForDebugging(`[console.${method}] ${formatArgs(...args)}`)
      }
      restorers.push(() => {
        consoleRecord[method] = original
      })
    }
    for (const method of CONSOLE_ERROR_METHODS) {
      const original = consoleRecord[method]
      if (typeof original !== 'function') continue
      consoleRecord[method] = (...args: unknown[]) => {
        logError(new Error(`[console.${method}] ${formatArgs(...args)}`))
      }
      restorers.push(() => {
        consoleRecord[method] = original
      })
    }
    const originalAssert = console.assert
    console.assert = (condition?: unknown, ...args: unknown[]) => {
      if (!condition) logError(new Error(`[console.assert] ${formatArgs(...args)}`))
    }
    restorers.push(() => {
      console.assert = originalAssert
    })
    restorers.push(this.interceptStderr())
    return () => {
      for (const restore of restorers) restore()
    }
  }

  private interceptStderr(): () => void {
    const stream = this.options.stderr
    const originalWrite = stream.write.bind(stream)
    let reentered = false
    const intercept = (
      chunk: unknown,
      encodingOrCallback?: unknown,
      maybeCallback?: unknown,
    ): boolean => {
      const callback =
        typeof encodingOrCallback === 'function'
          ? (encodingOrCallback as (error?: Error | null) => void)
          : typeof maybeCallback === 'function'
            ? (maybeCallback as (error?: Error | null) => void)
            : undefined
      if (reentered) {
        return typeof encodingOrCallback === 'function'
          ? originalWrite(chunk as string, encodingOrCallback as () => void)
          : originalWrite(chunk as string, encodingOrCallback as BufferEncoding, maybeCallback as () => void)
      }
      reentered = true
      try {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        logForDebugging(`[stderr] ${text}`, { level: 'warn' })
        if (this.altScreenActive && !this.isUnmounted && !this.isPaused) {
          this.ledger.contaminate('stderr-leak')
          this.scheduleRender()
        }
      } catch {
      } finally {
        reentered = false
        callback?.(null)
      }
      return true
    }
    stream.write = intercept as typeof stream.write
    return () => {
      if (stream.write === (intercept as typeof stream.write)) {
        stream.write = originalWrite as typeof stream.write
      }
    }
  }


  private writeRaw = (data: string): void => {
    termWrite(this.options.stdout, data, 'mode')
  }

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
          onStdinResume={this.onStdinResume}
          setCursorDeclaration={this.setCursorDeclaration}
          dispatchKeyboardEvent={this.dispatchKeyboardEvent.bind(this)}
        >
          <TerminalWriteProvider value={this.writeRaw}>{node}</TerminalWriteProvider>
        </App>
      </InkInstanceContext.Provider>
    )
    reconciler.updateContainerSync(tree, this.container, null, null)
    reconciler.flushSyncWork()
  }

  private onStdinResume = (): void => {
    this.reassertTerminalModes(false)
  }

  unmount = (error?: Error | number | null): void => {
    if (this.isUnmounted) return
    this.onRender()
    this.unsubscribeExit()
    if (this.restoreConsole) {
      this.restoreConsole()
      this.restoreConsole = null
    }
    this.removeTtySubscriptions?.()
    this.removeTtySubscriptions = null

    const finish = optimizePatches(this.writer.finish(this.frontFrame))
    writeDiffToTerminal(
      { stdout: this.options.stdout, stderr: this.options.stderr },
      finish,
      true,
    )

    if (this.isTTY) {
      flushDoorSync()
      runTeardownSuite({
        altScreenActive: this.altScreenActive,
        tabStatusSupported: supportsTabStatus(),
        write: bytes => {
          writeAllSync(1, Buffer.from(bytes, 'utf8'))
        },
        drainStdin: () => drainStdin(this.options.stdin),
        resetPointer: resetPointerShape,
      })
    }

    this.isUnmounted = true
    this.clearResizeSettle()
    this.scheduler.cancel()
    this.engine?.detach()
    reconciler.updateContainerSync(null, this.container, null, null)
    reconciler.flushSyncWork()
    instances.delete(this.options.stdout)
    const layout = this.rootNode.layoutNode
    if (layout) {
      layout.free()
      this.rootNode.layoutNode = undefined
    }

    const outcome: ExitOutcome =
      error instanceof Error ? { kind: 'error', error } : { kind: 'ok' }
    this.exitOutcome = outcome
    this.exitOutcomeLatch = outcome
    if (outcome.kind === 'error') this.rejectExitPromise(outcome.error)
    else this.resolveExitPromise()
  }

  waitUntilExit(): Promise<void> {
    if (this.options.waitUntilExit) return this.options.waitUntilExit()
    if (this.exitPromise) return this.exitPromise
    const latch = this.exitOutcomeLatch
    if (latch) {
      return latch.kind === 'error' ? Promise.reject(latch.error) : Promise.resolve()
    }
    this.exitPromise = new Promise<void>((resolve, reject) => {
      this.resolveExitPromise = resolve
      this.rejectExitPromise = reject
    })
    return this.exitPromise
  }

  detachForShutdown(): void {
    this.isUnmounted = true
    this.clearResizeSettle()
    this.scheduler.cancel()
    drainStdin(this.options.stdin)
    const { stdin } = this.options
    if (stdin.isTTY && stdin.isRaw) {
      try {
        stdin.setRawMode(false)
      } catch {
      }
    }
  }
}
