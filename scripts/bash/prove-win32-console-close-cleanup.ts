#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  const shown = cond || !hint ? detail : detail ? detail + ' | to fix: ' + hint : hint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)



section('§3 THE CTRL+BREAK ARM (FN-015 rank 21)')
{
  const { spawnSync } = await import('node:child_process')
  const modulePath = join(import.meta.dir, '../../src/platform/processes/gracefulShutdown.ts')
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
    'setupGracefulShutdown in src/platform/processes/gracefulShutdown.ts must register process.on SIGBREAK exactly once (beside SIGHUP, in the branch that runs when the process is not a daemon subcommand); a nonzero status or a stderr tail means the child failed before it printed its census',
  )
  check('…beside the SIGHUP listener(s)', (counts.sighup ?? 0) >= 1, JSON.stringify(counts), 'setupGracefulShutdown in src/platform/processes/gracefulShutdown.ts must still register a SIGHUP listener; empty counts mean the child printed no census (see the check above for its status and stderr)')
}

if (failures > 0) {
  console.error(`\nprove-win32-console-close-cleanup: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-win32-console-close-cleanup: all green')
