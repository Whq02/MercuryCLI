#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'p1hard-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH

const ROOT = join(import.meta.dir, '..', '..')
const { appendEntryToFile } = await import(
  join(ROOT, 'src/sessions/transcripts/writer.ts')
)
const { getCrewmateMetadataPath, readCrewmateMetadata, writeCrewmateMetadata } =
  await import(join(ROOT, 'src/sessions/transcripts/paths.ts'))
const { applySnipRemovals } = await import(
  join(ROOT, 'src/sessions/transcripts/chain.ts')
)

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`,
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
    check(
      'appendEntryToFile creates the whole missing parent chain',
      !threw,
      '',
      'appendEntryToFile in src/sessions/transcripts/writer.ts must create missing parent directories before it appends, and must not throw',
    )
    if (!threw) {
      const raw = readFileSync(deep, 'utf8')
      check(
        'the appended line carries the entry (tag round-trips)',
        raw.includes('"p1-proof"'),
        raw.slice(0, 120),
        'appendEntryToFile in src/sessions/transcripts/writer.ts must write the entry as a JSON line',
      )
    }
  }

  {
    const agentId = 'p1proof0-0000-4000-8000-000000000001' as never
    const sidecar = getCrewmateMetadataPath(agentId)

    const missing = await readCrewmateMetadata(agentId)
    check(
      'missing sidecar reads as null (fallback path)',
      missing === null,
      '',
      'readCrewmateMetadata in src/sessions/transcripts/paths.ts must return null when the sidecar file does not exist',
    )

    mkdirSync(dirname(sidecar), { recursive: true })
    writeFileSync(sidecar, '{"agentType": "worker", TORN')
    let corruptResult: unknown = 'unset'
    let corruptThrew = false
    try {
      corruptResult = await readCrewmateMetadata(agentId)
    } catch {
      corruptThrew = true
    }
    check(
      'corrupt sidecar reads as null instead of throwing',
      !corruptThrew && corruptResult === null,
      '',
      'readCrewmateMetadata in src/sessions/transcripts/paths.ts must catch a JSON parse error and return null',
    )

    await writeCrewmateMetadata(agentId, { agentType: 'verifier', model: 'm-1' })
    const roundTrip = await readCrewmateMetadata(agentId)
    check(
      'valid sidecar round-trips agentType + model',
      roundTrip?.agentType === 'verifier' && roundTrip?.model === 'm-1',
      '',
      'writeCrewmateMetadata and readCrewmateMetadata in src/sessions/transcripts/paths.ts must store and return agentType and model',
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
    check(
      'snip victims leave the map',
      !map.has('b') && !map.has('c'),
      '',
      'applySnipRemovals in src/sessions/transcripts/chain.ts must delete every uuid in snipMetadata.removedUuids from the map',
    )
    check(
      'the dangling survivor re-links across the removed range',
      map.get('d')?.parentUuid === 'a',
      `d.parentUuid=${map.get('d')?.parentUuid}`,
      'applySnipRemovals in src/sessions/transcripts/chain.ts must point a survivor whose parent was removed at the nearest kept ancestor',
    )
    check(
      'untouched entries keep their links',
      map.get('a')?.parentUuid === null,
      '',
      'applySnipRemovals in src/sessions/transcripts/chain.ts must leave entries outside the removed range unchanged',
    )

    const clean = new Map<string, Msg>([
      ['a', mk('a', null)],
      ['b', mk('b', 'a')],
    ])
    applySnipRemovals(clean as never)
    check(
      'a map without snip boundaries is untouched',
      clean.size === 2 && clean.get('b')?.parentUuid === 'a',
      '',
      'applySnipRemovals in src/sessions/transcripts/chain.ts must change nothing when no entry carries snipMetadata',
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
