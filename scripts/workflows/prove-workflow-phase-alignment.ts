#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-workflow-phase-alignment.ts
//  PROOF: the phase off-by-one class is CLOSED.
//
//  The bug: the executor's resolvePhase allocated 1-BASED phase ids while the
//  UI projectors + run manifest seed planned phases at meta.phases array
//  positions (0-based). Every run therefore rendered its planned phase as an
//  EMPTY duplicate ("Audit (0)") beside the live phase carrying the agents
//  ("Audit (1)") — the operator's screenshot bug, and the DnD session's
//  "phase 1 planned while phase 2 runs" misattribution.
//
//  Two closures, both proven here:
//   • SOURCE — agentHooks.ts resolvePhase allocates 0-based (`nextPhaseId++`,
//     never `++nextPhaseId`), so seeded meta titles land at their own array
//     positions. (agentHooks is bun-unloadable — macro graph — so the executor
//     side is a source-lock, per the house rule for that file.)
//   • BEHAVIORAL — the ONE shared projector (runManifest.groupAgentsByPhase,
//     deliberately bun-loadable) title-merges: a live phase event or an agent
//     whose phaseTitle matches a planned phase MERGES into the planned bucket
//     even when its index disagrees (heals manifests persisted by the 1-based
//     era), and no two buckets ever share a title.
//
//  Run: ~/.bun/bin/bun run scripts/workflows/prove-workflow-phase-alignment.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  groupAgentsByPhase,
  UNPHASED_INDEX,
} from '../../src/tools/WorkflowTool/runManifest.js'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) fail++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

console.log('prove-workflow-phase-alignment — the phase off-by-one class')

// ── 1. SOURCE: the executor allocates 0-based phase ids ─────────────────────
section('(1) executor source-lock: resolvePhase is 0-based')
{
  const src = readFileSync(
    join(import.meta.dir, '../../src/tools/WorkflowTool/agentHooks.ts'),
    'utf8',
  )
  check('resolvePhase allocates with `id = nextPhaseId++`', src.includes('id = nextPhaseId++'))
  check('the 1-based `id = ++nextPhaseId` allocation is GONE', !src.includes('++nextPhaseId'))
  check(
    'seedPhaseTitles still seeds BEFORE any script phase() call',
    /for \(const title of deps\.seedPhaseTitles \?\? \[\]\) resolvePhase\(title\)/.test(src),
  )
}

// ── 2. BEHAVIORAL: fresh 0-based run — planned and live align exactly ───────
section('(2) fresh (0-based) run: planned buckets carry the live agents')
{
  const planned = [
    { title: 'Scan', detail: 'grep the tree' },
    { title: 'Fix', model: 'sonnet' },
  ]
  const groups = groupAgentsByPhase(
    planned,
    [
      { index: 0, title: 'Scan' },
      { index: 1, title: 'Fix' },
    ],
    [
      { index: 1, phaseIndex: 0, phaseTitle: 'Scan' },
      { index: 2, phaseIndex: 1, phaseTitle: 'Fix' },
      { index: 3, phaseIndex: 1, phaseTitle: 'Fix' },
    ],
  )
  check('exactly the two planned buckets (no duplicates)', groups.length === 2, `got ${groups.length}`)
  check('titles unique across buckets', new Set(groups.map(g => g.title)).size === groups.length)
  check('Scan carries its agent at index 0', groups[0]!.title === 'Scan' && groups[0]!.agents.length === 1)
  check('Fix carries both agents at index 1', groups[1]!.title === 'Fix' && groups[1]!.agents.length === 2)
  check('live buckets are not "planned"', groups.every(g => !g.planned))
  check('planned metadata (detail/model) preserved through the merge', groups[0]!.detail === 'grep the tree' && groups[1]!.model === 'sonnet')
}

// ── 3. BEHAVIORAL: 1-based-era manifest HEALS by title merge ────────────────
section('(3) healing: 1-based-era data merges into the planned buckets')
{
  const planned = [{ title: 'Audit' }, { title: 'Repair' }]
  const groups = groupAgentsByPhase(
    planned,
    [
      { index: 1, title: 'Audit' }, // the old executor's 1-based ids
      { index: 2, title: 'Repair' },
    ],
    [
      { index: 1, phaseIndex: 1, phaseTitle: 'Audit' },
      { index: 2, phaseIndex: 2, phaseTitle: 'Repair' },
    ],
  )
  check('NO duplicate "Audit (0)/(1)" pair — 2 buckets total', groups.length === 2, `got ${groups.length}`)
  check('Audit bucket holds its agent despite the index-1 drift', groups.find(g => g.title === 'Audit')?.agents.length === 1)
  check('Repair bucket holds its agent despite the index-2 drift', groups.find(g => g.title === 'Repair')?.agents.length === 1)
  check('no bucket still reads planned (agents reported)', groups.every(g => !g.planned))
}

// ── 4. BEHAVIORAL: honest edges ──────────────────────────────────────────────
section('(4) edges: unplanned titles, unphased agents, index collisions, empty')
{
  // A live title with no planned twin gets its own bucket at a free index.
  const g1 = groupAgentsByPhase(
    [{ title: 'Scan' }],
    [{ index: 0, title: 'Surprise' }], // collides with planned index 0
    [{ index: 1, phaseIndex: 0, phaseTitle: 'Surprise' }],
  )
  check('unplanned live title gets its OWN bucket (never overwrites planned)', g1.length === 2)
  check('planned Scan stays planned + empty', g1.find(g => g.title === 'Scan')?.planned === true)
  check('Surprise carries its agent', g1.find(g => g.title === 'Surprise')?.agents.length === 1)
  check('collided index reallocated (no shared index)', new Set(g1.map(g => g.index)).size === 2)

  // An agent with no phase lands in the synthetic unphased bucket, first.
  const g2 = groupAgentsByPhase([{ title: 'Scan' }], [], [{ index: 1 }])
  check('unphased agent lands in the UNPHASED bucket', g2.some(g => g.index === UNPHASED_INDEX && g.agents.length === 1))
  check('UNPHASED sorts first', g2[0]!.index === UNPHASED_INDEX)

  // Pure + total: empty everything.
  check('empty input ⇒ empty output (never throws)', groupAgentsByPhase(undefined, [], []).length === 0)

  // Duplicate planned titles merge (titles are identity).
  const g3 = groupAgentsByPhase([{ title: 'X' }, { title: 'X' }], [], [])
  check('duplicate planned titles collapse to one bucket', g3.length === 1)
}

// ── 5. WIRING: both UI projectors ride the shared function ──────────────────
section('(5) wiring source-locks: buildTree + groupByPhase delegate')
{
  const dlg = readFileSync(join(import.meta.dir, '../../src/components/tasks/WorkflowDetailDialog.tsx'), 'utf8')
  check('WorkflowDetailDialog.buildTree calls groupAgentsByPhase', dlg.includes('groupAgentsByPhase('))
  const run = readFileSync(join(import.meta.dir, '../../src/components/tasks/RunDetailPane.tsx'), 'utf8')
  check('RunDetailPane groups via groupAgentsByPhase', run.includes('groupAgentsByPhase'))
}

console.log(fail === 0 ? '\n✅ prove-workflow-phase-alignment: ALL PASS' : `\n❌ prove-workflow-phase-alignment: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
