import { logForDebugging } from '../platform/logs/debugLog.js'
import { passedOver } from '../platform/errors/passedOver.js'
import { toPosixSeparators } from '../platform/host-os/paths.js'

const MAX_TRACKED_WARNING_KEYS = 1000

const warningCounts = new Map<string, number>()
let registeredListener: ((warning: Error) => void) | null = null

const BUILD_DIRECTORY_SEGMENTS = ['/build-ant/', '/build-external/', '/build-external-native/', '/build-ant-native/']

function isDevelopmentMode(): boolean {
  if (process.env.NODE_ENV === 'development') return true
  const candidates = [process.argv[1], process.execPath || process.argv[0]]
  for (const candidate of candidates) {
    if (!candidate) continue
    const normalized = toPosixSeparators(candidate)
    if (BUILD_DIRECTORY_SEGMENTS.some(segment => normalized.includes(segment))) return true
  }
  return false
}

const INTERNAL_WARNING_PATTERNS: RegExp[] = [
  /MaxListenersExceededWarning.*AbortSignal/,
  /MaxListenersExceededWarning.*EventTarget/,
]

function handleWarning(warning: Error): void {
  try {
    const key = `${warning.name}:${warning.message.slice(0, 50)}`
    const existing = warningCounts.get(key)
    if (existing !== undefined || warningCounts.size < MAX_TRACKED_WARNING_KEYS) {
      warningCounts.set(key, (existing ?? 0) + 1)
    }
    const combined = `${warning.name} ${warning.message}`
    const isInternal = INTERNAL_WARNING_PATTERNS.some(pattern => pattern.test(combined))
    {
      logForDebugging(
        `${isInternal ? '[internal warning]' : '[warning]'} ${warning.name}: ${warning.message}`,
        { level: 'warn' },
      )
    }
  } catch (error) {
    passedOver(error)
  }
}

export function initializeWarningHandler(): void {
  if (registeredListener !== null && process.listeners('warning').includes(registeredListener)) return
  if (!isDevelopmentMode()) process.removeAllListeners('warning')
  process.on('warning', handleWarning)
  registeredListener = handleWarning
}
