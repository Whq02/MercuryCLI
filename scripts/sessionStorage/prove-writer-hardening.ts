#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

  {
    const agentId = 'p1proof0-0000-4000-8000-000000000001' as never
    const sidecar = getAgentMetadataPath(agentId)

    const missing = await readAgentMetadata(agentId)
    check('missing sidecar reads as null (fallback path)', missing === null)

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

    await writeAgentMetadata(agentId, { agentType: 'verifier', model: 'm-1' })
    const roundTrip = await readAgentMetadata(agentId)
    check(
      'valid sidecar round-trips agentType + model',
      roundTrip?.agentType === 'verifier' && roundTrip?.model === 'm-1',
    )
  }

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
