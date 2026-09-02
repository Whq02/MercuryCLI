import { logForDebugging } from './debug.js'

/**
 * Installs a process `warning` listener that suppresses Node warnings from
 * end users (silencing the default stderr printer outside development)
 * while counting occurrences and echoing them under the debug flag.
 */

// The counter map is bounded; past the cap an unseen warning is simply
// never tracked (the accepted cost of bounding the map).
const MAX_TRACKED_WARNING_KEYS = 1000

const warningCounts = new Map<string, number>()
let registeredListener: ((warning: Error) => void) | null = null

const BUILD_DIRECTORY_SEGMENTS = ['/build-ant/', '/build-external/', '/build-external-native/', '/build-ant-native/']

function isDevelopmentMode(): boolean {
  if (process.env.NODE_ENV === 'development') return true
  const candidates = [process.argv[1], process.execPath || process.argv[0]]
  for (const candidate of candidates) {
    if (!candidate) continue
    const normalized = process.platform === 'win32' ? candidate.replace(/\\/g, '/') : candidate
    if (BUILD_DIRECTORY_SEGMENTS.some(segment => normalized.includes(segment))) return true
  }
  return false
}

// The shipped internal set: Node's max-listeners warnings for abort
// signals and event targets.
const INTERNAL_WARNING_PATTERNS: RegExp[] = [
  /MaxListenersExceededWarning.*AbortSignal/,
  /MaxListenersExceededWarning.*EventTarget/,
]

function handleWarning(warning: Error): void {
  try {
    const key = `${warning.name}:${warning.message.slice(0, 50)}`
    const existing = warningCounts.get(key)
    // Write the incremented count when the key is already present OR the
    // map is still under the cap; otherwise skip the write entirely.
    if (existing !== undefined || warningCounts.size < MAX_TRACKED_WARNING_KEYS) {
      warningCounts.set(key, (existing ?? 0) + 1)
    }
    const combined = `${warning.name} ${warning.message}`
    const isInternal = INTERNAL_WARNING_PATTERNS.some(pattern => pattern.test(combined))
    {
      logForDebugging(
        `${isInternal ? '[internal warning]' : '[warning]'} ${warning.name}: ${warning.message}`,
        { level: 'warn' as never },
      )
    }
    // In every other case nothing is shown to the user.
  } catch {
    // The handler must never propagate a failure.
  }
}

/**
 * Idempotent by inspection of the process's CURRENT listener list (not a
 * boolean), so an external removeAllListeners is recovered from. Outside
 * development mode every pre-existing warning listener is removed first,
 * silencing Node's default stderr printer.
 */
export function initializeWarningHandler(): void {
  if (registeredListener !== null && process.listeners('warning').includes(registeredListener)) {
    return
  }
  if (!isDevelopmentMode()) {
    process.removeAllListeners('warning')
  }
  registeredListener = handleWarning
  process.on('warning', registeredListener)
}
