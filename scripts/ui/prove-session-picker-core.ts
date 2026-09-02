#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-session-picker-core.ts — the ONE resumable-session picker
// core (ruling 4's "one picker core, two skins" — the in-chat
//  switcher and the Boot face's resume entrance present the SAME rows).
//
//    §1 IDENTITY, BOTH DIRECTIONS — the moved machinery lives in
//       sessionPickerModel.ts with its load-bearing spellings intact, and is
//       GONE from SessionManagerView.tsx (single owner; the skin consumes
//       the hook — a fork left behind would drift the two surfaces apart).
//    §2 THE RESUMABLE PROJECTION — sidechains and the current session drop,
//       render-junk drops (titled/large sessions kept), newest first.
//    §3 SCOPE SEMANTICS — project scope: cleared dropped, other repos
//       collapse to the honest count; all scope: everything, cleared MARKED;
//       board-homed sessions excluded in both; crew rows unscoped in both;
//       head marks each project-group boundary.
//    §4 THE CLOCK SEAM — an injected nowMs makes every 'seen' cell
//       byte-stable (the face still's requirement).
//  cpu-pure: fixture LogOptions through the pure projections; never a PTY,
//  a daemon, a boot, or a real session store.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import {
  projectSessionPickerRows,
  resumableNewestFirst,
  rowLabel,
  rowProject,
  type SessionPickerFacts,
} from '../../src/components/mercury-ui/screens/sessionPickerModel.js'
import type { LogOption } from '../../src/types/logs.js'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const modelSrc = read('src/components/mercury-ui/screens/sessionPickerModel.ts')
const skinSrc = read('src/components/mercury-ui/screens/SessionManagerView.tsx')

/** A fixture session log — titled, so the substance filter keeps it. */
function log(over: Partial<LogOption> & { sessionId: string; modifiedMs: number }): LogOption {
  const { modifiedMs, ...rest } = over
  return {
    date: new Date(modifiedMs).toISOString(),
    messages: [],
    fullPath: `/store/${over.sessionId}.jsonl`,
    value: 0,
    created: new Date(modifiedMs),
    modified: new Date(modifiedMs),
    firstPrompt: 'a real prompt',
    messageCount: 3,
    isSidechain: false,
    customTitle: `chat ${over.sessionId}`,
    projectPath: '/repo/alpha',
    fileSize: 9000,
    ...rest,
  } as LogOption
}

t.section('§1 — IDENTITY, BOTH DIRECTIONS (one owner; the skin consumes the hook)')
{
  // The moved spellings live in the model…
  const movedNeedles = [
    'filterResumableSessions(all, currentSessionId).filter(isSubstantiveSession)',
    'partitionByProject(',
    "getLogDisplayTitle(log, '(untitled session)')",
    'boardHomed.has(getSessionIdFromLog(l)',
    'loadAllProjectsMessageLogsProgressive()',
    'enrichLogs(first.allStatLogs, next, ENRICH_BATCH)',
    "split(/[\\\\/]/).pop()",
  ]
  for (const needle of movedNeedles) {
    t.check(`model carries: ${needle.slice(0, 58)}`, modelSrc.includes(needle), needle)
  }
  // …and are GONE from the skin (single owner — no fork left behind).
  const forkTokens = [
    'partitionByProject',
    'isSubstantiveSession',
    'loadAllProjectsMessageLogsProgressive',
    'enrichLogs',
    'isCrewSession',
    'getLogDisplayTitle',
    'filterResumableSessions',
    'isSessionCleared',
    'subscribeCurrentProject',
    'useNowTick',
  ]
  const forks = forkTokens.filter(tok => skinSrc.includes(tok))
  t.check('the skin retains NONE of the moved machinery', forks.length === 0, forks.join(','))
  t.check('the skin consumes the one model hook', skinSrc.includes('useSessionPickerModel(scope)'))
  t.check("the skin's scope type re-exports from the model (existing callers keep their import)", skinSrc.includes("export type { SessionScope } from './sessionPickerModel.js'"))
  t.check('the prune mirror rides the model door (dropSessions), never a local setLogs', skinSrc.includes('dropSessions(new Set(receipt.deletedSessionIds))') && !skinSrc.includes('setLogs'))
}

t.section('§2 — THE RESUMABLE PROJECTION (drop · keep · order)')
{
  const all: LogOption[] = [
    log({ sessionId: 'old', modifiedMs: 1_000 }),
    log({ sessionId: 'current', modifiedMs: 5_000 }),
    log({ sessionId: 'side', modifiedMs: 4_000, isSidechain: true }),
    log({ sessionId: 'junk', modifiedMs: 3_500, customTitle: undefined, firstPrompt: '/sessions', fileSize: 2_000 }),
    log({ sessionId: 'big-command', modifiedMs: 3_000, customTitle: undefined, firstPrompt: '/rooms', fileSize: 21_000 }),
    log({ sessionId: 'new', modifiedMs: 9_000 }),
  ]
  const got = resumableNewestFirst(all, 'current').map(l => l.sessionId)
  t.check('the current session and sidechains drop; small command-only junk drops; a LARGE command-first session is real work and stays', JSON.stringify(got) === JSON.stringify(['new', 'big-command', 'old']), got.join(','))
}

t.section('§3 — SCOPE SEMANTICS (project · all · board-homed · crew · heads)')
{
  const logs: LogOption[] = [
    log({ sessionId: 'a1', modifiedMs: 9_000, projectPath: '/repo/alpha' }),
    log({ sessionId: 'b1', modifiedMs: 8_000, projectPath: '/repo/beta' }),
    log({ sessionId: 'a2', modifiedMs: 7_000, projectPath: '/repo/alpha' }),
    log({ sessionId: 'a-cleared', modifiedMs: 6_000, projectPath: '/repo/alpha' }),
    log({ sessionId: 'homed', modifiedMs: 5_500, projectPath: '/repo/alpha' }),
    log({ sessionId: 'crew1', modifiedMs: 5_000, projectPath: '/repo/alpha', isTeammate: true, teamName: 'party', agentName: 'dps1' }),
  ]
  const facts = (scope: SessionPickerFacts['scope']): SessionPickerFacts => ({
    scope,
    projectDir: '/repo/alpha',
    boardHomed: new Set(['homed']),
    isCleared: id => id === 'a-cleared',
    nowMs: 100_000,
  })

  const project = projectSessionPickerRows(logs, facts('project'))
  t.check("project scope lists this project's un-cleared operator sessions only", JSON.stringify(project.flat.map(f => f.row.log.sessionId)) === JSON.stringify(['a1', 'a2']), project.flat.map(f => f.row.log.sessionId).join(','))
  t.check('other repos collapse to the honest count', project.elsewhereCount === 1, String(project.elsewhereCount))
  t.check('cleared marks stay undefined outside all scope', project.flat.every(f => f.row.cleared === undefined))

  const all = projectSessionPickerRows(logs, facts('all'))
  t.check('all scope is the FULL history — every project, cleared included, board-homed still excluded', JSON.stringify(all.flat.map(f => f.row.log.sessionId)) === JSON.stringify(['a1', 'b1', 'a2', 'a-cleared']), all.flat.map(f => f.row.log.sessionId).join(','))
  t.check('the cleared session wears its mark; the others read false', all.flat.find(f => f.row.log.sessionId === 'a-cleared')?.row.cleared === true && all.flat.filter(f => f.row.log.sessionId !== 'a-cleared').every(f => f.row.cleared === false))
  t.check('head marks each project-group boundary (all scope interleaves chronologically)', JSON.stringify(all.flat.map(f => f.head)) === JSON.stringify([true, true, true, false]), all.flat.map(f => f.head).join(','))
  t.check('crew rows are unscoped and classed apart in BOTH scopes', project.crew.length === 1 && all.crew.length === 1 && project.crew[0]!.tag === 'party · dps1', project.crew[0]?.tag)
  t.check('the board-homed session appears in neither list (it lives on the board)', !all.flat.some(f => f.row.log.sessionId === 'homed') && !all.crew.some(c => c.log.sessionId === 'homed'))
  t.check('rows wear the canonical label and the project basename', all.flat[0]!.row.label === 'chat a1' && all.flat[0]!.project === 'alpha' && all.flat[1]!.project === 'beta')
  t.check('rowProject splits win32 paths too', rowProject(log({ sessionId: 'w', modifiedMs: 1, projectPath: 'C:\\code\\gamma' })) === 'gamma')
  t.check('rowLabel falls back honestly on an untitled row', rowLabel(log({ sessionId: 'u', modifiedMs: 1, customTitle: undefined, firstPrompt: '', messageCount: 0 })) !== '')
}

t.section('§4 — THE CLOCK SEAM (seen cells byte-stable under an injected now)')
{
  const logs = [log({ sessionId: 's', modifiedMs: 0 })]
  const facts: SessionPickerFacts = {
    scope: 'all',
    projectDir: '/repo/alpha',
    boardHomed: new Set(),
    isCleared: () => false,
    nowMs: 2 * 60_000,
  }
  const a = projectSessionPickerRows(logs, facts).flat[0]!.row.seen
  const b = projectSessionPickerRows(logs, facts).flat[0]!.row.seen
  t.check('two projections at the same injected now agree byte-for-byte', a === b && a.length > 0, a)
  const later = projectSessionPickerRows(logs, { ...facts, nowMs: 3 * 60 * 60_000 }).flat[0]!.row.seen
  t.check('the seen cell follows the injected clock (a later now reads older)', later !== a, `${a} → ${later}`)
}

t.section('§5 — THE VIEW FILTER (act two: filterDir — identity both directions)')
{
  // The merged sessions·projects screen scopes the session list to the
  // HIGHLIGHTED project (an additive fact; the operator's filter
  // sweetener). Identity both directions: absent ⇒ byte-identical rows;
  // present ⇒ exactly that dir's subset through the LANDED matcher; crew
  // stays unscoped (worktree lanes run outside project roots).
  const logs: LogOption[] = [
    log({ sessionId: 'a1', modifiedMs: 9_000, projectPath: '/repo/alpha' }),
    log({ sessionId: 'b1', modifiedMs: 8_000, projectPath: '/repo/beta' }),
    log({ sessionId: 'a2', modifiedMs: 7_000, projectPath: '/repo/alpha/nested' }),
    log({ sessionId: 'crew1', modifiedMs: 5_000, projectPath: '/repo/beta', isTeammate: true, teamName: 'party', agentName: 'dps1' }),
  ]
  const base: SessionPickerFacts = {
    scope: 'all',
    projectDir: '/repo/alpha',
    boardHomed: new Set(),
    isCleared: () => false,
    nowMs: 100_000,
  }
  const bare = projectSessionPickerRows(logs, base)
  const withAbsent = projectSessionPickerRows(logs, { ...base })
  t.check('ABSENT filterDir is byte-identical (the in-chat skin can never drift)', JSON.stringify(bare) === JSON.stringify(withAbsent))
  const filtered = projectSessionPickerRows(logs, { ...base, filterDir: '/repo/alpha' })
  t.check('PRESENT filterDir keeps exactly that dir’s subset (nested dirs included — the landed matcher)', JSON.stringify(filtered.flat.map(f => f.row.log.sessionId)) === JSON.stringify(['a1', 'a2']), filtered.flat.map(f => f.row.log.sessionId).join(','))
  t.check('the crew section stays UNSCOPED under a filter', filtered.crew.length === 1 && filtered.crew[0]!.log.sessionId === 'crew1')
  const filteredProject = projectSessionPickerRows(logs, { ...base, scope: 'project', filterDir: '/repo/beta' })
  t.check('the filter composes OVER the scope partition (a beta filter under alpha scope is honestly empty)', filteredProject.flat.length === 0 && filteredProject.elsewhereCount === 1)
  t.check('the elsewhere count stays the SCOPE’s own fact (a view filter never rewrites it)', projectSessionPickerRows(logs, { ...base, scope: 'project', filterDir: '/repo/alpha' }).elsewhereCount === 1)
  // The hook seam (structure): the optional fact rides opts and the memo
  // deps; the in-chat switcher passes nothing.
  t.check('the hook threads filterDir through opts and the memo deps', modelSrc.includes('opts: { enabled?: boolean; filterDir?: string } = {}') && modelSrc.includes("...(opts.filterDir !== undefined ? { filterDir: opts.filterDir } : {})") && modelSrc.includes('[logs, nowTick, scope, projectKey, opts.filterDir]'))
  t.check('the in-chat switcher never passes the filter (one skin, no drift)', !read('src/components/mercury-ui/screens/SessionManagerView.tsx').includes('filterDir'))
}

t.finish('prove-session-picker-core')
