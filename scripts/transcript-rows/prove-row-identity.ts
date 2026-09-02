#!/usr/bin/env bun
// ============================================================================
//  scripts/transcript-rows/prove-row-identity.ts — COCKPIT S3: the row-identity
//  RATCHET, proven on the SHIPPED artifact.
//
//  The law: a transcript work row
//  mounts ONCE and lives through its whole lifecycle —
//    · a permissioned tool row (Write) stays the SAME React mount through
//      pending → consent card → running → settled;
//    · consecutive reads ride ONE read-group mount (the group's ACTIVE form
//      is the running card; settle is a text morph, not a remount);
//    · the streaming tail mounts once per stream.
//  This was TRUE at baseline (the claimed remount gap was refuted by the
//  mount marks) — this prover pins it so it STAYS true. Mount marks are the
//  probe-gated useFluxMountMark hooks (inert without MERCURY_FLUX_PROBE).
//
//  Method: two hermetic artifactArena runs of dist/mercury.mjs with the
//  probe tee armed; assert on mount:/unmount: mark counts.
// ============================================================================

import { join } from 'node:path'
import { runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const markCounts = (run: ArenaRun, prefix: string): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const m of run.probe?.allMarks ?? []) {
    if (m.k.startsWith(prefix)) out[m.k] = (out[m.k] ?? 0) + 1
  }
  return out
}

console.log('── row-identity ratchet (shipped artifact) ──')

// ── scene WRITE: one permissioned tool through its full lifecycle ───────────
{
  const run = await runArtifactArena({
    turns: cwd => [
      {
        kind: 'tool_use',
        preText: 'Writing a file.\n',
        name: 'Write',
        input: { file_path: join(cwd, 'ratchet-out.txt'), content: 'row-identity\n' },
      },
      { kind: 'text', text: 'Done.' },
    ],
    sends: ['4500:hello', '5300:\\r', '9500:\\r'],
    seconds: 15,
    probe: true,
  })
  check('WRITE scene: fixture served both turns', run.fixture.messageRequests().length >= 2, `${run.fixture.messageRequests().length}`)
  const mounts = markCounts(run, 'mount:tool-row:')
  const unmounts = markCounts(run, 'unmount:tool-row:')
  const ids = Object.keys(mounts)
  check('exactly one tool row mounted', ids.length === 1, JSON.stringify(mounts))
  check(
    'the row mounted ONCE through pending→consent→running→settled',
    ids.length === 1 && mounts[ids[0]!] === 1,
    JSON.stringify(mounts),
  )
  check(
    'no remount (an unmount would mean the settled row is a different mount)',
    Object.keys(unmounts).length === 0,
    JSON.stringify(unmounts),
  )
}

// ── scene READS: consecutive reads ride ONE group mount ────────────────────
{
  const notes = Array.from({ length: 8 }, (_, i) => `note-${i}`).join('\n')
  const run = await runArtifactArena({
    seedCwd: { 'ratchet-a.txt': notes, 'ratchet-b.txt': notes },
    turns: cwd => [
      {
        kind: 'paced_tool_use',
        preDeltas: Array.from({ length: 15 }, (_, i) => `pre${i} `),
        gapMs: 40,
        tools: [{ name: 'Read', input: { file_path: join(cwd, 'ratchet-a.txt') } }],
      },
      { kind: 'tool_use', name: 'Read', input: { file_path: join(cwd, 'ratchet-b.txt') } },
      { kind: 'paced', deltas: Array.from({ length: 12 }, (_, i) => `post${i} `), gapMs: 40 },
    ],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 16,
    probe: true,
  })
  check('READS scene: fixture served all three turns', run.fixture.messageRequests().length >= 3, `${run.fixture.messageRequests().length}`)
  const group = markCounts(run, 'mount:read-group')
  const groupUn = markCounts(run, 'unmount:read-group')
  const tail = markCounts(run, 'mount:tail')
  const toolRows = markCounts(run, 'mount:tool-row:')
  check('the read group mounted exactly once', group['mount:read-group'] === 1, JSON.stringify(group))
  check('the group never remounted', (groupUn['unmount:read-group'] ?? 0) === 0, JSON.stringify(groupUn))
  check('reads ride the group — zero individual tool-row mounts', Object.keys(toolRows).length === 0, JSON.stringify(toolRows))
  const tailUn = markCounts(run, 'unmount:tail')
  // The tail is ONE persistent mount across the scene's streams — content
  // swaps per stream, the mount never churns (per-stream remounts were the
  // weaker era; zero unmounts is the no-churn half of the same law).
  check('the tail is one persistent mount across streams', tail['mount:tail'] === 1 && (tailUn['unmount:tail'] ?? 0) === 0, JSON.stringify({ ...tail, ...tailUn }))
}

console.log(failures === 0 ? '✅ row-identity GREEN' : `❌ row-identity RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
