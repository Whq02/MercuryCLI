import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { resetPointerShape } from '../../cockpit/pointerShape.js'
import reconciler from '../reconciler.js'
import { enterEditorBytes, exitEditorBytes, exitEditorRearmBytes, reenterAltBytes, reassertModesBytes, wakeReenterAltBytes } from '../root/screen-session.js'
import { termWrite } from '../terminalOut.js'
import { noteModeAcquired, noteModeReleased } from '../root/terminalModeLedger.js'
import { extendedKeysSupportedNow } from '../terminal-session/capabilities.js'
import { terminalQuerierFor, terminalQuerySettleMs } from '../terminal-session/terminalQuerier.js'
import { streamTakesWrites } from '../terminal-session/frameDelivery.js'
import { ERASE_SCREEN, CURSOR_HOME } from '../termio/csi.js'
import { ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN } from '../termio/dec.js'
import { resetFramesForAltScreen, repaintMainScreen } from './frames.js'
import { drainStdin } from './stdin.js'
import type ScreenInstance from '../screenInstance.js'
import { startTimeout } from '../../../platform/async/timers.js'

const WATCHDOG_COMMIT_BUDGET = 12

const OVERWRITE_MIN_GAP_MS = 250

const ALT_SCREEN_SESSION_OWNER = 'alt-screen-session'

type SetAltScreenActiveReads = Pick<
  ScreenInstance,
  | 'options' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'pendingAltEntry' | 'ledger'
  | 'altScreenActive' | 'mouseTracking' | 'wheelReportingConfirmed' | 'displayCursor' | 'glassOverlay'
>

export function setAltScreenActive(this: SetAltScreenActiveReads, active: boolean, mouseTracking: boolean): void {
  if (active === this.altScreenActive) return
  this.altScreenActive = active
  this.mouseTracking = active && mouseTracking
  this.wheelReportingConfirmed = false
  if (active) {
    resetFramesForAltScreen.call(this)
  } else {
    this.pendingAltEntry = null
    resetPointerShape(s => termWrite(this.options.stdout, s))
    repaintMainScreen.call(this)
    this.ledger.contaminate('blank-reset')
  }
}

export function registerTranscriptScrollTarget(this: Pick<ScreenInstance, 'transcriptScrollTarget'>, target: () => boolean): () => void {
  this.transcriptScrollTarget = target
  return () => {
    if (this.transcriptScrollTarget === target) this.transcriptScrollTarget = null
  }
}

export function registerArrowKeyOwner(this: Pick<ScreenInstance, 'arrowKeyOwners'>, owns: () => boolean): () => void {
  this.arrowKeyOwners.add(owns)
  return () => {
    this.arrowKeyOwners.delete(owns)
  }
}

export function arrowKeysOwned(this: Pick<ScreenInstance, 'arrowKeyOwners'>): boolean {
  for (const owns of this.arrowKeyOwners) if (owns()) return true
  return false
}

export function setMouseTrackingEnabled(this: Pick<ScreenInstance, 'options' | 'altScreenActive' | 'mouseTracking' | 'mouseTrackingPref' | 'wheelReportingConfirmed'>, on: boolean): void {
  this.mouseTrackingPref = on
  if (on === this.mouseTracking) return
  this.mouseTracking = on
  this.wheelReportingConfirmed = false
  if (!this.altScreenActive) return
  if (!on) resetPointerShape(s => termWrite(this.options.stdout, s))
  termWrite(this.options.stdout, on ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING)
  if (on) noteModeAcquired(ALT_SCREEN_SESSION_OWNER, 'mouse-tracking')
  else noteModeReleased(ALT_SCREEN_SESSION_OWNER, 'mouse-tracking')
}

export async function awaitTerminalQueries(this: Pick<ScreenInstance, 'options'>): Promise<void> {
  const querier = terminalQuerierFor(this.options.stdout)
  if (querier === undefined || querier.settled()) return
  await querier.whenSettled(terminalQuerySettleMs())
}

function drainUnsettledQueries(this: Pick<ScreenInstance, 'options'>): void {
  const querier = terminalQuerierFor(this.options.stdout)
  if (querier === undefined || querier.settled()) return
  drainStdin(this.options.stdin)
}

export function enterAlternateScreen(this: Pick<ScreenInstance, 'options' | 'editorHandoverDepth' | 'altScreenActive' | 'mouseTracking' | 'pause' | 'suspendStdin'>): void {
  this.pause()
  this.suspendStdin()
  this.editorHandoverDepth += 1;
  termWrite(
    this.options.stdout,
    enterEditorBytes({ altActive: this.altScreenActive, mouseTracking: this.mouseTracking }),
  )
}

type ExitAlternateScreenReads = Pick<
  ScreenInstance,
  | 'options' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger'
  | 'editorHandoverDepth' | 'altScreenActive' | 'mouseTracking' | 'displayCursor' | 'wholeFrameDue' | 'glassOverlay' | 'reassertScreenState' | 'resume'
  | 'resumeStdin'
>

export function exitAlternateScreen(this: ExitAlternateScreenReads): void {
  if (this.editorHandoverDepth === 0) {
    this.reassertScreenState('unmatched-exit-collapsed');
    return;
  }
  this.editorHandoverDepth -= 1;
  termWrite(
    this.options.stdout,
    exitEditorBytes({ altActive: this.altScreenActive, mouseTracking: this.mouseTracking }),
  )
  this.resumeStdin()
  if (this.altScreenActive) {
    resetFramesForAltScreen.call(this);
    this.wholeFrameDue = true;
  } else {
    repaintMainScreen.call(this)
    this.ledger.contaminate('blank-reset')
  }
  this.resume()
  termWrite(this.options.stdout, exitEditorRearmBytes(extendedKeysSupportedNow()))
}

type ReassertScreenStateReads = Pick<
  ScreenInstance,
  | 'options' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger' | 'isUnmounted'
  | 'altScreenActive' | 'displayCursor' | 'wholeFrameDue' | 'glassOverlay' | 'screenReassertCount' | 'repaint'
>

export function reassertScreenState(this: ReassertScreenStateReads, reason: string, opts: { repaint?: boolean }): void {
  if (this.isUnmounted) return
  this.screenReassertCount += 1
  logForDebugging(
    `Screen-state re-assert (${reason}): belief=${this.altScreenActive ? 'alt-screen' : 'main-screen'}`,
  )
  if (this.altScreenActive) {
    termWrite(this.options.stdout, ENTER_ALT_SCREEN);
    resetFramesForAltScreen.call(this);
    this.wholeFrameDue = true;
  }
  this.ledger.contaminate('self-heal');
  if (opts.repaint !== false) this.repaint();
}

export function armScreenWatchdog(this: Pick<ScreenInstance, 'watchdogCommitsRemaining' | 'zeroByteRenderStreak'>): void {
  this.watchdogCommitsRemaining = WATCHDOG_COMMIT_BUDGET
  this.zeroByteRenderStreak = 0
}

type ReenterAltScreenReads = Pick<
  ScreenInstance,
  | 'options' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger' | 'mouseTracking'
  | 'displayCursor' | 'glassOverlay'
>

export function reenterAltScreen(this: ReenterAltScreenReads): void {
  termWrite(this.options.stdout, reenterAltBytes(this.mouseTracking))
  resetFramesForAltScreen.call(this)
}

type ReassertTerminalModesReads = Pick<
  ScreenInstance,
  | 'options' | 'isTTY' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger'
  | 'isUnmounted' | 'isPaused' | 'altScreenActive' | 'mouseTracking' | 'displayCursor' | 'wholeFrameDue' | 'glassOverlay' | 'scheduleRender'
>

export function reassertTerminalModes(this: ReassertTerminalModesReads, includeAltScreen: boolean): void {
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
  )
  if (includeAltScreen && this.altScreenActive) {
    termWrite(this.options.stdout, wakeReenterAltBytes(this.mouseTracking))
    resetFramesForAltScreen.call(this)
    this.wholeFrameDue = true
    this.scheduleRender()
  }
}

type RepaintAfterNestedAltScreenCloseReads = Pick<
  ScreenInstance,
  | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger' | 'altScreenActive'
  | 'displayCursor' | 'wholeFrameDue' | 'glassOverlay' | 'scheduleRender'
>

export function repaintAfterNestedAltScreenClose(this: RepaintAfterNestedAltScreenCloseReads): void {
  if (!this.altScreenActive) return
  resetFramesForAltScreen.call(this)
  this.wholeFrameDue = true
  this.scheduleRender()
}

export function armAltScreenTakeover(this: Pick<ScreenInstance, 'ledger' | 'wholeFrameDue'>): void {
  this.wholeFrameDue = true;
  this.ledger.contaminate('takeover')
}

export function armAltScreenEntry(this: Pick<ScreenInstance, 'pendingAltEntry' | 'ledger'>, bytes: string): void {
  this.pendingAltEntry = bytes
  this.ledger.contaminate('takeover')
}

type ForceRedrawReads = Pick<
  ScreenInstance,
  | 'options' | 'isTTY' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger'
  | 'isUnmounted' | 'isPaused' | 'altScreenActive' | 'displayCursor' | 'wholeFrameDue' | 'glassOverlay' | 'onRender'
>

export function forceRedraw(this: ForceRedrawReads): void {
  if (!this.isTTY || this.isUnmounted || this.isPaused) return
  if (this.altScreenActive) {
    resetFramesForAltScreen.call(this)
    this.wholeFrameDue = true
  } else {
    termWrite(this.options.stdout, ERASE_SCREEN + CURSOR_HOME)
    repaintMainScreen.call(this)
  }
  this.ledger.contaminate('force-redraw')
  this.onRender()
}

type RepaintAltScreenReads = Pick<
  ScreenInstance,
  | 'isTTY' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger' | 'isUnmounted'
  | 'isPaused' | 'altScreenActive' | 'displayCursor' | 'wholeFrameDue' | 'glassOverlay' | 'onRender' | 'forceRedraw'
>

export function repaintAltScreen(this: RepaintAltScreenReads): void {
  if (!this.isTTY || this.isUnmounted || this.isPaused) return
  if (!this.altScreenActive) {
    this.forceRedraw()
    return
  }
  resetFramesForAltScreen.call(this)
  this.wholeFrameDue = true
  this.onRender()
}

type OverwriteScreenReads = Pick<
  ScreenInstance,
  | 'isUnmounted' | 'altScreenActive' | 'wholeFrameDue' | 'wholeFrameAt' | 'overwriteTimer' | 'scheduleRender' | 'overwriteScreen'
>

export function overwriteScreen(this: OverwriteScreenReads): void {
  if (!this.altScreenActive || this.isUnmounted || this.overwriteTimer !== null) return
  const wait = OVERWRITE_MIN_GAP_MS - (performance.now() - this.wholeFrameAt)
  if (wait > 0) {
    this.overwriteTimer = startTimeout(() => {
      this.overwriteTimer = null
      this.overwriteScreen()
    }, wait)
    this.overwriteTimer.unref?.()
    return
  }
  this.wholeFrameDue = true
  this.scheduleRender()
}

type RepaintReads = Pick<
  ScreenInstance,
  | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger' | 'altScreenActive'
  | 'displayCursor' | 'glassOverlay' | 'onRender'
>

export function repaint(this: RepaintReads): void {
  if (this.altScreenActive) {
    resetFramesForAltScreen.call(this)
  } else {
    repaintMainScreen.call(this)
    this.ledger.contaminate('blank-reset')
  }
  this.onRender()
}

export function pause(this: Pick<ScreenInstance, 'options' | 'isPaused' | 'onRender'>): void {
  drainUnsettledQueries.call(this)
  reconciler.flushSyncWork()
  this.onRender()
  this.isPaused = true
}

export function resume(this: Pick<ScreenInstance, 'isPaused' | 'onRender'>): void {
  this.isPaused = false
  this.onRender()
}
