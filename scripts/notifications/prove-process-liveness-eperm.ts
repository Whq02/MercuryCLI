#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
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

const { isProcessRunning } = await import('../../src/platform/processes/processLiveness.ts')

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
  check('this very process is running', isProcessRunning(process.pid), 'isProcessRunning in src/platform/processes/processLiveness.ts must return true when process.kill(pid, 0) succeeds')
  check('a pid no process holds is not running', !isProcessRunning(2 ** 22 + 12345) && probe(2 ** 22 + 12345) === 'ESRCH', `${probe(2 ** 22 + 12345)}; isProcessRunning in src/platform/processes/processLiveness.ts must return false for any error other than EPERM (if the probe is not ESRCH, the fixture pid is held on this host)`)
  check('pid 0 and 1 are never counted', !isProcessRunning(0) && !isProcessRunning(1), 'isProcessRunning in src/platform/processes/processLiveness.ts must return false for pid <= 1')
  if (process.platform === 'win32') {
    check('the Windows System process (pid 4) answers EPERM to a signal-0 probe from a normal user', probe(4) === 'EPERM' || probe(4) === 'alive', `${probe(4)}; this is the host fixture: pid 4 is expected to be present and refuse the signal`)
    check('…and is running (it is there; only the signal is refused)', isProcessRunning(4), 'isProcessRunning in src/platform/processes/processLiveness.ts must treat an EPERM from process.kill(pid, 0) as running')
  } else {
    console.log('  [skip] no always-present protected pid on this host')
  }
}

removeScratch(SCRATCH)
console.log(failures === 0 ? '\nPASS prove-process-liveness-eperm' : `\nFAIL prove-process-liveness-eperm (${failures} failure(s))`)
process.exit(failures === 0 ? 0 : 1)
