#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const ROOT = new URL('../../', import.meta.url).pathname
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

console.log('lane identity legibility ──')

{
  const { laneDisplayName } = await import('../../src/services/workbench/selectors.ts')
  check('goal wins', laneDisplayName({ goal: 'fix the parser', worktreePath: '/a/b/parcel-1' }) === 'fix the parser')
  check(
    'worktree basename is the fallback',
    laneDisplayName({ worktreePath: '/repo/.mercury/worktrees/parcel-081861b96315' }) === 'parcel-081861b96315',
  )
  check('trailing slash is tolerated', laneDisplayName({ worktreePath: '/x/y/lane-7/' }) === 'lane-7')
  check('laneId is the last resort', laneDisplayName({ laneId: 'zone:slice-9' }) === 'zone:slice-9')
  check('empty goal falls through', laneDisplayName({ goal: '  ', worktreePath: '/p/q' }) === 'q')
}

{
  const { deriveLaneRows } = await import('../../src/services/workbench/selectors.ts')
  const inputs = {
    now: 1_700_000_000_000,
    projectRoot: '/repo',
    sessionId: 's',
    generation: { treeDigest: 'd', headSha: 'h', branch: 'main', clean: true },
    executions: [],
    richTasks: new Map(),
    agentMeta: new Map(),
    partySeats: [],
    collab: { zoneLanes: [{ sliceId: 'sl1', worktreePath: '/w/zones/zone-a', title: 'zone work', phase: 'ready' }] },
    contextLanes: [{ id: 'cl1', status: 'active', goal: 'side quest', handoffPromoted: false }],
    gitWorktreeLanes: [{ path: '/w/.mercury/worktrees/parcel-decafbad', branch: 'wt-b', head: 'abc' }],
    laneRuns: new Map(),
  } as never
  const rows = (deriveLaneRows as (i: never) => Array<{ laneId: string; displayName: string }>)(inputs)
  check('every derived lane row carries displayName', rows.length === 2 && rows.every(r => r.displayName.length > 0))
  const byId = new Map(rows.map(r => [r.laneId, r.displayName]))
  check('context lane shows its goal', byId.get('cl1') === 'side quest')
  check(
    'the poison zone fixture revives NO row (session-room retirement)',
    ![...byId.keys()].some(k => k.startsWith('zone:')),
  )
  check(
    'git worktree lane shows its basename',
    byId.get('wt:/w/.mercury/worktrees/parcel-decafbad') === 'parcel-decafbad',
  )
}

{
  const sources = src('src/components/diff/diffSources.ts')
  check('/diff worktree labels ride the shared helper', sources.includes('laneDisplayName({ worktreePath: wt.path })'))
  const kit = src('src/components/mercury-ui/components.tsx')
  check('KeyValueGrid carries the opt-in fit mode', kit.includes("fit?: 'middle' | 'end'"))
  check('fit=middle maps to truncate-middle', kit.includes("wrap={r.fit === 'middle' ? 'truncate-middle' : 'truncate-end'}"))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
