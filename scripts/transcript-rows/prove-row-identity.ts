#!/usr/bin/env bun

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
  check('WRITE scene: fixture served both turns', run.fixture.messageRequests().length >= 2, `the fixture served ${run.fixture.messageRequests().length} requests, fewer than 2; the Write turn never reached its second request, so look at the arena run output from runArtifactArena (scripts/streaming/artifactArena.ts)`)
  const mounts = markCounts(run, 'mount:tool-row:')
  const unmounts = markCounts(run, 'unmount:tool-row:')
  const ids = Object.keys(mounts)
  check('exactly one tool row mounted', ids.length === 1, `expected one tool-row mount mark; the Write tool row is mounted by useFluxMountMark in src/screen/messages/AssistantToolUseMessage.tsx. ${JSON.stringify(mounts)}`)
  check(
    'the row mounted ONCE through pending→consent→running→settled',
    ids.length === 1 && mounts[ids[0]!] === 1,
    `the tool row mounted more than once; keep the row mounted from pending to settled in src/screen/messages/AssistantToolUseMessage.tsx. ${JSON.stringify(mounts)}`,
  )
  check(
    'no remount (an unmount would mean the settled row is a different mount)',
    Object.keys(unmounts).length === 0,
    `a tool row unmounted, so the settled row is a different mount; keep one mounted row in src/screen/messages/AssistantToolUseMessage.tsx. ${JSON.stringify(unmounts)}`,
  )
}

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
  check('READS scene: fixture served all three turns', run.fixture.messageRequests().length >= 3, `the fixture served ${run.fixture.messageRequests().length} requests, fewer than 3; the READS scene did not run all its turns, so look at the arena run output from runArtifactArena (scripts/streaming/artifactArena.ts)`)
  const group = markCounts(run, 'mount:read-group')
  const groupUn = markCounts(run, 'unmount:read-group')
  const tail = markCounts(run, 'mount:tail')
  const toolRows = markCounts(run, 'mount:tool-row:')
  check('the read group mounted exactly once', group['mount:read-group'] === 1, `the read group must mount exactly once; see useFluxMountMark in src/screen/messages/CollapsedReadSearchContent.tsx. ${JSON.stringify(group)}`)
  check('the group never remounted', (groupUn['unmount:read-group'] ?? 0) === 0, `the read group unmounted while the turn grew; keep it mounted in src/screen/messages/CollapsedReadSearchContent.tsx. ${JSON.stringify(groupUn)}`)
  const toolRowsUn = markCounts(run, 'unmount:tool-row:')
  check(
    'reads ride the group from the first call — no standalone read row mounts',
    Object.keys(toolRows).length === 0 && Object.keys(toolRowsUn).length === 0,
    `a read mounted a standalone tool row; reads must join the group from the first call, so check src/screen/messages/AssistantToolUseMessage.tsx and src/screen/messages/CollapsedReadSearchContent.tsx. ${JSON.stringify({ ...toolRows, ...toolRowsUn })}`,
  )
  const tailUn = markCounts(run, 'unmount:tail')
  check('the tail is one persistent mount across streams', tail['mount:tail'] === 1 && (tailUn['unmount:tail'] ?? 0) === 0, `the streaming tail must mount once and never unmount between streams; see useFluxMountMark in src/screen/messages/LiveStreamingTail.tsx. ${JSON.stringify({ ...tail, ...tailUn })}`)
}

console.log(failures === 0 ? '✅ row-identity GREEN' : `❌ row-identity RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
