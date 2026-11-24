import { flushInteractionTime } from '../../../boot/process-state/processState.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { fluxMark, fluxFrame } from '../../../integrations/media-flux/fluxProbe.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { burnFrameCostPad, noteFrameWire, noteFrameCost } from '../../cockpit/motionGovernor.js'
import type { CursorDeclaration } from '../elements/CursorDeclarationContext.js'
import { findOwnerChainAtRow, type DOMElement } from '../dom.js'
import type { Frame, FlickerRecord } from '../frame.js'
import { OverlayRecord } from '../geometry/selectionOverlay.js'
import { unionRect } from '../layout/geometry.js'
import { nodeCache } from '../node-cache.js'
import { optimizePatches } from '../patch-stream.js'
import reconciler, { isDebugRepaintsEnabled, getLastCommitMs, getLastYogaMs, resetProfileCounters } from '../reconciler.js'
import type { RenderResult } from '../renderer.js'
import { refreshConsoleSize } from '../root/console-size.js'
import { planCursor, type CursorPoint } from '../root/cursor-park.js'
import { readFrameWire } from '../root/frame-trace.js'
import { applyOverlayPass } from '../root/overlay-pass.js'
import { syncOutputSupportedNow, regionScrollTrustedNow } from '../terminal-session/capabilities.js'
import { writeDiffToTerminal } from '../terminal-session/frameDelivery.js'
import { ERASE_SCREEN } from '../termio/csi.js'
import { COMPOSED_TEE_PATH, safeAppend, WRITE_TEE_PATH, dumpTree, teeBeforeDiff, teeAfterDiff } from './tees.js'
import { liveSize, resetFramesForAltScreen } from './frames.js'
import { consoleBufferOutlivesWindow, settleResize, settleHoldPaints, applySize } from './resize.js'
import type ScreenInstance from '../screenInstance.js'
import { startMicrotask } from '../../../platform/async/timers.js'
import { consoleSizeNeedsPolling } from '../../../platform/host-os/terminal.js'

export const RENDER_FAULT_RETRY_BUDGET = 3

export function renderFaultRecoveryPlan(streak: number, budget: number = RENDER_FAULT_RETRY_BUDGET): 'repaint' | 'loud' {
  return streak > budget ? 'loud' : 'repaint'
}

const POOL_RESET_INTERVAL_MS = 5 * 60_000

const HOME_CURSOR = Object.freeze({ x: 0, y: 0, visible: false })

type OnRenderReads = Pick<
  ScreenInstance,
  | 'options' | 'isTTY' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'parkPatch'
  | 'pendingAltEntry' | 'lastPoolReset' | 'rootNode' | 'renderer' | 'writer' | 'scheduler' | 'ledger' | 'layoutCounters' | 'currentTree' | 'isUnmounted'
  | 'isPaused' | 'isRendering' | 'lastRenderTime' | 'altScreenActive' | 'mouseTracking' | 'displayCursor' | 'wholeFrameDue' | 'resizeEraseDue' | 'wholeFrameAt'
  | 'resizeSettleTimer' | 'watchdogCommitsRemaining' | 'zeroByteRenderStreak' | 'selection' | 'selectionListeners' | 'glassOverlay' | 'searchQuery'
  | 'searchPositions' | 'cursorDeclaration' | 'frameListeners' | 'treeDumpBudget' | 'resetPools' | 'applySettledResize' | 'calculateLayout'
  | 'scheduleRender' | 'renderFaultStreak' | 'firstFrameStamped' | 'onRender' | 'stampFirstFrame' | 'reassertScreenState' | 'render'
>

export function onRender(this: OnRenderReads): void {
  if (this.isUnmounted || this.isPaused || this.isRendering) return
  const settling = this.resizeSettleTimer !== null
  if (settling && !settleHoldPaints.call(this)) return
  this.isRendering = true
  try {
    if (!settling) {
      if (this.isTTY && consoleSizeNeedsPolling()) refreshConsoleSize(this.options.stdout)
      const { columns, rows } = liveSize.call(this)
      if (columns !== this.cachedColumns || rows !== this.cachedRows) {
        if (reconciler.isAlreadyRendering()) {
          startMicrotask(this.onRender)
          return
        }
        if (consoleBufferOutlivesWindow.call(this)) {
          settleResize.call(this)
          return
        }
        applySize.call(this, columns, rows)
        if (this.currentTree !== null) this.render(this.currentTree)
        this.calculateLayout()
      }
    }
    renderFrame.call(this)
    this.renderFaultStreak = 0
  } catch (error) {
    recoverFromRenderFault.call(this, error)
  } finally {
    this.isRendering = false
  }
}

type RecoverFromRenderFaultReads = Pick<
  ScreenInstance,
  | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger' | 'altScreenActive'
  | 'displayCursor' | 'wholeFrameDue' | 'glassOverlay' | 'scheduleRender' | 'renderFaultStreak'
>

function recoverFromRenderFault(this: RecoverFromRenderFaultReads, error: unknown): void {
  this.renderFaultStreak += 1
  const message = error instanceof Error ? error.message : String(error)
  logForDebugging(`[ink] render fault ${this.renderFaultStreak}/${RENDER_FAULT_RETRY_BUDGET}: ${message}`, { level: 'warn' })
  if (renderFaultRecoveryPlan(this.renderFaultStreak) === 'loud') {
    this.renderFaultStreak = 0
    throw error
  }
  logError(error instanceof Error ? error : new Error(message))
  if (this.altScreenActive) {
    resetFramesForAltScreen.call(this)
    this.wholeFrameDue = true
  }
  this.ledger.contaminate('self-heal')
  this.scheduleRender()
}

type RenderFrameReads = Pick<
  ScreenInstance,
  | 'options' | 'isTTY' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'parkPatch'
  | 'pendingAltEntry' | 'lastPoolReset' | 'rootNode' | 'renderer' | 'writer' | 'scheduler' | 'ledger' | 'layoutCounters' | 'lastRenderTime'
  | 'altScreenActive' | 'displayCursor' | 'wholeFrameDue' | 'resizeEraseDue' | 'wholeFrameAt' | 'resizeSettleTimer' | 'watchdogCommitsRemaining' | 'zeroByteRenderStreak' | 'selection'
  | 'selectionListeners' | 'glassOverlay' | 'searchQuery' | 'searchPositions' | 'cursorDeclaration' | 'frameListeners' | 'treeDumpBudget' | 'resetPools'
  | 'firstFrameStamped' | 'onRender' | 'stampFirstFrame' | 'reassertScreenState'
>

function renderFrame(this: RenderFrameReads): void {
  const frameStart = performance.now()
  burnFrameCostPad()
  fluxMark('paint:entry')
  this.scheduler.onRenderEntry()
  flushInteractionTime()

  const now = Date.now()
  if (
    this.altScreenActive &&
    this.lastRenderTime !== null &&
    now - this.lastRenderTime > 30_000
  ) {
    resetFramesForAltScreen.call(this)
    this.wholeFrameDue = true
    this.ledger.contaminate('self-heal');
  }
  this.lastRenderTime = now

  const live = liveSize.call(this)
  const settling = this.resizeSettleTimer !== null
  const columns = settling ? this.cachedColumns : live.columns
  const rows = settling ? this.cachedRows : live.rows
  const reach = { width: Math.min(columns, live.columns), height: Math.min(rows, live.rows) }
  const held = (shown: Frame): Frame => (settling ? { ...shown, viewport: reach } : shown)
  const wasContaminated = this.ledger.isContaminated()
  const regionScrollUsable =
    this.altScreenActive && !settling && syncOutputSupportedNow() && regionScrollTrustedNow()
  const rendererStart = performance.now()
  const glassOverlay = this.glassOverlay
  if (glassOverlay) glassOverlay.revert(this.frontFrame.screen)
  let composed: RenderResult
  try {
    composed = this.renderer({
      frontFrame: this.frontFrame,
      backFrame: this.backFrame,
      isTTY: this.isTTY,
      terminalWidth: columns,
      terminalRows: rows,
      altScreen: this.altScreenActive,
      prevFrameContaminated: wasContaminated,
      regionScrollUsable,
    })
  } finally {
    if (glassOverlay) glassOverlay.restore(this.frontFrame.screen)
  }
  const { frame, signals } = composed
  const rendererMs = performance.now() - rendererStart

  const overlayRecord = new OverlayRecord(frame.screen.width)
  const overlay = applyOverlayPass({
    altScreen: this.altScreenActive,
    scrollTranslation: signals.consumeScrollTranslation(),
    selection: this.selection,
    captureScreen: this.frontFrame.screen,
    screen: frame.screen,
    stylePool: this.stylePool,
    searchQuery: this.searchQuery,
    searchPositions: this.searchPositions,
    onSelectionCleared: () => {
      for (const listener of this.selectionListeners) listener()
    },
    record: overlayRecord,
  })
  const vacated = glassOverlay ? glassOverlay.rect() : null
  if (vacated) {
    const screen = frame.screen
    screen.damage = screen.damage ? unionRect(screen.damage, vacated) : vacated
  }

  if (signals.layoutShifted || wasContaminated) {
    const screen = frame.screen
    const bandTop = signals.shiftBandTop()
    const shiftOnly = !wasContaminated
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
    if (this.treeDumpBudget > 0 && signals.layoutShifted) dumpTree.call(this, signals.shiftReason)
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
    ? held({ ...this.frontFrame, cursor: HOME_CURSOR })
    : this.frontFrame

  if (WRITE_TEE_PATH) teeBeforeDiff(baseFrame, frame)

  const diffStart = performance.now()
  const whole = this.wholeFrameDue && this.altScreenActive
  const patches = whole
    ? this.writer.overwriteAlt(held(frame))
    : this.writer.render(baseFrame, held(frame), this.altScreenActive, regionScrollUsable)
  if (whole) {
    this.wholeFrameDue = false
    this.wholeFrameAt = performance.now()
  }
  const diffMs = performance.now() - diffStart
  if (!this.firstFrameStamped) this.stampFirstFrame()

  this.backFrame = this.frontFrame
  this.frontFrame = frame
  this.glassOverlay = overlayRecord.size > 0 ? overlayRecord : null
  this.ledger.commitFrame(patches.length > 0)

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
    parkPatch: this.parkPatch,
    target: resolveCursorTarget.call(this),
    parked: this.displayCursor,
    prevCursor: { x: baseFrame.cursor.x, y: baseFrame.cursor.y },
    frameCursor: { x: frame.cursor.x, y: frame.cursor.y },
    rows: reach.height,
    cols: reach.width,
  })
  this.displayCursor = plan.nextParked
  const finalPatches = [...plan.prelude, ...optimized, ...plan.postlude]
  if (whole && this.resizeEraseDue) finalPatches.unshift({ type: 'stdout', content: ERASE_SCREEN })
  this.resizeEraseDue = false
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
  if (WRITE_TEE_PATH) teeAfterDiff(finalPatches)

  this.ledger.settle(delivered, null)

  if (!delivered) {
    logForDebugging(
      'Frame write was not fully delivered; the next frame will fully re-emit',
      { level: 'warn' },
    )
    if (this.altScreenActive) this.wholeFrameDue = true
  }

  if (this.watchdogCommitsRemaining > 0) {
    this.watchdogCommitsRemaining -= 1;
    if (this.altScreenActive && !hasDiff) {
      this.zeroByteRenderStreak += 1;
      if (this.zeroByteRenderStreak >= 5) {
        this.zeroByteRenderStreak = 0;
        this.watchdogCommitsRemaining = 0;
        this.reassertScreenState('zero-byte-watchdog', { repaint: false })
        startMicrotask(this.onRender)
      }
    } else {
      this.zeroByteRenderStreak = 0;
    }
  }

  if (frame.scrollDrainPending) this.scheduler.requestDrain()

  const durationMs = performance.now() - frameStart
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
  noteFrameWire(readFrameWire())
  noteFrameCost(durationMs)
  for (const listener of this.frameListeners) {
    try {
      listener()
    } catch (error) {
      logForDebugging(`frame listener threw (ignored): ${error}`, { level: 'warn' })
    }
  }
}

export function subscribeFrame(this: Pick<ScreenInstance, 'frameListeners'>, listener: () => void): () => void {
  this.frameListeners.add(listener)
  return () => {
    this.frameListeners.delete(listener)
  }
}

function resolveCursorTarget(this: Pick<ScreenInstance, 'cursorDeclaration'>): CursorPoint | null {
  const declaration = this.cursorDeclaration
  if (!declaration) return null
  const rect = nodeCache.get(declaration.node)
  if (!rect) return null
  return { x: rect.x + declaration.relativeX, y: rect.y + declaration.relativeY }
}

export function setCursorDeclaration(this: Pick<ScreenInstance, 'cursorDeclaration'>, declaration: CursorDeclaration | null, clearIfNode?: DOMElement | null): void {
  if (declaration === null && clearIfNode) {
    if (this.cursorDeclaration?.node !== clearIfNode) return
  }
  this.cursorDeclaration = declaration
}
