#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'cleared-mark-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}${ok ? '' : ' | to fix, change markSessionCleared, unmarkSessionCleared or isSessionCleared in src/sessions/transcripts/clearedSessions.ts so the mark of a session id is written, read back and removed'}`)
  if (!ok) failures = 1
}


{
  const cleared = await import('../../src/sessions/transcripts/clearedSessions.ts')
  const id = 'sess-cleared-proof-1'
  t('§2 an unmarked id reads uncleared', cleared.isSessionCleared(id) === false)
  cleared.markSessionCleared(id)
  t('§2 the mark lands and reads back', cleared.isSessionCleared(id) === true)
  cleared.unmarkSessionCleared(id)
  t('§2 the unmark clears it (resume revives honestly)', cleared.isSessionCleared(id) === false)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'CLEARED MARK WIRED: ALL PASS' : 'CLEARED MARK WIRED: RED')
process.exit(failures)
