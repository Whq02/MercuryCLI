#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(tmpdir(), 'liveness-eperm-'))
delete process.env.MERCURY_HOME
process.env.MERCURY_CONFIG_DIR = SCRATCH

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)

const { isProcessRunning } = await import('../../src/utils/genericProcessUtils.ts')
const { countConcurrentSessions } = await import('../../src/utils/concurrentSessions.ts')

const probe = (pid: number): string => {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return String((error as NodeJS.ErrnoException).code)
  }
}

section('§1 a process that exists but may not be signalled is running; one that does not exist is not')
{
  check('this very process is running', isProcessRunning(process.pid))
  check('a pid no process holds is not running', !isProcessRunning(2 ** 22 + 12345) && probe(2 ** 22 + 12345) === 'ESRCH', probe(2 ** 22 + 12345))
  check('pid 0 and 1 are never counted', !isProcessRunning(0) && !isProcessRunning(1))
  if (process.platform === 'win32') {
    check('the Windows System process (pid 4) answers EPERM to a signal-0 probe from a normal user', probe(4) === 'EPERM' || probe(4) === 'alive', probe(4))
    check('…and is running (it is there; only the signal is refused)', isProcessRunning(4))
  } else {
    console.log('  [skip] no always-present protected pid on this host')
  }
}

section('§2 the session registry keeps the record of a live process it may not signal')
{
  if (process.platform !== 'win32') {
    console.log('  [skip] the System process is the Windows fixture')
  } else {
    const dir = join(SCRATCH, 'sessions')
    mkdirSync(dir, { recursive: true })
    const protectedRecord = join(dir, '4.json')
    const deadRecord = join(dir, `${2 ** 22 + 12345}.json`)
    writeFileSync(protectedRecord, JSON.stringify({ pid: 4, sessionId: 'sid-protected', cwd: SCRATCH, startedAt: 1, kind: 'interactive' }))
    writeFileSync(deadRecord, JSON.stringify({ pid: 2 ** 22 + 12345, sessionId: 'sid-dead', cwd: SCRATCH, startedAt: 1, kind: 'interactive' }))
    const live = await countConcurrentSessions()
    check('the protected live process counts as a concurrent session', live === 1, String(live))
    check('its record stays', existsSync(protectedRecord))
    check('the dead process\'s record is swept', !existsSync(deadRecord))
  }
}

removeScratch(SCRATCH)
console.log(failures === 0 ? '\nPASS prove-process-liveness-eperm' : `\nFAIL prove-process-liveness-eperm (${failures} failure(s))`)
process.exit(failures === 0 ? 0 : 1)
