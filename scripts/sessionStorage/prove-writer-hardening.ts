#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-writer-hardening.ts
//  PROOF: P1 data/stream plane hardening legs —
//    1. appendEntryToFile survives a MULTI-LEVEL missing parent path (the
//       sync metadata writer creates the whole directory chain, matching
//       its async twin) and the appended line decodes back;
//    2. readAgentMetadata tolerates a corrupt sidecar: missing → null,
//       torn/corrupt JSON → null (logged), valid → round-trips — resume
//       degrades to re-resolution instead of crashing;
//    3. applySnipRemovals semantics hold through the rewrite: victims
//       leave the map, dangling survivors re-link across the hole, and a
//       boundary-free map is untouched.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Proof hygiene (.claude/rules/proof-hygiene.md): pin the config home to a
// scratch root BEFORE any src import — leg 2 derives real agent paths and
// none of that may land in the operator's home.
const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'p1hard-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH

const ROOT = join(import.meta.dir, '..', '..')
const { appendEntryToFile } = await import(
  join(ROOT, 'src/utils/sessionStorage/writer.ts')
)
const { getAgentMetadataPath, readAgentMetadata, writeAgentMetadata } =
  await import(join(ROOT, 'src/utils/sessionStorage/paths.ts'))
const { applySnipRemovals } = await import(
  join(ROOT, 'src/utils/sessionStorage/chain.ts')
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`,
  )
}

console.log('============================================================')
console.log(' writer/paths/chain hardening (P1 rewrite) — proof')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'p1hard-'))
try {
  // ── 1. sync append through a missing multi-level directory chain ─────────
  {
    const deep = join(scratch, 'a', 'b', 'c', 'session.jsonl')
    let threw = false
    try {
      appendEntryToFile(deep, { type: 'tag', tag: 'p1-proof', sessionId: 'x' })
    } catch (e) {
      threw = true
      console.log(`      threw: ${e}`)
    }
    check('appendEntryToFile creates the whole missing parent chain', !threw)
    if (!threw) {
      const raw = readFileSync(deep, 'utf8')
      check(
        'the appended line carries the entry (tag round-trips)',
        raw.includes('"p1-proof"'),
        raw.slice(0, 120),
      )
    }
  }

  // ── 2. agent metadata sidecar: tolerant reads at the boundary ────────────
  {
    const agentId = 'p1proof0-0000-4000-8000-000000000001' as never
    const sidecar = getAgentMetadataPath(agentId)

    // missing → null
    const missing = await readAgentMetadata(agentId)
    check('missing sidecar reads as null (fallback path)', missing === null)

    // corrupt → null, not a throw
    mkdirSync(dirname(sidecar), { recursive: true })
    writeFileSync(sidecar, '{"agentType": "worker", TORN')
    let corruptResult: unknown = 'unset'
    let corruptThrew = false
    try {
      corruptResult = await readAgentMetadata(agentId)
    } catch {
      corruptThrew = true
    }
    check(
      'corrupt sidecar reads as null instead of throwing',
      !corruptThrew && corruptResult === null,
    )

    // valid → round-trip
    await writeAgentMetadata(agentId, { agentType: 'verifier', model: 'm-1' })
    const roundTrip = await readAgentMetadata(agentId)
    check(
      'valid sidecar round-trips agentType + model',
      roundTrip?.agentType === 'verifier' && roundTrip?.model === 'm-1',
    )
  }

  // ── 3. snip replay semantics survive the rewrite ─────────────────────────
  {
    type Msg = {
      uuid: string
      parentUuid: string | null
      type: string
      timestamp: string
      snipMetadata?: { removedUuids: string[] }
    }
    const mk = (uuid: string, parentUuid: string | null): Msg => ({
      uuid,
      parentUuid,
      type: 'user',
      timestamp: '2026-08-21T00:00:00Z',
    })
    // a → b → c → d, with a boundary recording removal of b and c.
    const boundary: Msg = {
      ...mk('bd', 'd'),
      type: 'system',
      snipMetadata: { removedUuids: ['b', 'c'] },
    }
    const map = new Map<string, Msg>([
      ['a', mk('a', null)],
      ['b', mk('b', 'a')],
      ['c', mk('c', 'b')],
      ['d', mk('d', 'c')],
      ['bd', boundary],
    ])
    applySnipRemovals(map as never)
    check('snip victims leave the map', !map.has('b') && !map.has('c'))
    check(
      'the dangling survivor re-links across the removed range',
      map.get('d')?.parentUuid === 'a',
      `d.parentUuid=${map.get('d')?.parentUuid}`,
    )
    check('untouched entries keep their links', map.get('a')?.parentUuid === null)

    // boundary-free map: byte-for-byte untouched
    const clean = new Map<string, Msg>([
      ['a', mk('a', null)],
      ['b', mk('b', 'a')],
    ])
    applySnipRemovals(clean as never)
    check(
      'a map without snip boundaries is untouched',
      clean.size === 2 && clean.get('b')?.parentUuid === 'a',
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
}

console.log(
  failures === 0 ? '\n ✅ ALL P1 HARDENING PROOFS PASS' : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
