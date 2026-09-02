#!/usr/bin/env bun
// ============================================================================
//  scripts/run-continuity/prove-lane-identity.ts — R2: lane identity is
//  legible — ONE display-name derivation shared by /workbench and /diff.
//
//  The observed defect (tactile inventory O5): every worktree lane row on
//  /workbench rendered as the same truncated absolute-path prefix
//  (`wt:/Users/<you>/Dev…` × 19) because rowName fell back to the laneId and
//  truncate-end cut exactly the distinguishing tail. R2:
//    · laneDisplayName (workbench selectors) = goal > worktree BASENAME >
//      laneId; deriveLaneRows stamps displayName on EVERY branch;
//    · WorkbenchBoard renders displayName; the lane detail card drops the
//      duplicated path row and equal-phase `state` row;
//    · /diff's worktree source labels derive through the SAME helper;
//    · KeyValueGrid gains the opt-in `fit` mode (middle/end truncation in the
//      value's own column) — long refs/paths stop wrapping mid-token.
//
//  Run:  ~/.bun/bin/bun run scripts/run-continuity/prove-lane-identity.ts
// ============================================================================
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

// ── the pure derivation ─────────────────────────────────────────────────────
{
  const { laneDisplayName } = await import('../../src/services/workbench/selectors.ts')
  check('goal wins', laneDisplayName({ goal: 'fix the parser', worktreePath: '/a/b/parcel-1' }) === 'fix the parser')
  check(
    'worktree basename is the fallback',
    laneDisplayName({ worktreePath: '/repo/.claude/worktrees/parcel-081861b96315' }) === 'parcel-081861b96315',
  )
  check('trailing slash is tolerated', laneDisplayName({ worktreePath: '/x/y/lane-7/' }) === 'lane-7')
  check('laneId is the last resort', laneDisplayName({ laneId: 'zone:slice-9' }) === 'zone:slice-9')
  check('empty goal falls through', laneDisplayName({ goal: '  ', worktreePath: '/p/q' }) === 'q')
}

// ── deriveLaneRows stamps displayName on every branch ───────────────────────
// Re-trued to the session-room retirement (it dropped the workbench
// collab projection — zone lanes derive NO row any more). The zone fixture
// is KEPT AS POISON, the crew-projection precedent: a standing zoneLanes
// input must revive nothing, so a zone row's RETURN reds this section for
// its deliberate revival re-true.
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
    gitWorktreeLanes: [{ path: '/w/.claude/worktrees/parcel-decafbad', branch: 'wt-b', head: 'abc' }],
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
    byId.get('wt:/w/.claude/worktrees/parcel-decafbad') === 'parcel-decafbad',
  )
}

// ── consumers ───────────────────────────────────────────────────────────────
{
  // The board's LANES rows retired in place with the WORK panel;
  // the lane display-name owner
  // keeps its remaining consumers below.
  const sources = src('src/components/diff/diffSources.ts')
  check('/diff worktree labels ride the shared helper', sources.includes('laneDisplayName({ worktreePath: wt.path })'))
  const kit = src('src/components/mercury-ui/components.tsx')
  check('KeyValueGrid carries the opt-in fit mode', kit.includes("fit?: 'middle' | 'end'"))
  check('fit=middle maps to truncate-middle', kit.includes("wrap={r.fit === 'middle' ? 'truncate-middle' : 'truncate-end'}"))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
