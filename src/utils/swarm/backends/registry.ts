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

export function registerBackendResetter(fn: () => void): void {
  backendResetters.push(fn)
}

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

export function getBackendByType(type: PaneBackendType): PaneBackend {
  return constructBackend(type)
}

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

export function markInProcessFallback(): void {
  inProcessFallbackLatched = true
}

export function isInProcessEnabled(): boolean {
  if (getIsNonInteractiveSession()) return true
  const mode = getTeammateModeFromSnapshot()
  if (mode === 'in-process') return true
  if (mode === 'tmux') return false
  if (inProcessFallbackLatched) return true
  return !isInsideTmuxSync() && !isInITerm2()
}

export function getResolvedTeammateMode(): 'in-process' | 'tmux' {
  return isInProcessEnabled() ? 'in-process' : 'tmux'
}

export function getInProcessBackend(): TeammateExecutor {
  if (cachedInProcessExecutor === null) {
    cachedInProcessExecutor = createInProcessBackend()
  }
  return cachedInProcessExecutor
}

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
