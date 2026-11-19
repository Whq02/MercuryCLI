#!/usr/bin/env bun

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

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
    gitWorktreeLanes: [{ path: '/w/.mercury/worktrees/parcel-decafbad', branch: 'wt-b', head: 'abc' }],
    laneRuns: new Map(),
  } as never
  const rows = (deriveLaneRows as (i: never) => Array<{ laneId: string; displayName: string }>)(inputs)
  check('every derived lane row carries displayName', rows.length === 1 && rows.every(r => r.displayName.length > 0))
  const byId = new Map(rows.map(r => [r.laneId, r.displayName]))
  check(
    'the poison zone fixture revives NO row (session-room retirement)',
    ![...byId.keys()].some(k => k.startsWith('zone:')),
  )
  check(
    'git worktree lane shows its basename',
    byId.get('wt:/w/.mercury/worktrees/parcel-decafbad') === 'parcel-decafbad',
  )
}


console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
