#!/usr/bin/env bun
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
  }
  check(
    'setupGracefulShutdown installs exactly one SIGBREAK listener (live census, child process)',
    run.status === 0 && counts.sigbreak === 1,
    `status=${run.status} stdout=${JSON.stringify(lastLine)} stderr=${JSON.stringify((run.stderr ?? '').slice(-300))}`,
  )
  check('…beside the SIGHUP listener(s)', (counts.sighup ?? 0) >= 1, JSON.stringify(counts))
}

if (failures > 0) {
  console.error(`\nprove-win32-console-close-cleanup: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-win32-console-close-cleanup: all green')
