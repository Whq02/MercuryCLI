import { stat } from 'node:fs/promises'

import { memoize } from 'lodash-es'

import { env, JETBRAINS_IDES } from './env.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getAncestorCommandsAsync } from './genericProcessUtils.js'

/**
 * Environment facts that require subprocesses or ancestor-process
 * inspection, kept apart from the static record.
 */

/** Container detection: a test-for-file subprocess on Linux; false elsewhere. */
const getIsDocker = memoize(async (): Promise<boolean> => {
  if (process.platform !== 'linux') return false
  const result = await execFileNoThrow('test', ['-f', '/.dockerenv'])
  return result.code === 0
})

function getIsBubblewrapSandbox(): boolean {
  // Always false:
  // Mercury never runs inside the base bubblewrap sandbox.
  return false
}

// musl libc detection: a fire-and-forget stat of the architecture-specific
// loader path at module load, cached. x64 maps to x86_64 and everything else
// to aarch64 — there is no third branch. (The compile-time short-circuit
// arms are folded in this build; the runtime cache is the only path.)
let muslProbeResult = false
if (process.platform === 'linux') {
  const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  void stat(`/lib/libc.musl-${arch}.so.1`).then(
    () => {
      muslProbeResult = true
    },
    () => {
      muslProbeResult = false
    },
  )
}

/** Synchronous: false on non-Linux, else the cached probe (false until settled). */
function isMuslEnvironment(): boolean {
  if (process.platform !== 'linux') return false
  return muslProbeResult
}

// ---------------------------------------------------------------------------
// Fine-grained JetBrains IDE detection (the ancestor walk)
// ---------------------------------------------------------------------------

let jetBrainsIdeCache: { value: string | null } | null = null

function isJetBrainsTerminal(): boolean {
  return process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
}

async function detectJetBrainsIde(): Promise<string | null> {
  // On macOS bundle identifiers already resolved the specific IDE.
  if (!isJetBrainsTerminal() || process.platform === 'darwin') return null
  if (jetBrainsIdeCache) return jetBrainsIdeCache.value
  let detected: string | null = null
  try {
    const commands = await getAncestorCommandsAsync(process.pid, 10)
    outer: for (const command of commands) {
      const lower = command.toLowerCase()
      for (const ide of JETBRAINS_IDES) {
        if (lower.includes(ide)) {
          detected = ide
          break outer
        }
      }
    }
  } catch {
    detected = null
  }
  // Cache the result, including the negative.
  jetBrainsIdeCache = { value: detected }
  return detected
}

/** The specific IDE, the generic JetBrains fallback, or the static terminal. */
export async function getTerminalWithJetBrainsDetectionAsync(): Promise<string | null> {
  if (isJetBrainsTerminal()) {
    // On macOS the bundle identifier already resolved the specific IDE:
    // the static terminal value is the answer, never the generic fallback.
    if (process.platform === 'darwin') return env.terminal
    const specific = await detectJetBrainsIde()
    // The generic fallback is the family list's first entry.
    return specific ?? 'pycharm'
  }
  return env.terminal
}

/**
 * Synchronous variant: the cached specific value when the walk has settled,
 * else the generic fallback; the static terminal when not under JetBrains
 * (and always on macOS, where the bundle identifier already resolved it).
 */
export function getTerminalWithJetBrainsDetection(): string | null {
  if (isJetBrainsTerminal()) {
    if (process.platform === 'darwin') return env.terminal
    return jetBrainsIdeCache?.value ?? 'pycharm'
  }
  return env.terminal
}

/** Await early in startup so the synchronous accessor is accurate afterwards. */
export async function initJetBrainsDetection(): Promise<void> {
  await detectJetBrainsIde()
}

/**
 * The static facts with the terminal field overridden by the synchronous
 * JetBrains-aware value. The override is evaluated ONCE, at module load —
 * a value, not a getter — so a later initialiser refines what the
 * synchronous accessor returns but never changes this record's field.
 */
export const envDynamic = {
  ...env,
  terminal: getTerminalWithJetBrainsDetection(),
  getIsDocker,
  getIsBubblewrapSandbox,
  isMuslEnvironment,
  getTerminalWithJetBrainsDetectionAsync,
  getTerminalWithJetBrainsDetection,
  initJetBrainsDetection,
}
