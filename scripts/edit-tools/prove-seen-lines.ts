#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-seen-lines.ts — the per-line read-evidence
//  ledger on the patch path (spec 02 c.6.3):
//    U. an edit into lines never displayed refuses with the smallest
//       re-read hint; after the hinted re-read the SAME patch lands
//    G. sightings are generation-keyed: an external touch invalidates them
//    P. partial windows accumulate; grep-style single-line sightings count
//    B. the bounded ledger forgets smallest-first and forgetting only ever
//       forces a re-read (pure-module law)
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-seen-lines.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seen-lines-home-'))
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
process.env.MERCURY_ANCHOR_PATCH = '1'
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'seen-lines-cs-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const {
  SEEN_LINES_BOUNDS,
  checkSeenLines,
  fileGeneration,
  recordSeenLines,
  _resetSeenLinesForTesting,
} = await import('../../src/services/changeTransaction/seenLines.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'seen-lines-fix-')))
const owner = processMainOwner()

function makeContext() {
  const readFileState = new Map<string, unknown>()
  const empty = getEmptyToolPermissionContext()
  const permCtx = {
    ...empty,
    additionalWorkingDirectories: new Map([[fixtures, { source: 'session' }]]),
  }
  return {
    owner,
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: permCtx }),
  } as never as { readFileState: Map<string, { content: string; timestamp: number }> }
}
type Ctx = ReturnType<typeof makeContext>
async function callTool(input: Record<string, unknown>, ctx: Ctx) {
  const result = await (ChangeSetTool as { call: Function }).call(input, ctx, null, {
    uuid: '00000000-0000-0000-0000-0000000sl001',
    message: { id: 'msg_fixture' },
  })
  return result as { data: { outcome: string; result: string } }
}
const anchorOf = (p: string): string =>
  mintFileAnchor(readFileSync(p, 'utf8').replaceAll('\r\n', '\n'))

console.log('— U. unseen lines refuse until the hinted re-read —')
{
  const p = join(fixtures, 'ledger.ts')
  writeFileSync(p, Array.from({ length: 30 }, (_, k) => `line ${k + 1}`).join('\n') + '\n')
  const ctx = makeContext()
  // The model "read" the whole file ONCE for the anchor, but the ledger only
  // saw a 10-line window (the partial-display case the law targets).
  ctx.readFileState.set(p, {
    content: readFileSync(p, 'utf8'),
    timestamp: Date.now() + 60_000,
  } as never)
  const generation = fileGeneration(p)!
  recordSeenLines(owner, p, generation, 1, 10)
  const patch = [`file ${p} ${anchorOf(p)}`, 'replace 20', '| line 20 EDITED'].join('\n')
  const r1 = await callTool({ op: 'apply', patch }, ctx)
  check('edit into undisplayed line 20 refuses', r1.data.outcome === 'failed', r1.data.result.slice(0, 200))
  check('the refusal is the not-read class with a Read hint', /never displayed/.test(r1.data.result) && /Read\(offset: 20, limit: 1\)/.test(r1.data.result), r1.data.result.slice(0, 300))
  check('nothing written on the refusal', readFileSync(p, 'utf8').includes('line 20\n'))
  // The hinted re-read.
  recordSeenLines(owner, p, generation, 20, 1)
  const r2 = await callTool({ op: 'apply', patch }, ctx)
  check('after the hinted re-read the SAME patch lands', r2.data.outcome === 'succeeded', r2.data.result.slice(0, 200))
  check('the edit is on disk', readFileSync(p, 'utf8').includes('line 20 EDITED'))
}

console.log('— G. generation-keyed sightings —')
{
  const p = join(fixtures, 'gen.ts')
  writeFileSync(p, 'a\nb\nc\n')
  const ctx = makeContext()
  ctx.readFileState.set(p, { content: 'a\nb\nc\n', timestamp: Date.now() + 60_000 } as never)
  recordSeenLines(owner, p, fileGeneration(p)!, 1, 3)
  // External touch: same bytes, new mtime ⇒ new generation ⇒ sightings die.
  utimesSync(p, new Date(), new Date(Date.now() + 5_000))
  const patch = [`file ${p} ${anchorOf(p)}`, 'replace 2', '| B'].join('\n')
  const r = await callTool({ op: 'apply', patch }, ctx)
  check('stale-generation sighting refuses (honest default)', r.data.outcome === 'failed', r.data.result.slice(0, 200))
  recordSeenLines(owner, p, fileGeneration(p)!, 1, 3)
  const r2 = await callTool({ op: 'apply', patch }, ctx)
  check('fresh-generation sighting lands', r2.data.outcome === 'succeeded', r2.data.result.slice(0, 160))
}

console.log('— P/B. pure-module laws: accumulation, coalescing, bounded forgetting —')
{
  _resetSeenLinesForTesting()
  const p = '/virtual/pure.ts'
  const gen = 'm1:100'
  recordSeenLines(owner, p, gen, 1, 5)
  recordSeenLines(owner, p, gen, 6, 5) // adjacent — coalesces to 1-10
  recordSeenLines(owner, p, gen, 30, 1) // a grep-style single-line sighting
  const spans = (s: number, e: number) => [{ index: 1, start: s, end: e, replace: 'x' }]
  check('coalesced window passes', checkSeenLines(owner, p, gen, spans(1, 10)).ok)
  check('grep sighting passes for its line', checkSeenLines(owner, p, gen, spans(30, 30)).ok)
  const gap = checkSeenLines(owner, p, gen, spans(8, 12))
  check('a span straddling the gap refuses naming 11-12', !gap.ok && JSON.stringify((gap as { unseen: object[] }).unseen) === JSON.stringify([{ start: 11, end: 12 }]), JSON.stringify(gap))
  check('wrong generation refuses everything', !checkSeenLines(owner, p, 'm2:100', spans(1, 5)).ok)
  // Bounded forgetting: overflow the range cap with disjoint single lines.
  _resetSeenLinesForTesting()
  for (let i = 0; i < SEEN_LINES_BOUNDS.rangeCap + 40; i++) {
    recordSeenLines(owner, p, gen, i * 3 + 1, 1)
  }
  let seenCount = 0
  let refusedCount = 0
  for (let i = 0; i < SEEN_LINES_BOUNDS.rangeCap + 40; i++) {
    if (checkSeenLines(owner, p, gen, spans(i * 3 + 1, i * 3 + 1)).ok) seenCount++
    else refusedCount++
  }
  check('the cap forgot some sightings (refuses more, never lies)', refusedCount > 0 && seenCount <= SEEN_LINES_BOUNDS.rangeCap, `seen ${seenCount} refused ${refusedCount}`)
}

console.log('')
if (failures > 0) {
  console.log(`RED: ${failures} failing check(s)`)
  process.exit(1)
}
console.log('GREEN: the seen-lines ledger refuses undisplayed edits, honours generations, and forgets safely')
