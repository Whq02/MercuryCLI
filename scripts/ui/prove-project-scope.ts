#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionListing } from '../../src/sessions/transcripts/transcriptEntries.js'
import { isProjectSession, partitionByProject } from '../../src/screen/session-chooser/sessionFilter.js'
import {
  isSessionCleared,
  markSessionCleared,
  resetClearedSessionsMemo,
} from '../../src/sessions/transcripts/clearedSessions.js'

let failures = 0
let failureWhere = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = !cond && failureWhere ? (detail ? `${detail}; ${failureWhere}` : failureWhere) : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const log = (projectPath?: string) => ({ projectPath }) as unknown as SessionListing

console.log('============================================================')
console.log(' project-scoped sessions — proof')
console.log('============================================================')

section('1. isProjectSession semantics')
{
  failureWhere = 'fix isProjectSession in src/screen/session-chooser/sessionFilter.ts'
  const root = '/Users/op/dev/orchard'
  check('exact root ⇒ in', isProjectSession(log('/Users/op/dev/orchard'), root))
  check('nested cwd ⇒ in', isProjectSession(log('/Users/op/dev/orchard/src/utils'), root))
  check('sibling repo ⇒ out', !isProjectSession(log('/Users/op/dev/other'), root))
  check(
    'prefix-collision repo ⇒ out (orchard-src is not orchard)',
    !isProjectSession(log('/Users/op/dev/orchard-src'), root),
  )
  check('trailing slash on cwd ⇒ in', isProjectSession(log('/Users/op/dev/orchard/'), root))
  check('trailing slash on root ⇒ in', isProjectSession(log('/Users/op/dev/orchard'), root + '/'))
  check('win32 separators ⇒ in', isProjectSession(log('C:\\dev\\orchard\\src'), 'C:\\dev\\orchard'))
  check('UNKNOWN cwd ⇒ kept (never hide real work)', isProjectSession(log(undefined), root))
  check('empty root ⇒ kept (no scope to enforce)', isProjectSession(log('/anywhere'), ''))
}

section('2. partitionByProject')
{
  failureWhere = 'fix partitionByProject in src/screen/session-chooser/sessionFilter.ts'
  const root = '/r/proj'
  const logs = [log('/r/proj'), log('/r/proj/sub'), log('/r/other'), log(undefined)]
  const { inProject, elsewhere } = partitionByProject(logs, root)
  check('splits 3 in / 1 out', inProject.length === 3 && elsewhere.length === 1)
  check('no row dropped', inProject.length + elsewhere.length === logs.length)
}

section('3. the /clear'.concat("'ed-session cache (operator model: cleared = closed on purpose)"))
{
  failureWhere = 'fix isSessionCleared and markSessionCleared in src/sessions/transcripts/clearedSessions.ts'
  const prevHome = process.env.MERCURY_CONFIG_DIR
  const home = mkdtempSync(join(tmpdir(), 'cleared-proof-'))
  process.env.MERCURY_CONFIG_DIR = home
  resetClearedSessionsMemo()
  try {
    check('unknown id ⇒ not cleared', isSessionCleared('never-seen') === false)
    markSessionCleared('sess-x')
    resetClearedSessionsMemo()
    check('marked id reads cleared', isSessionCleared('sess-x') === true)
    check('other ids stay visible', isSessionCleared('sess-y') === false)
    check('null/absent id ⇒ false, never a throw', isSessionCleared(null) === false)
  } finally {
    if (prevHome === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = prevHome
    resetClearedSessionsMemo()
    rmSync(home, { recursive: true, force: true })
  }
}


console.log('\n============================================================')
if (failures) {
  console.log(`❌ PROJECT SCOPE RED — ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ ALL PROJECT-SCOPE PROOFS PASS')
