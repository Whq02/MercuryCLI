#!/usr/bin/env bun
// prove-win32-console-close-cleanup — closing the console window must not
// orphan the operator's shell command (field card FC-024). Two mechanisms
// compounded on win32: the Bash provider set detached:true on EVERY platform
// (putting the tool's shell outside the closing console's kill set), and the
// SIGHUP arm of graceful shutdown was fenced to non-win32 (Node DOES deliver
// SIGHUP on a Windows console close). Structural pins — the live WM_CLOSE
// leg is Windows-box work.
//
//   §1 the provider detaches POSIX-only (call-shaped, comment-blind).
//   §2 the SIGHUP arm is registered on win32 too; the descriptor-revocation
//      orphan check stays POSIX-gated (macOS semantics).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

section('§1 THE PROVIDER DETACH')
{
  const provider = src('src/utils/shell/bashProvider.ts')
  // Call-shaped: the detached VALUE must be platform-keyed, not `true`.
  const line = provider.split('\n').find(l => /^\s*detached:/.test(l)) ?? ''
  check(
    "detached is platform-keyed, never a bare `true` (FC-024)",
    /detached:\s*getPlatform\(\)\s*!==\s*'windows'/.test(line),
    JSON.stringify(line.trim()),
  )
}

section('§2 THE SIGHUP ARM')
{
  const shutdown = src('src/utils/gracefulShutdown.ts')
  const sighupAt = shutdown.indexOf("process.on('SIGHUP'")
  check('a SIGHUP arm exists', sighupAt !== -1)
  const win32Fence = shutdown.indexOf("if (process.platform !== 'win32')")
  check(
    'the SIGHUP arm sits OUTSIDE the non-win32 fence (console close = SIGHUP on Windows)',
    sighupAt !== -1 && (win32Fence === -1 || sighupAt < win32Fence),
    `sighup@${sighupAt} fence@${win32Fence}`,
  )
  const orphanAt = shutdown.indexOf('orphanCheck')
  check(
    'the descriptor-revocation orphan check stays POSIX-gated',
    orphanAt !== -1 && win32Fence !== -1 && orphanAt > win32Fence,
    `orphan@${orphanAt} fence@${win32Fence}`,
  )
}

section('§3 THE CTRL+BREAK ARM (FN-015 rank 21)')
{
  // Windows delivers CTRL_BREAK_EVENT as SIGBREAK — the reflex reach when a
  // long turn looks hung and Ctrl+C seems ignored. With no listener, no
  // JavaScript runs at all: the terminal stays on the alternate screen with
  // raw mode armed, the cleanup registry and exit-cliff drains never run,
  // no shutdown record and no resume hint. Both signal owners register it:
  // the session's graceful shutdown (outside the non-win32 fence, beside
  // SIGHUP) and the daemon's own signal set. Listenable on every platform,
  // delivered only on win32 — the live press is Windows-box work.
  const shutdown = src('src/utils/gracefulShutdown.ts')
  const breakAt = shutdown.indexOf("process.on('SIGBREAK'")
  check('the session shutdown registers a SIGBREAK arm', breakAt !== -1)
  const win32Fence = shutdown.indexOf("if (process.platform !== 'win32')")
  check(
    'the SIGBREAK arm sits OUTSIDE the non-win32 fence, beside SIGHUP',
    breakAt !== -1 && (win32Fence === -1 || breakAt < win32Fence),
    `sigbreak@${breakAt} fence@${win32Fence}`,
  )
  check(
    'the arm rides the same bounded shutdown as the console close (128 + SIGBREAK 21)',
    /process\.on\('SIGBREAK', \(\) => \{[\s\S]{0,200}gracefulShutdownSync\(149\)/.test(shutdown),
  )
  const daemon = src('src/daemon/main.ts')
  check(
    "the daemon's own signal set carries SIGBREAK too (it skips the session arms)",
    /process\.on\('SIGBREAK', \(\) => shutdown\('SIGBREAK'\)\)/.test(daemon),
  )
  // Live registration census, in a child so the handlers never arm here.
  const { spawnSync } = await import('node:child_process')
  const modulePath = join(import.meta.dir, '../../src/utils/gracefulShutdown.ts')
  const probe = [
    "globalThis.MACRO = { VERSION: '1.0.0' }",
    `const { setupGracefulShutdown } = await import(${JSON.stringify(modulePath)})`,
    'setupGracefulShutdown()',
    "console.log(JSON.stringify({ sigbreak: process.listenerCount('SIGBREAK'), sighup: process.listenerCount('SIGHUP') }))",
    'process.exit(0)',
  ].join('\n')
  const run = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR ?? '' } })
  const lastLine = (run.stdout ?? '').trim().split('\n').pop() ?? ''
  let counts: { sigbreak?: number; sighup?: number } = {}
  try {
    counts = JSON.parse(lastLine) as { sigbreak?: number; sighup?: number }
  } catch {
    /* reported below */
  }
  check(
    'setupGracefulShutdown installs exactly one SIGBREAK listener (live census, child process)',
    run.status === 0 && counts.sigbreak === 1,
    `status=${run.status} stdout=${JSON.stringify(lastLine)} stderr=${JSON.stringify((run.stderr ?? '').slice(-300))}`,
  )
  // The exit-hook library keeps a SIGHUP listener of its own, so that count
  // is at least one; SIGBREAK is exactly one — the library does not list it.
  check('…beside the SIGHUP listener(s)', (counts.sighup ?? 0) >= 1, JSON.stringify(counts))
}

if (failures > 0) {
  console.error(`\nprove-win32-console-close-cleanup: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-win32-console-close-cleanup: all green')
