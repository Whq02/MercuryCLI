// ============================================================================
//  src/utils/runtime/win32Console.ts — the boot-time Windows console UTF-8
//  seam.
//
//  WHY: Mercury's frame writer delivers via the loss-proof fd path
//  (src/ink/session/delivery.ts writeAllSync → fs.writeSync). On win32 a raw
//  fd write is WriteFile on the console handle, and the console DECODES those
//  bytes with its OUTPUT codepage — the legacy default (CP437/CP850) renders
//  every multi-byte UTF-8 glyph as mojibake (`ΓöÇ` for `─`, `Γöé` for `│`).
//  The stream path (libuv tty → WriteConsoleW) is immune, but the fd path IS
//  the delivery law (stale-paint ghost class) — the codepage is the fix,
//  never a write-path swap. `chcp 65001` sets BOTH console codepages
//  (SetConsoleCP + SetConsoleOutputCP). The OUTPUT page is the load-bearing
//  half; typed input already arrived as clean UTF-8 at every console
//  codepage on the field box (TASK-014 W1), so input is a side effect here,
//  not a promise.
//
//  SHAPE (the OSC 11/111 house discipline, mirrored):
//    · decide — pure, injectable, provable off-win32: engage only on
//      win32 + TTY stdout + not opted out (`MERCURY_WIN32_UTF8=0`).
//    · engage ONCE at the cli.tsx entry seam (after the zero-import
//      --version fast-path, before any frame paint / route dispatch).
//    · query the previous codepage first; already-65001 (e.g. the release
//      mercury.cmd pre-set it, or the operator runs a UTF-8 console) ⇒
//      query-only no-op — nothing changed, nothing to restore.
//    · exit-restore EXACTLY ONCE, and only when THIS process changed the
//      codepage AND the previous value parsed. A parse failure (localized
//      `chcp` output that carries no trailing number) still sets 65001 but
//      DELIBERATELY skips the restore — restoring blind is worse than
//      leaving a working UTF-8 console (recorded decision).
//    · every syscall failure is a silent no-op: the console simply stays as
//      it was (the exact pre-hotfix behavior) — boot is never blocked.
//
//  The launcher-level `chcp 65001 >nul` in mercury.cmd (and the PS1
//  [Console]::*Encoding lines) deliberately do NOT restore: batch parsing of
//  localized `chcp` output is locale-fragile, and a console tab starts fresh
//  at the profile codepage anyway. This module is the restore owner for the
//  path it changes.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../subprocessEnv.js'
import { join } from 'node:path'

export const UTF8_CODEPAGE = 65001

export type Win32Utf8Decision =
  | { engage: false; reason: 'not-win32' | 'no-tty' | 'opted-out' | 'launcher-preset' }
  | { engage: true }

/** Pure decision core — zero I/O, provable on any platform. */
export function decideWin32ConsoleUtf8(
  platform: string,
  stdoutIsTTY: boolean,
  env: Record<string, string | undefined>,
): Win32Utf8Decision {
  if (platform !== 'win32') return { engage: false, reason: 'not-win32' }
  if (!stdoutIsTTY) return { engage: false, reason: 'no-tty' }
  if (env.MERCURY_WIN32_UTF8 === '0') return { engage: false, reason: 'opted-out' }
  // The release launchers set the marker after their own
  // successful chcp/SetConsoleCP — the console is already 65001, so even the
  // query spawn is dead weight (one chcp.com per boot on the HDD class).
  // Nothing was changed by THIS process ⇒ nothing to restore, same as the
  // inherited-65001 query-only no-op this replaces.
  if (env.MERCURY_WIN32_UTF8_PRESET === '1') return { engage: false, reason: 'launcher-preset' }
  return { engage: true }
}

/**
 * Parse a codepage number from `chcp` output. The text is LOCALIZED
 * ("Active code page: 437" · "Aktive Codepage: 850." · "Página de códigos
 * activa: 850") — the trailing integer is the only stable part.
 */
export function parseChcpCodepage(output: string | null): number | null {
  if (output === null) return null
  const m = /(\d+)\D*$/.exec(output.trim())
  if (!m) return null
  const cp = Number(m[1])
  return Number.isFinite(cp) && cp > 0 ? cp : null
}

/** Injectable syscall seam — provers drive engage/restore without a real
 *  Windows console. `chcp(arg)` returns stdout, or null on any failure. */
export interface Win32ConsoleSyscalls {
  chcp: (arg?: string) => string | null
}

/**
 * The chcp spawn shape, pure and exported so the prover can pin it.
 *
 * windowsHide MUST stay false. `windowsHide: true` is CREATE_NO_WINDOW,
 * which gives chcp.com its OWN hidden console: the codepage set lands on
 * that throwaway console, the child's stdout still reads "…: 65001", and
 * the seam reported success while the real console stayed at the box
 * default — the whole product painted as mojibake (TASK-014 W1, five
 * independent finders; FN-012's kernel32 A/B proved the flag is the
 * difference). The engage gate requires a TTY, so this process owns a
 * console and the child ATTACHES to it — no extra window is created, which
 * is the only thing windowsHide was buying.
 */
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
      // child-env law: the scrubbed env rides in the built options above.
      const r = spawnSync(exe, arg === undefined ? [] : [arg], options)
      if (r.error || r.status !== 0) return null
      return r.stdout ?? ''
    } catch {
      return null
    }
  },
}

export interface Win32Utf8Outcome {
  /** the decision engaged (win32 + TTY + not opted out) */
  engaged: boolean
  /** the codepage found before any change (null = query failed/unparseable) */
  previous: number | null
  /** THIS process changed the console codepage to 65001 */
  changed: boolean
  /** an exit restore to `previous` is armed (implies changed + previous known) */
  restoreArmed: boolean
}

let outcome: Win32Utf8Outcome | null = null
/** Exactly-once exit latch (the oasisBg exitRestored shape). */
let restored = false

/**
 * THE seam entry — idempotent; the first call decides and (when engaged)
 * performs the codepage set + arms the exactly-once exit restore.
 */
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
    // already UTF-8 (launcher pre-set, or a UTF-8 profile) — query-only no-op
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

/** THE exit restoration — exactly-once; a no-op unless this process changed
 *  the codepage away from a known previous value. Sync (spawnSync) so it
 *  completes inside a process 'exit' handler. */
export function restoreWin32ConsoleNow(syscalls: Win32ConsoleSyscalls = defaultSyscalls): void {
  if (restored) return
  if (!outcome || !outcome.restoreArmed || outcome.previous === null) return
  restored = true
  syscalls.chcp(String(outcome.previous))
}

/** Test-only: reset the owner between cases. */
export function _resetWin32ConsoleForTest(): void {
  outcome = null
  restored = false
}
