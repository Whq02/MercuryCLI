#!/usr/bin/env bun
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

const watchdog = setTimeout(() => {
  console.log('\nFAIL — the hook run wedged past 60s (the pipe-holding orphan out-waited the settle)')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const { execCommandHook } = await import('../../src/utils/hooks/execution.ts')

const pidFile = join(SCRATCH, 'sleeper.pid')
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

try {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (Number.isFinite(pid) && pid > 1) {
      try {
        process.kill(pid, 'SIGKILL')
        console.log(`  fixture sleeper ${pid} reaped`)
      } catch {
      }
    }
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-hook-pipe-settle: ALL GREEN' : `\nprove-hook-pipe-settle: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
