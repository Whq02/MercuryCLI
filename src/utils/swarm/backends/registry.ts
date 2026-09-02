import { getIsNonInteractiveSession } from '../../../bootstrap/state.js'
import { getPlatform } from '../../platform.js'
import { isInITerm2, isInsideTmuxSync, isIt2CliAvailable, isTmuxAvailable } from './detection.js'
import { createInProcessBackend } from './InProcessBackend.js'
import { getPreferTmuxOverIterm2 } from './it2Setup.js'
import { getTeammateModeFromSnapshot } from './teammateModeSnapshot.js'
import type {
  BackendDetectionResult,
  PaneBackend,
  PaneBackendType,
  TeammateExecutor,
} from './types.js'

/**
 * Backend selection. The two pane backend classes register their
 * constructors here as an import side effect — the registry never imports
 * them statically (the dependency runs the other way; a static import would
 * close a cycle).
 */

type PaneBackendConstructor = new () => PaneBackend

let tmuxBackendCtor: PaneBackendConstructor | null = null
let itermBackendCtor: PaneBackendConstructor | null = null
const backendResetters: Array<() => void> = []

let backendsRegistered = false
let cachedBackend: PaneBackend | null = null
let cachedDetection: BackendDetectionResult | null = null
let cachedPaneExecutor: TeammateExecutor | null = null
let cachedInProcessExecutor: TeammateExecutor | null = null
let inProcessFallbackLatched = false

export function registerTmuxBackend(ctor: PaneBackendConstructor): void {
  tmuxBackendCtor = ctor
}

export function registerITermBackend(ctor: PaneBackendConstructor): void {
  itermBackendCtor = ctor
}

/**
 * Backends may contribute a state-reset callback so that resetting detection
 * also clears their own module-level caches, not just the registry's.
 */
export function registerBackendResetter(fn: () => void): void {
  backendResetters.push(fn)
}

/**
 * Dynamically import both backend modules so their registration side effects
 * run. Idempotent; runs no environment probes and no subprocesses — the
 * correct call when you only need to construct a backend by its recorded
 * type (e.g. killing a pane recorded in the roster).
 */
export async function ensureBackendsRegistered(): Promise<void> {
  if (backendsRegistered) return
  await Promise.all([import('./TmuxBackend.js'), import('./ITermBackend.js')])
  backendsRegistered = true
}

function constructBackend(type: PaneBackendType): PaneBackend {
  const ctor = type === 'tmux' ? tmuxBackendCtor : itermBackendCtor
  if (ctor === null) {
    throw new Error(`Backend ${type} is not registered — import the backend module first`)
  }
  return new ctor()
}

/** Explicit selection: no detection, no caching. */
export function getBackendByType(type: PaneBackendType): PaneBackend {
  return constructBackend(type)
}

/** Platform-specific tmux install guidance; every variant ends with how to start a session. */
function buildTmuxInstallMessage(): string {
  const startLine = 'Then start a session with: tmux new-session -s claude'
  switch (getPlatform()) {
    case 'macos':
      return `Teammate panes need tmux, which is not installed. Install it with: brew install tmux. ${startLine}`
    case 'windows':
      return `Teammate panes need tmux, which requires WSL on Windows. Inside your WSL distribution run: sudo apt install tmux. ${startLine}`
    case 'wsl':
    case 'linux':
      return `Teammate panes need tmux, which is not installed. Install it with: sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora/RHEL). ${startLine}`
    default:
      return `Teammate panes need tmux, which is not installed. Install it with your system's package manager. ${startLine}`
  }
}

/**
 * Detection priority (first match wins, result cached):
 *
 * 1. Inside tmux ⇒ tmux, native — true even when the terminal is iTerm2;
 *    being inside tmux dominates.
 * 2. Inside iTerm2: the prefer-tmux preference skips the iTerm2 attempt
 *    entirely (no it2 probe); else reachable it2 ⇒ iterm2, native; else an
 *    installed tmux ⇒ tmux, non-native, needing it2 setup unless the
 *    preference is set (otherwise the user would be re-prompted every
 *    spawn); else throw naming the it2 install.
 * 3. Neither: installed tmux ⇒ tmux, non-native (external-session mode);
 *    else throw with platform-specific install instructions.
 */
export async function detectAndGetBackend(): Promise<BackendDetectionResult> {
  await ensureBackendsRegistered()
  if (cachedDetection !== null) return cachedDetection

  let result: BackendDetectionResult
  if (isInsideTmuxSync()) {
    result = { backend: constructBackend('tmux'), isNative: true, needsIt2Setup: false }
  } else if (isInITerm2()) {
    const preferTmux = getPreferTmuxOverIterm2()
    if (!preferTmux && (await isIt2CliAvailable())) {
      result = { backend: constructBackend('iterm2'), isNative: true, needsIt2Setup: false }
    } else if (await isTmuxAvailable()) {
      result = {
        backend: constructBackend('tmux'),
        isNative: false,
        needsIt2Setup: !preferTmux,
      }
    } else {
      throw new Error(
        'iTerm2 was detected, but the it2 CLI is not installed. Install it with: pip install it2',
      )
    }
  } else if (await isTmuxAvailable()) {
    result = { backend: constructBackend('tmux'), isNative: false }
  } else {
    throw new Error(buildTmuxInstallMessage())
  }

  cachedBackend = result.backend
  cachedDetection = result
  return result
}

export function getCachedBackend(): PaneBackend | null {
  return cachedBackend
}

export function getCachedDetectionResult(): BackendDetectionResult | null {
  return cachedDetection
}

/**
 * Set by the spawn tool when backend detection deterministically fails, so
 * UI surfaces (banner, teams menu, doctor report) report the mode actually
 * in use. Scoped to flow only, so a mid-session settings change to
 * explicit tmux still takes effect.
 */
export function markInProcessFallback(): void {
  inProcessFallbackLatched = true
}

/**
 * Whether this session runs teammates in-process. A non-interactive
 * (`-p`/print) session always does — pane teammates make no sense without a
 * terminal UI — and that check precedes the mode entirely.
 */
export function isInProcessEnabled(): boolean {
  if (getIsNonInteractiveSession()) return true
  const mode = getTeammateModeFromSnapshot()
  if (mode === 'in-process') return true
  if (mode === 'tmux') return false
  if (inProcessFallbackLatched) return true
  return !isInsideTmuxSync() && !isInITerm2()
}

/** The answer collapsed to the two concrete modes, for UI and flag composition. */
export function getResolvedTeammateMode(): 'in-process' | 'tmux' {
  return isInProcessEnabled() ? 'in-process' : 'tmux'
}

export function getInProcessBackend(): TeammateExecutor {
  if (cachedInProcessExecutor === null) {
    cachedInProcessExecutor = createInProcessBackend()
  }
  return cachedInProcessExecutor
}

/**
 * The executor factory. Preferring in-process returns the cached in-process
 * executor when enabled; otherwise a cached pane executor wrapping the
 * detected backend (detection runs on first use and may therefore throw).
 */
export async function getTeammateExecutor(preferInProcess = false): Promise<TeammateExecutor> {
  if (preferInProcess && isInProcessEnabled()) {
    return getInProcessBackend()
  }
  if (cachedPaneExecutor === null) {
    const detection = await detectAndGetBackend()
    const { createPaneBackendExecutor } = await import('./PaneBackendExecutor.js')
    cachedPaneExecutor = createPaneBackendExecutor(detection.backend)
  }
  return cachedPaneExecutor
}

/**
 * Clears the cached backend, detection result, both executors, the
 * registration flag and the fallback latch, then invokes every registered
 * backend reset callback. Does NOT unregister the backend classes and does
 * not empty the resetter list.
 */
export function resetBackendDetection(): void {
  cachedBackend = null
  cachedDetection = null
  cachedPaneExecutor = null
  cachedInProcessExecutor = null
  backendsRegistered = false
  inProcessFallbackLatched = false
  for (const reset of backendResetters) {
    reset()
  }
}
