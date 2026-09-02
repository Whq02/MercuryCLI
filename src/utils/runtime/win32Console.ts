import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../subprocessEnv.js'
import { join } from 'node:path'

export const UTF8_CODEPAGE = 65001

export type Win32Utf8Decision =
  | { engage: false; reason: 'not-win32' | 'no-tty' | 'opted-out' | 'launcher-preset' }
  | { engage: true }

export function decideWin32ConsoleUtf8(
  platform: string,
  stdoutIsTTY: boolean,
  env: Record<string, string | undefined>,
): Win32Utf8Decision {
  if (platform !== 'win32') return { engage: false, reason: 'not-win32' }
  if (!stdoutIsTTY) return { engage: false, reason: 'no-tty' }
  if (env.MERCURY_WIN32_UTF8 === '0') return { engage: false, reason: 'opted-out' }
  if (env.MERCURY_WIN32_UTF8_PRESET === '1') return { engage: false, reason: 'launcher-preset' }
  return { engage: true }
}

export function parseChcpCodepage(output: string | null): number | null {
  if (output === null) return null
  const m = /(\d+)\D*$/.exec(output.trim())
  if (!m) return null
  const cp = Number(m[1])
  return Number.isFinite(cp) && cp > 0 ? cp : null
}

export interface Win32ConsoleSyscalls {
  chcp: (arg?: string) => string | null
}

export function chcpSpawnShape(env: Record<string, string | undefined> = process.env): {
  exe: string
  options: { encoding: 'utf8'; timeout: number; windowsHide: false; env: NodeJS.ProcessEnv }
} {
  return {
    exe: join(env.SystemRoot || 'C:\\Windows', 'System32', 'chcp.com'),
    options: { encoding: 'utf8', timeout: 5_000, windowsHide: false, env: { ...subprocessEnv() } },
  }
}

const defaultSyscalls: Win32ConsoleSyscalls = {
  chcp: arg => {
    try {
      const { exe, options } = chcpSpawnShape()
      const r = spawnSync(exe, arg === undefined ? [] : [arg], options)
      if (r.error || r.status !== 0) return null
      return r.stdout ?? ''
    } catch {
      return null
    }
  },
}

export interface Win32Utf8Outcome {
  engaged: boolean
  previous: number | null
  changed: boolean
  restoreArmed: boolean
}

let outcome: Win32Utf8Outcome | null = null
let restored = false

export function ensureWin32ConsoleUtf8(
  syscalls: Win32ConsoleSyscalls = defaultSyscalls,
  probe: {
    platform?: string
    stdoutIsTTY?: boolean
    env?: Record<string, string | undefined>
    registerExit?: (fn: () => void) => void
  } = {},
): Win32Utf8Outcome {
  if (outcome) return outcome
  const decision = decideWin32ConsoleUtf8(
    probe.platform ?? process.platform,
    probe.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
    probe.env ?? process.env,
  )
  if (!decision.engage) {
    outcome = { engaged: false, previous: null, changed: false, restoreArmed: false }
    return outcome
  }
  const previous = parseChcpCodepage(syscalls.chcp())
  if (previous === UTF8_CODEPAGE) {
    outcome = { engaged: true, previous, changed: false, restoreArmed: false }
    return outcome
  }
  const set = syscalls.chcp(String(UTF8_CODEPAGE))
  const changed = parseChcpCodepage(set) === UTF8_CODEPAGE
  const restoreArmed = changed && previous !== null
  if (restoreArmed) {
    const registerExit = probe.registerExit ?? ((fn: () => void) => process.once('exit', fn))
    registerExit(() => restoreWin32ConsoleNow(syscalls))
  }
  outcome = { engaged: true, previous, changed, restoreArmed }
  return outcome
}

export function restoreWin32ConsoleNow(syscalls: Win32ConsoleSyscalls = defaultSyscalls): void {
  if (restored) return
  if (!outcome || !outcome.restoreArmed || outcome.previous === null) return
  restored = true
  syscalls.chcp(String(outcome.previous))
}

export function _resetWin32ConsoleForTest(): void {
  outcome = null
  restored = false
}
