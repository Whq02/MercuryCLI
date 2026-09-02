#!/usr/bin/env bun
// ============================================================================
//  scripts/hooks/prove-hook-pipe-settle.ts — a hook whose forked child holds
//  the pipes can no longer wedge the run (field w4-f08-01).
//
//  THE SHAPE: execCommandHook's settle raced async-detection · 'close' ·
//  process-error — and 'close' fires only after BOTH stdio streams end. A
//  hook that exits while a forked child still holds the inherited pipes
//  (`sleep 300 &` on any POSIX shell; the MSYS fork on win32) left the race
//  with no settled member: the process was gone, the streams never ended,
//  and the run out-waited every timeout that had already fired. The bounded
//  member ('exit' + a grace, then stream destroy) settles it with
//  everything read so far.
//
//  The fixture backgrounds a marked sleeper, writes its pid to a file, and
//  exits 0 — the prover asserts the run settles inside the grace with the
//  verdict line and status 0, then reaps the sleeper BY ITS EXACT PID (the
//  fixture-children law).
//
//  Run:  ~/.bun/bin/bun run scripts/hooks/prove-hook-pipe-settle.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'hook-pipe-settle-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// A wedged pre-fix run holds ~the sleeper's whole 300s — the watchdog turns
// that into a loud red instead of a hung gate.
const watchdog = setTimeout(() => {
  console.log('\nFAIL — the hook run wedged past 60s (the pipe-holding orphan out-waited the settle)')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const { execCommandHook } = await import('../../src/utils/hooks/execution.ts')

const pidFile = join(SCRATCH, 'sleeper.pid')
// The child: speak the verdict, background a pipe-holding sleeper, record
// its pid, and EXIT CLEAN. The sleeper inherits stdout/stderr and holds
// them long past every bound under proof.
const command = `echo the-verdict-line; sleep 300 & echo $! > ${JSON.stringify(pidFile)}; exit 0`

const started = Date.now()
const result = await execCommandHook(
  { type: 'command', command } as never,
  'Stop' as never,
  'pipe-settle-probe',
  JSON.stringify({ hook_event_name: 'Stop' }),
  new AbortController().signal,
  'hook-pipe-settle-1',
)
const wallMs = Date.now() - started

console.log('§1 — the bounded settle')
check('the run settled inside the bounded grace (never the sleeper’s 300s)', wallMs < 30_000, `${wallMs}ms`)
check('status is the process’s OWN exit code (0 — nothing invented a failure)', result.status === 0, String(result.status))
check('the buffered stdout survived the bounded settle (the verdict line reached the caller)', result.stdout.includes('the-verdict-line'), JSON.stringify(result.stdout).slice(0, 120))
check('the run is not marked aborted (the process ended on its own; only the pipes were held)', result.aborted !== true)

console.log('§2 — the machinery (source pins)')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'hooks', 'execution.ts'), 'utf8')
  check('the settle race carries the bounded member', src.includes('childExitBoundedPromise,') && src.includes('const childExitBoundedPromise = new Promise'))
  check("the bounded member arms on 'exit' — the process's own end, not the held streams' 'close'", /childExitBoundedPromise[\s\S]{0,400}child\.on\('exit'/.test(src))
  check('after the grace BOTH streams are destroyed (the held pipe cannot hold the run)', src.includes('child.stdout.destroy()') && src.includes('child.stderr.destroy()'))
  check('the grace is named and bounded', src.includes('HOOK_STREAM_SETTLE_GRACE_MS = 2_000'))
  check('the prompt-line filter rides the bounded settle too (the same final-stdout law as the close path)', (src.match(/processedPromptLines\.size === 0/g) ?? []).length >= 2)
}

// Fixture hygiene: reap the sleeper by its EXACT pid, then the scratch.
try {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (Number.isFinite(pid) && pid > 1) {
      try {
        process.kill(pid, 'SIGKILL')
        console.log(`  fixture sleeper ${pid} reaped`)
      } catch {
        // already gone
      }
    }
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-hook-pipe-settle: ALL GREEN' : `\nprove-hook-pipe-settle: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
