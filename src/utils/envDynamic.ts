import { stat } from 'node:fs/promises'

import { memoize } from 'lodash-es'

import { env, JETBRAINS_IDES } from './env.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getAncestorCommandsAsync } from './genericProcessUtils.js'


const getIsDocker = memoize(async (): Promise<boolean> => {
  if (process.platform !== 'linux') return false
  const result = await execFileNoThrow('test', ['-f', '/.dockerenv'])
  return result.code === 0
})

function getIsBubblewrapSandbox(): boolean {
  return false
}

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

function isMuslEnvironment(): boolean {
  if (process.platform !== 'linux') return false
  return muslProbeResult
}


let jetBrainsIdeCache: { value: string | null } | null = null

function isJetBrainsTerminal(): boolean {
  return process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
}

async function detectJetBrainsIde(): Promise<string | null> {
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
  jetBrainsIdeCache = { value: detected }
  return detected
}

export async function getTerminalWithJetBrainsDetectionAsync(): Promise<string | null> {
  if (isJetBrainsTerminal()) {
    if (process.platform === 'darwin') return env.terminal
    const specific = await detectJetBrainsIde()
    return specific ?? 'pycharm'
  }
  return env.terminal
}

export function getTerminalWithJetBrainsDetection(): string | null {
  if (isJetBrainsTerminal()) {
    if (process.platform === 'darwin') return env.terminal
    return jetBrainsIdeCache?.value ?? 'pycharm'
  }
  return env.terminal
}

export async function initJetBrainsDetection(): Promise<void> {
  await detectJetBrainsIde()
}

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
