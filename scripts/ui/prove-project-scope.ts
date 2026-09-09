#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogOption } from '../../src/types/logs.js'
import { isProjectSession, partitionByProject } from '../../src/utils/sessionFilter.js'
import {
  isSessionCleared,
  markSessionCleared,
  resetClearedSessionsMemo,
} from '../../src/utils/sessionStorage/clearedSessions.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')
const log = (projectPath?: string) => ({ projectPath }) as unknown as LogOption

console.log('============================================================')
console.log(' project-scoped sessions — proof')
console.log('============================================================')

section('1. isProjectSession semantics')
{
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
  const root = '/r/proj'
  const logs = [log('/r/proj'), log('/r/proj/sub'), log('/r/other'), log(undefined)]
  const { inProject, elsewhere } = partitionByProject(logs, root)
  check('splits 3 in / 1 out', inProject.length === 3 && elsewhere.length === 1)
  check('no row dropped', inProject.length + elsewhere.length === logs.length)
}

section('3. the /clear'.concat("'ed-session cache (operator model: cleared = closed on purpose)"))
{
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
    const clear = src('commands', 'clear', 'clear.ts')
    check('/clear parks the focused session and births a fresh one (the one-door law)', clear.includes('clearFocusedSession()'))
    const screen = src('components', 'concourse', 'ConcourseRoute.tsx')
    check('the double-x on a PARKED row is the cleared mark\'s writer (the board hides the chat; the transcript stays)', screen.includes('THE DOUBLE-X ON A PARKED ROW'))
    for (const [label, path] of [
      ['berth ring', ['components', 'mercury-ui', 'SessionTabs.tsx']],
      ['/sessiontab flip', ['commands', 'sessiontab', 'sessiontab.tsx']],
      ['RECENT lane', ['components', 'HelmLanesRail.tsx']],
      ['⊞ SESSIONS board (the picker core)', ['components', 'mercury-ui', 'screens', 'sessionPickerModel.ts']],
    ] as const) {
      check(`${label} filters cleared sessions`, /isSessionCleared\(/.test(src(...path)))
    }
    check(
      '/resume keeps retrieving cleared sessions (no cache read there)',
      !/isSessionCleared/.test(src('commands', 'resume', 'resume.tsx')),
    )
  } finally {
    if (prevHome === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = prevHome
    resetClearedSessionsMemo()
    rmSync(home, { recursive: true, force: true })
  }
}

section('4. every switcher surface applies the scope (source)')
{
  const pickerCore = src('components', 'mercury-ui', 'screens', 'sessionPickerModel.ts')
  const manager = src('components', 'mercury-ui', 'screens', 'SessionManagerView.tsx')
  check('⊞ SESSIONS manager partitions by project (through the picker core)', /partitionByProject\(/.test(pickerCore))
  check('manager surfaces the elsewhere count honestly', /in other projects/.test(manager))
  const tabs = src('components', 'mercury-ui', 'SessionTabs.tsx')
  check('berth tab ring scopes', /isProjectSession\(l, getProjectRoot\(\)/.test(tabs))
  const flip = src('commands', 'sessiontab', 'sessiontab.tsx')
  check('/sessiontab flip scopes', /isProjectSession\(l, getProjectRoot\(\)/.test(flip))
  const rail = src('components', 'HelmLanesRail.tsx')
  check('cockpit RECENT lane scopes', /isProjectSession\(l, getProjectRoot\(\)/.test(rail))
  const resume = src('commands', 'resume', 'resume.tsx')
  check(
    '/resume keeps the cross-project reach (allProjects loader intact)',
    /loadAllProjectsMessageLogs\(\)/.test(resume),
  )
}

console.log('\n============================================================')
if (failures) {
  console.log(`❌ PROJECT SCOPE RED — ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ ALL PROJECT-SCOPE PROOFS PASS')
