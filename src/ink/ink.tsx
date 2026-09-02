// The renderer instance: frame loop, buffers and terminal geometry,
// screen-state integrity, selection/search/pointer facade, mounting and
// teardown. The frame-generation ledger, the render scheduler, the cursor
// plan, the overlay pass and the teardown suite are owned by `root/*` —
// this class sequences them.

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
import { runTeardownSuite, type TeardownHost } from './root/teardown.js'
import {
  continueRearmBytes,
  isStopSignal,
  POSIX_STOP_SIGNALS,
  restoreTerminalForStop,
  stopSignalsSupported,
} from './root/stop-continue.js'
import { noteModeAcquired, noteModeReleased, shutdownReleaseObligations } from './root/terminalModeLedger.js'
import { extendedKeysSupportedNow, regionScrollTrustedNow, shouldHoldFirstPaintForSyncProbe, syncOutputSupportedNow } from './session/capabilities.js'
import { streamTakesWrites, writeAllSync, writeDiffToTerminal } from './session/delivery.js'
import { cursorPosition, ERASE_SCREEN, CURSOR_HOME } from './termio/csi.js'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  HIDE_CURSOR,
} from './termio/dec.js'
import { setClipboard, supportsTabStatus } from './termio/osc.js'
import { TerminalWriteProvider } from './useTerminalNotification.js'

/** Consecutive paint faults tolerated before the fault goes loud. */
export const RENDER_FAULT_RETRY_BUDGET = 3

/** Pure recovery ladder (sweep #2, packet 51): within the budget the
 *  paint contaminates-and-repaints; past it the fault goes loud. */
export function renderFaultRecoveryPlan(streak: number, budget: number = RENDER_FAULT_RETRY_BUDGET): 'repaint' | 'loud' {
  return streak > budget ? 'loud' : 'repaint'
}
const POOL_RESET_INTERVAL_MS = 5 * 60_000
const WATCHDOG_COMMIT_BUDGET = 12
const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24
const ALT_SCREEN_SESSION_OWNER = 'alt-screen-session'

// Forensics (all off by default; every append is guarded).
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
    // Forensics must never break rendering.
  }
}

/** Discard pending input bytes so in-flight escape sequences do not leak to
 *  the shell after exit. Safe to call repeatedly; call as LATE as possible. */
export function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) return
  try {
    while (stdin.read() !== null) {
      // Drain the stream's own buffer.
    }
  } catch {
    // A destroyed stream is tolerated.
  }
  if (process.platform === 'win32') return

  let fd: number | null = null
  let rawWasOn = false
  let rawChanged = false
  try {
    rawWasOn = stdin.isRaw === true
    if (!rawWasOn) {
      // Canonical mode line-buffers input: non-blocking reads would report
      // "would block" with bytes still queued.
      stdin.setRawMode(true)
      rawChanged = true
    }
    // A FRESH descriptor: raw mode is a terminal-attribute change, not a
    // descriptor-flag change, and the process's own descriptor stays
    // blocking. All descriptors on the controlling terminal share one
    // line-discipline queue.
    fd = openSync('/dev/tty', fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    const buffer = Buffer.alloc(1024)
    for (let i = 0; i < 64; i++) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
    }
  } catch {
    // EAGAIN (the expected empty case), ENXIO (no controlling terminal),
    // EIO/ENOTTY (revoked terminal) — all swallowed.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Tolerated.
      }
    }
    if (rawChanged) {
      try {
        stdin.setRawMode(false)
      } catch {
        // Tolerated.
      }
    }
  }
}

export default class Ink {
  private readonly options: Options
  private readonly isTTY: boolean

  // Buffers and geometry.
  private readonly stylePool = new StylePool()
  private charPool = new CharPool()
  private hyperlinkPool = new HyperlinkPool()
  private frontFrame: Frame
  private backFrame: Frame
  private cachedColumns: number
  private cachedRows: number
  private parkPatch: Patch
  /** Armed by armAltScreenEntry; flushed as the first non-empty frame's
   *  write prefix. */
  private pendingAltEntry: string | null = null
  private lastPoolReset = Date.now()

  // Tree, renderer, container.
  private readonly rootNode: DOMElement
  private readonly renderer: Renderer
  private readonly container: unknown
  private readonly writer: FrameWriter
  private readonly scheduler: RenderScheduler
  /** The cockpit engine mount (MERCURY_RENDER_ENGINE); null flag-off. */
  private readonly engine: CockpitEngine | null
  private readonly ledger = new FrameLedger()
  private lastAssignedWidth: number | null = null
  private layoutCounters = getCellLayoutCounters()
  private currentTree: ReactNode | null = null

  // Lifecycle state.
  private isUnmounted = false
  private isPaused = false
  private lastRenderTime: number | null = null
  private restoreConsole: (() => void) | null = null
  private removeTtySubscriptions: (() => void) | null = null
  private exitPromise: Promise<void> | null = null
  private exitOutcomeLatch: ExitOutcome | null = null
  // Several statements below carry semicolons and pinned identifiers: the
  // screen-integrity provers read this file's text (see the receipt).
  private editorHandoverDepth = 0;

  // Screen belief.
  private altScreenActive = false
  private mouseTracking: boolean
  /** The OPERATOR's wish (the /mouse seam's only durable writer). Alt-screen
   *  lifecycle flips the LIVE state; it must never clobber this. */
  private mouseTrackingPref: boolean
  private displayCursor: CursorPoint | null = null
  private needsEraseBeforePaint = false
  /** Armed while a WINCH storm is inside its settle window. */
  private resizeSettleTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogCommitsRemaining = 0
  private zeroByteRenderStreak = 0

  // Selection / search / pointer.
  readonly selection: SelectionState = createSelectionState()
  private readonly selectionListeners = new Set<() => void>()
  private searchQuery = ''
  private searchPositions: SearchPositions | null = null
  private readonly hoveredNodes = new Set<DOMElement>()
  private cursorDeclaration: CursorDeclaration | null = null
  onHyperlinkClick: ((url: string) => void) | undefined

  // Stdin suspend/resume bookkeeping.
  private storedReadableListeners: Array<(...args: unknown[]) => void> | null = null
  private wasRawMode = false
  // Job-control stop bookkeeping (stop-continue.ts): the stop restore turned
  // raw mode off, so the continue turns it back on.
  private rawModeOffForStop = false
  private stopListenersAttached = false

  // Forensics.
  private treeDumpBudget = TREE_DUMP_PATH ? TREE_DUMP_BUDGET : 0

  // Public fields.
  readonly focusManager: FocusManager
  screenReassertCount = 0
  exitOutcome: ExitOutcome | null = null
  unsubscribeExit: () => void
  resolveExitPromise: () => void = () => {}
  rejectExitPromise: (reason?: Error) => void = () => {}

  constructor(options: Options) {
    // Consumers hand methods around unbound (external-store snapshot
    // getters, the app root's callbacks) — every method binds to the
    // instance up front.
    autoBind(this)
    this.options = options
    this.isTTY = options.stdout.isTTY === true
    if (options.patchConsole) this.restoreConsole = this.patchConsole()

    this.cachedColumns = options.stdout.columns || DEFAULT_COLUMNS
    this.cachedRows = options.stdout.rows || DEFAULT_ROWS
    this.parkPatch = this.buildParkPatch()
    this.frontFrame = this.newEmptyFrame()
    this.backFrame = this.newEmptyFrame()
    // (The runtime toggle is the mouse escape — no env opt-out.)
    this.mouseTracking = mouseTrackingEnabledByEnvironment()
    this.mouseTrackingPref = this.mouseTracking

    this.writer = new FrameWriter({ isTTY: this.isTTY, stylePool: this.stylePool })
    this.scheduler = new RenderScheduler(
      this.onRender,
      undefined,
      shouldHoldFirstPaintForSyncProbe,
    )
    // THE ENGINE MOUNT (MERCURY_RENDER_ENGINE): binds the ONE door on the
    // TTY fd and puts the engine's gates under this painter — E4 delivery,
    // E5/E6 scheduling, E7's storm gate. Flag off ⇒ null everywhere and the
    // classic paths run byte-identically. Probe-once law: the mount adopts
    // the session querier's sync-output latch; it never probes itself.
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
      // The stop half of the same seam: a job-control stop restores the
      // terminal before the process stops (stop-continue.ts).
      this.attachStopListeners()
      // Only raw mode keeps the runtime's cached console size current on
      // Windows; unchanged sizes return immediately from the handler.
      const win32SizeTimer: ReturnType<typeof setInterval> | null =
        process.platform === 'win32'
          ? setInterval(() => this.reconcileSize(), 5_000)
          : null
      win32SizeTimer?.unref?.();
      this.removeTtySubscriptions = () => {
        options.stdout.off('resize', this.handleResize)
        process.off('SIGCONT', this.resumeAfterContinue)
        this.detachStopListeners()
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
        // Trace only — the app root's boundary already paints the crash surface.
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

  // ── buffers and geometry ──────────────────────────────────────────────

  private newEmptyFrame(): Frame {
    return emptyFrame(
      this.cachedRows,
      this.cachedColumns,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
  }

  /** The alternate-screen park patch: an absolute move to (last row, col 1). */
  private buildParkPatch(): Patch {
    return { type: 'stdout', content: cursorPosition(this.cachedRows, 1) }
  }

  private liveSize(): { columns: number; rows: number } {
    return {
      columns: this.options.stdout.columns || DEFAULT_COLUMNS,
      rows: this.options.stdout.rows || DEFAULT_ROWS,
    }
  }

  /** Full-size blank reset (alternate screen): both frames rows × columns
   *  of empty cells, viewport rows PLUS ONE, cursor at the origin. */
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

  /** Main-screen repaint: EMPTY frames at their OWN viewport dimensions. */
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

  /** WINCH entry — the resize SETTLE discipline. Events closer together
   *  than RESIZE_SETTLE_MS are one storm (a drag): no relayout and no paint
   *  per intermediate size — the scheduler is held (commits keep landing
   *  underneath, streaming buffers nothing is lost from) and the screen
   *  carries the last composed frame clipped to the live size. One settled
   *  relayout + repaint lands after the quiet window. */
  private handleResize = (): void => {
    const { columns, rows } = this.liveSize()
    if (this.engine !== null) {
      // E7 (engine-mounted): the WINCH feeds the engine's settle gate — the
      // storm holds reflow (one cheap holding paint on entry, armed at the
      // mount), 120ms of quiet settles ONCE via applySettledResize.
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
      // ONE holding paint per storm, on entry — the same discipline the
      // engine's gate keeps. Every later WINCH inside the window only
      // re-arms the timer: the terminal already clips the held frame to
      // each intermediate size, so a paint per event re-emitted the whole
      // clipped screen for nothing (a drag delivers dozens) and a slow
      // terminal fell behind the very storm the settle exists to absorb.
      this.paintResizeHold(columns, rows)
    } else {
      clearTimeout(this.resizeSettleTimer)
    }
    this.resizeSettleTimer = setTimeout(this.applySettledResize, RESIZE_SETTLE_MS)
  }

  /** The storm's cheap holding paint: last frame clipped, no clear, no
   *  layout. Alt screen only — the main screen's history rewraps under the
   *  terminal's own rules and repainting mid-storm would fight it. */
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

  /** One settle window of quiet: apply the size for real — reassert modes,
   *  blank the frame model, erase-in-frame, and re-render the tree so
   *  layout runs at the settled width. Exactly one clear per storm. */
  private applySettledResize = (): void => {
    this.resizeSettleTimer = null
    const { columns, rows } = this.liveSize()
    this.cachedColumns = columns
    this.cachedRows = rows
    this.parkPatch = this.buildParkPatch()
    if (this.altScreenActive && !this.isPaused && this.isTTY) {
      // No alternate-screen enter (a repeated enter clears on some
      // emulators) and no synchronous erase (it would blank for the whole
      // render): the erase folds into the frame's atomic block.
      termWrite(this.options.stdout, resizeReassertBytes(this.mouseTracking), 'mode')
      this.resetFramesForAltScreen()
      this.needsEraseBeforePaint = true
    }
    // Held paints are DISCARDED, not flushed — they would compose the
    // pre-settle layout; the tree render below schedules the settled one.
    this.scheduler.releaseSettleHold(false)
    // Re-render so the size context changes — a bare frame request would
    // paint before layout is updated.
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
    // The runtime refreshes its cached console size only while the stdin
    // reader runs in raw mode, so a resize during an external-editor
    // handover (or under a host that never signals) never reached
    // stdout.columns/rows — and a reconcile that re-read those two numbers
    // could not see the change it exists to catch (FN-015 rank 43). Ask the
    // console directly through the runtime's own refresh road: a moved
    // answer emits resize and lands in handleResize like any other; a
    // stream without that road falls back to the cached pair.
    if (!refreshConsoleSize(this.options.stdout)) this.handleResize();
  }

  // ── layout ────────────────────────────────────────────────────────────

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

  /** Per-commit geometry forensics: a row-direction element holding a
   *  fixed-width slot, its children's rects, the non-fixed slot's children
   *  and the first scrolling descendant's offsets. */
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
      // Swallowed by design.
    }
  }

  // ── the frame loop ────────────────────────────────────────────────────

  scheduleRender = (): void => {
    this.scheduler.requestFrame()
  }

  /** Consecutive paints that threw (sweep #2, packet 51). */
  private renderFaultStreak = 0

  /**
   * The paint entry with its recovery boundary. A layout, diff or write
   * exception would otherwise escape into the log-and-continue uncaught handler with
   * the frame ledger mid-transaction — the session stayed alive but nothing
   * repainted honestly again. Now the fault is logged, the frame model is
   * contaminated so the next paint re-emits every cell, and ONE full repaint
   * is scheduled. Three faults in a row go loud (the fault is rethrown to
   * the crash path) rather than looping on a broken frame forever.
   */
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
      // Recovery itself keeps failing: the frame is unpaintable and hiding
      // that would be the lie. Reset the streak so a later paint can still
      // try, then let the crash path own this one.
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
    fluxMark('paint:entry') // probe-gated ring stamp (off ⇒ no-op)
    this.scheduler.onRenderEntry()
    flushInteractionTime()

    const now = Date.now()
    if (
      this.altScreenActive &&
      this.lastRenderTime !== null &&
      now - this.lastRenderTime > 30_000
    ) {
      // The diff never compares itself to reality; blank the MODEL so every
      // cell re-emits, contaminated so nothing blits from the blank.
      this.resetFramesForAltScreen()
      this.ledger.contaminate('self-heal');
    }
    this.lastRenderTime = now

    const { columns, rows } = this.liveSize()
    const wasContaminated = this.ledger.isContaminated()
    // ONE region-scroll truth per frame, compose and writer alike: sync
    // output makes the region scroll + edge repaint one atomic paint, AND
    // the terminal must actually PERFORM DECSTBM region scrolls — ConPTY
    // advertises the former while silently dropping the latter (the
    // phantom-region-scroll desync class), and Apple Terminal has neither.
    // The compose's full-width shift excludes the shifted rows from damage
    // ONLY under this promise; a hint composed without it leaves the
    // pre-scroll rows standing on the glass (the same reply painted at two
    // offsets — the duplicate-paint sighting).
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
        // Listeners schedule a React update for LATER; never recurse into
        // the render.
        for (const listener of this.selectionListeners) listener()
      },
    })

    // Full-damage backstop with band scoping.
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

    // Generation assertion BEFORE the base is chosen.
    this.ledger.assertBaseDeliverable()

    // Cursor anchoring: the alternate-screen diff base is pinned at home.
    const baseFrame: Frame = this.altScreenActive
      ? { ...this.frontFrame, cursor: HOME_CURSOR }
      : this.frontFrame

    if (WRITE_TEE_PATH) this.teeBeforeDiff(baseFrame, frame)

    const diffStart = performance.now()
    // The SAME truth the compose walked with (see regionScrollUsable above):
    // a frame whose hints composed damage-excluded must be the frame whose
    // writer emits the region scrolls, and only that frame.
    const patches = this.writer.render(baseFrame, frame, this.altScreenActive, regionScrollUsable)
    const diffMs = performance.now() - diffStart

    // Swap and commit the generation.
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
    // Deferred alt entry: the switch/wipe/arm prefix joins the FIRST
    // non-empty frame so the whole transition is one atomic write. An empty
    // frame keeps it pending — entering the alt buffer with nothing to
    // paint IS the black beat this seam exists to kill.
    if (this.pendingAltEntry !== null && this.altScreenActive && hasDiff) {
      finalPatches.unshift({ type: 'stdout', content: this.pendingAltEntry })
      this.pendingAltEntry = null
    }

    const writeStart = performance.now()
    // Synchronised-output markers ride EVERY frame write exactly when the
    // capability is armed — both screens, read per frame (the latch can
    // upgrade mid-session via the boot probe). A terminal that answered the
    // probe "not recognized" must see ZERO 2026 bytes.
    const delivered = writeDiffToTerminal(
      { stdout: this.options.stdout, stderr: this.options.stderr },
      finalPatches,
      !syncOutputSupportedNow(),
    )
    const writeMs = performance.now() - writeStart
    if (WRITE_TEE_PATH) this.teeAfterDiff(finalPatches)

    // The zero-byte watchdog: inert outside its armed window (a blind
    // re-assert IS the blank on some emulators).
    if (this.watchdogCommitsRemaining > 0) {
      this.watchdogCommitsRemaining -= 1;
      if (this.altScreenActive && !hasDiff) {
        this.zeroByteRenderStreak += 1;
        if (this.zeroByteRenderStreak >= 5) {
          // Trips ONCE: the window closes with it. The repaint is
          // suppressed — the contaminated model already re-emits fully.
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
    // E5's cost feedback: the frame's measured cost drives the adaptive
    // floor (engine-mounted only; null flag-off).
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
      // Swallowed by design.
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
      // Swallowed by design.
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
      // Swallowed by design.
    }
  }

  // ── screen-state integrity ────────────────────────────────────────────

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
      // An armed-but-unflushed entry dies with the mode — the buffer switch
      // must never fire after the surface that asked for it is absent.
      this.pendingAltEntry = null
      // Leaving the alt screen hands the pointer back to the terminal (a
      // no-op when no shape was ever emitted).
      resetPointerShape(s => termWrite(this.options.stdout, s, 'mode'))
      this.repaintMainScreen()
      this.ledger.contaminate('blank-reset')
    }
  }

  isMouseTrackingEnabled(): boolean {
    return this.mouseTracking
  }

  /** The operator's standing preference — what a NEW alt-screen mount should
   *  arm. Distinct from the live state: leaving the alt screen drops live
   *  tracking (correct), but the next mount must not read that drop as an
   *  operator opt-out (the fresh-boot walk→REPL handoff left every session
   *  mouseless until a manual /mouse on). */
  isMouseTrackingPreferred(): boolean {
    return this.mouseTrackingPref
  }

  /** OFF hands the mouse back to the TERMINAL (native drag-select works
   *  again); clicks, hover and wheel stop until ON. The environment kill
   *  flag is authoritative: a runtime enable cannot override it. */
  setMouseTrackingEnabled(on: boolean): void {
    this.mouseTrackingPref = on
    if (on === this.mouseTracking) return
    this.mouseTracking = on
    if (!this.altScreenActive) return
    // An emitted pointer shape must not outlive the motion stream.
    if (!on) resetPointerShape(s => termWrite(this.options.stdout, s, 'mode'))
    termWrite(this.options.stdout, on ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING, 'mode')
    if (on) noteModeAcquired(ALT_SCREEN_SESSION_OWNER, 'mouse-tracking')
    else noteModeReleased(ALT_SCREEN_SESSION_OWNER, 'mouse-tracking')
  }

  /** Editor handover: pause, suspend stdin, and hand the terminal over. */
  enterAlternateScreen(): void {
    this.pause()
    this.suspendStdin()
    // The depth makes the handover transactional: an exit without a
    // matching enter can never emit a one-sided release.
    this.editorHandoverDepth += 1;
    // E8 bookkeeping: the editor handover is the fullscreen-borrow surface.
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
      // The erase folds into the same atomic write as the repaint.
      this.needsEraseBeforePaint = true;
    } else {
      this.repaintMainScreen()
      this.ledger.contaminate('blank-reset')
    }
    this.resume()
    // Editors reset their own key-report level on exit; pop before push.
    termWrite(this.options.stdout, exitEditorRearmBytes(extendedKeysSupportedNow()), 'mode')
  }

  reassertScreenState(reason: string, opts: { repaint?: boolean } = {}): void {
    if (this.isUnmounted) return
    // A non-zero count on a healthy session is the recurrence signal.
    this.screenReassertCount += 1
    logForDebugging(
      `Screen-state re-assert (${reason}): belief=${this.altScreenActive ? 'alt-screen' : 'main-screen'}`,
    )
    // Re-entering an active alternate screen is harmless and the repaint
    // restores content; on a terminal that silently dropped to the main
    // screen it is exactly the cure. A main-screen belief needs no byte.
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

  /** SIGCONT / stall re-entry: the destructive re-entry composite plus a
   *  full-size blank base. */
  private reenterAltScreen(): void {
    termWrite(this.options.stdout, reenterAltBytes(this.mouseTracking), 'mode')
    this.resetFramesForAltScreen()
  }

  /** The stop signals ride one owner (stop-continue.ts); Windows has none. */
  private attachStopListeners(): void {
    if (this.stopListenersAttached || !stopSignalsSupported()) return
    for (const signal of POSIX_STOP_SIGNALS) process.on(signal, this.stopForSignal)
    this.stopListenersAttached = true
  }

  private detachStopListeners(): void {
    if (!this.stopListenersAttached) return
    for (const signal of POSIX_STOP_SIGNALS) process.off(signal, this.stopForSignal)
    this.stopListenersAttached = false
  }

  /** The exit-time and stop-time disarm share ONE host: the loss-proof
   *  synchronous fd-1 writer, the instance's stdin drain, the pointer reset. */
  private teardownHost(): TeardownHost {
    return {
      altScreenActive: this.altScreenActive,
      tabStatusSupported: supportsTabStatus(),
      // The loss-proof synchronous fd-1 writer: bounded retry on
      // would-block, tolerant of a broken pipe at exit.
      write: bytes => {
        writeAllSync(1, Buffer.from(bytes, 'utf8'))
      },
      drainStdin: () => drainStdin(this.options.stdin),
      resetPointer: resetPointerShape,
    }
  }

  /** A job-control stop (SIGTSTP · SIGTTIN · SIGTTOU): restore the terminal
   *  FIRST — the exit disarm suite, then raw mode off for a foreground stop
   *  — and only then really stop: the listeners come off so the re-raised
   *  signal takes its default disposition and the shell sees a normally
   *  stopped job. Execution continues past the re-raise on SIGCONT; the
   *  listeners re-attach here and resumeAfterContinue re-arms the modes. */
  private stopForSignal = (signal: NodeJS.Signals): void => {
    if (!isStopSignal(signal)) return
    this.detachStopListeners()
    if (this.isTTY && !this.isUnmounted) {
      // Door discipline (the exit path's own): pending units drain first so
      // the restore is the LAST thing the terminal receives before the stop.
      flushDoorSync()
      const receipt = restoreTerminalForStop(signal, this.teardownHost(), this.options.stdin)
      this.rawModeOffForStop = receipt.rawModeOff
    }
    try {
      process.kill(process.pid, signal)
    } catch {
      // The signal is not deliverable here: nothing to stop for.
    }
    // Reached after SIGCONT (or at once when the kill was refused).
    if (!this.isUnmounted) this.attachStopListeners()
  }

  private resumeAfterContinue = (): void => {
    if (!this.isTTY || this.isUnmounted) return
    // Raw mode back before any paint: input must be live when the repaint
    // lands (a stop that never turned it off leaves this a no-op).
    if (this.rawModeOffForStop) {
      this.rawModeOffForStop = false
      try {
        this.options.stdin.setRawMode(true)
      } catch {
        // A terminal that refuses the mode change is left as it is.
      }
    }
    // A stop that bypassed the handler (an external SIGSTOP) left the
    // listeners attached; one that rode it re-attaches after the re-raise.
    this.attachStopListeners()
    // Re-arm what the stop released — extended keys, bracketed paste, focus
    // reporting, and on alt the mouse family + scroll — through the one
    // arming owner; a stream that is gone takes no modes.
    if (streamTakesWrites(this.options.stdout)) {
      termWrite(
        this.options.stdout,
        continueRearmBytes({
          extendedKeys: extendedKeysSupportedNow(),
          altActive: this.altScreenActive,
          mouseTracking: this.mouseTracking,
        }),
        'mode',
      )
      // The stop showed the hardware cursor (the exit suite's last step);
      // the owner that hid it still holds the obligation in the ledger, and
      // no paint re-hides it (the frames only park it), so the continue
      // does — never under the accessibility experience, which keeps it.
      if (shutdownReleaseObligations().includes('cursor-hidden')) {
        termWrite(this.options.stdout, HIDE_CURSOR, 'mode')
      }
    }
    if (this.altScreenActive) {
      this.reenterAltScreen();
      this.armScreenWatchdog();
      // The erased screen earns a SCHEDULED full repaint through the normal
      // atomic path (the fresh frames diff everything back on).
      this.needsEraseBeforePaint = true
      this.scheduleRender()
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
    // A zero-height front frame must never be blitted from.
    this.ledger.contaminate('blank-reset')
    // The main screen repaints from the fresh frames the same way.
    this.scheduleRender()
  }

  reassertTerminalModes(includeAltScreen = false): void {
    if (!this.isTTY) return
    if (this.isPaused || this.isUnmounted) return
    // A terminal that is gone takes no modes: a stream that was destroyed,
    // ended or reports itself unwritable answers the write with an error
    // the process has no seam for. The stall wake and the stdin resume
    // both arrive here after a quiet spell, and a torn-down PTY is one of
    // the ways a spell ends.
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
      // The PAIRED wake re-entry — never the bare repeat ?1049h the estate
      // forbids on an active alt screen (the cursor-save clobber; TASK-017
      // S2, stall-wake-re-enter-clobbers-exit-cursor) — and the erased
      // screen earns a SCHEDULED repaint through the normal atomic path:
      // the old arm blanked the cockpit and painted nothing until an
      // unrelated commit (the stall-detector moderates' second half).
      termWrite(this.options.stdout, wakeReenterAltBytes(this.mouseTracking), 'mode')
      this.resetFramesForAltScreen()
      this.needsEraseBeforePaint = true
      this.scheduleRender()
    }
  }

  repaintAfterNestedAltScreenClose(): void {
    if (!this.altScreenActive) return
    this.resetFramesForAltScreen()
    // The erase rides inside the frame's atomic write; never render
    // synchronously from an effect or cleanup.
    this.needsEraseBeforePaint = true
    this.scheduleRender()
  }

  armAltScreenTakeover(): void {
    this.needsEraseBeforePaint = true;
    this.ledger.contaminate('takeover')
  }

  /** Deferred alternate-screen ENTRY: the mount writes nothing — the buffer
   *  switch + wipe + mode arming ride as the PREFIX of the first non-empty
   *  composed frame's atomic write, so the previous surface (the trust
   *  dialog, any main-screen face) stays visible until the alt face exists:
   *  old face → new face in one paint, no black beat (the onboarding
   *  blank-and-torn class — the same deferred seam as the launcher-hold
   *  takeover, for the no-hold path). */
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

  /** The main-screen repaint plus a render. */
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

  // ── selection, search, pointer ────────────────────────────────────────

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

  /** The clip band — semantic region ownership. A scroll pane wins when the
   *  anchor is inside one (a body of text); otherwise the anchored node's own
   *  box is the region (a side rail, a status bar, composer chrome), so a
   *  gesture beginning inside such an element copies only what it shows.
   *  A lookup miss may NOT widen the band to the terminal (the rail escape
   *  class: a drag anchored on a narrow element carried away a screenful of
   *  unrelated columns). */
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
        // No owning region under the anchor: decline the gesture.
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
    // The walk wrote offset rects into the shared cache — one extra paint
    // restores the main render's coordinates.
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
    // Tab cycling is the DEFAULT action.
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
      // A sibling's clear must not clobber a newly focused sibling's set.
      if (this.cursorDeclaration?.node !== clearIfNode) return
    }
    this.cursorDeclaration = declaration
  }

  // ── stdin handover ────────────────────────────────────────────────────

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
      // This exact branch fired in the field failure the defence exists for.
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
    // F2: a suspended or cooked window queued resize records the cache
    // never saw.
    this.reconcileSize();
    // F1′: the resume seam arms the zero-byte watchdog.
    this.armScreenWatchdog();
  }

  // ── console / stderr interception ─────────────────────────────────────

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
        // The debug logger itself may write here.
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
        // Never throw into a stream write.
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

  // ── mounting and teardown ─────────────────────────────────────────────

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
      // Door discipline on the exit path (E4): pending units drain first
      // within the teardown budget, so the restore below is the LAST unit
      // and nothing interleaves into it. Flag off ⇒ no door, no-op.
      flushDoorSync()
      runTeardownSuite(this.teardownHost())
    }

    this.isUnmounted = true
    this.clearResizeSettle()
    this.scheduler.cancel()
    // The engine mount detaches with the painter: storm gate cancelled, the
    // door unbound (its own flush is a no-op after the drain above).
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
        // Tolerated at shutdown.
      }
    }
  }
}
