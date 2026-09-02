#!/usr/bin/env bun
// ============================================================================
//  prove-cleared-mark-wired — /clear finally records what it cleared.
//
//  The ghost estate (win-triage S12): markSessionCleared had ZERO callers —
//  every downstream 'cleared' surface (the lanes rail's filter, the session
//  tabs, the picker's isCleared) read a mark nothing ever recorded, so a
//  deliberately cleared chat kept being offered as if the operator never
//  closed it. The one writer now fires at /clear's tail (clearFocusedSession,
//  after the born-hop swap and the park).
//
//  §1 the wiring (structural: the tail calls the mark)
//  §2 the store round-trip, driven hermetically
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'cleared-mark-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// §1 the wiring
{
  const hop = readFileSync(join(import.meta.dir, '../../src/services/switchboard/hopIntoSession.ts'), 'utf8')
  t('§1 /clear\'s tail marks the released session', /parkSessionById\(oldSessionId\)[\s\S]{0,600}markSessionCleared\(oldSessionId\)/.test(hop))
}

// §2 the store round-trip
{
  const cleared = await import('../../src/utils/sessionStorage/clearedSessions.ts')
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
