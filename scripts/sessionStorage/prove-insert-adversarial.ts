#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-insert-adversarial.ts — ADVERSARIAL writers
//  against the insert-serialization domain (delivery-verifier lane).
//
//  prove-concurrent-chain-fork pins the two-writer overlap on a seeded
//  file. These legs attack past it:
//
//    C1  THREE same-tick writers — the chain stays strictly linear
//        (seed → 1 → 2 → 3), not just pairwise-ordered.
//    C2  THE BIRTH RACE — two same-tick writers on a session whose file
//        holds NOTHING yet. preferLiveLeaf was computed OUTSIDE the
//        serialized section as `messageSet.size > 0`: both writers computed
//        FALSE, so the second ignored the leaf the first had just set and
//        parented at null — TWO ROOTS, and the latest-leaf display walk
//        silently drops one whole batch. (The flag comment claimed the
//        has-records fact "never un-happens" — but its INVERSE un-happens
//        exactly once, at birth, between the compute and the write.) The
//        law: a record never roots while a live leaf stands.
//    C3  SETTLE RACING AN INSERT — a same-tick settleMessage republish of
//        an already-recorded row keeps its uuid and parent (last-wins,
//        never a fork) while the racing insert chains linearly past it.
//
//  Run: ~/.bun/bin/bun run scripts/sessionStorage/prove-insert-adversarial.ts
// ============================================================================
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'insert-adv-home-'))

const ROOT = join(import.meta.dir, '..', '..')
const { recordTranscript, flushSessionStorage, settleTranscriptMessage } = await import(
  join(ROOT, 'src/utils/sessionStorage/writer.ts')
)
const { createUserMessage, createAssistantMessage } = await import(join(ROOT, 'src/utils/messages.ts'))
const { getSessionId } = await import(join(ROOT, 'src/bootstrap/state.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function readParents(): Map<string, string | null> {
  const home = process.env.MERCURY_CONFIG_DIR!
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(home)
  const sessionFile = files.find(f => f.includes(getSessionId()))
  const parents = new Map<string, string | null>()
  if (!sessionFile) return parents
  for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as {
        recordId?: string
        parentId?: string | null
        payload?: { fields?: { uuid?: string; parentUuid?: string | null } }
      }
      const uuid = record.payload?.fields?.uuid ?? record.recordId
      if (typeof uuid === 'string') {
        parents.set(uuid, record.payload?.fields?.parentUuid ?? record.parentId ?? null)
      }
    } catch {
      /* torn line */
    }
  }
  return parents
}

const uuidOf = (m: unknown): string => (m as { uuid: string }).uuid

// ── C2 FIRST — the birth race needs the file EMPTY ──────────────────────────
section('C2 — the birth race: two same-tick writers on an empty session')
const birthA = createUserMessage({ content: 'born first' })
const birthB = createUserMessage({ content: 'born second' })
{
  const pA = recordTranscript([birthA] as never)
  const pB = recordTranscript([birthB] as never)
  await Promise.all([pA, pB])
  await flushSessionStorage()
  const parents = readParents()
  check('both birth batches are recorded', parents.has(uuidOf(birthA)) && parents.has(uuidOf(birthB)), `${parents.size} records`)
  const roots = [uuidOf(birthA), uuidOf(birthB)].filter(u => parents.get(u) === null || parents.get(u) === undefined)
  check(
    'exactly ONE root — a record never roots while a live leaf stands (two roots fork at birth and the display walk DROPS one batch)',
    roots.length === 1,
    `roots=${roots.length}: A.parent=${parents.get(uuidOf(birthA))} B.parent=${parents.get(uuidOf(birthB))}`,
  )
  check(
    'the second birth writer chains onto the first',
    parents.get(uuidOf(birthB)) === uuidOf(birthA),
    `B.parent=${parents.get(uuidOf(birthB))}`,
  )
}

// ── C1 — three same-tick writers stay strictly linear ───────────────────────
section('C1 — three same-tick writers: strictly linear, in call order')
const w1 = createUserMessage({ content: 'first of three' })
const w2 = createUserMessage({ content: 'second of three' })
const w3 = createUserMessage({ content: 'third of three' })
{
  const p1 = recordTranscript([w1] as never)
  const p2 = recordTranscript([w2] as never)
  const p3 = recordTranscript([w3] as never)
  await Promise.all([p1, p2, p3])
  await flushSessionStorage()
  const parents = readParents()
  check('all three landed', parents.has(uuidOf(w1)) && parents.has(uuidOf(w2)) && parents.has(uuidOf(w3)))
  check('the first chains onto the pre-race leaf', parents.get(uuidOf(w1)) === uuidOf(birthB), `w1.parent=${parents.get(uuidOf(w1))}`)
  check('the second chains onto the first', parents.get(uuidOf(w2)) === uuidOf(w1), `w2.parent=${parents.get(uuidOf(w2))}`)
  check('the third chains onto the second', parents.get(uuidOf(w3)) === uuidOf(w2), `w3.parent=${parents.get(uuidOf(w3))}`)
}

// ── C3 — a settle republish racing an insert ────────────────────────────────
section('C3 — settleMessage racing an insert: last-wins republish, no fork')
{
  const settledTwin = createAssistantMessage({ content: 'the reply that settles' })
  await recordTranscript([settledTwin] as never)
  await flushSessionStorage()
  const racer = createUserMessage({ content: 'racing the settle' })
  const pSettle = settleTranscriptMessage(settledTwin as never)
  const pInsert = recordTranscript([racer] as never)
  await Promise.all([pSettle, pInsert])
  await flushSessionStorage()
  const parents = readParents()
  check('the settled row keeps its identity (one uuid, last-wins)', parents.has(uuidOf(settledTwin)))
  check('the settled row keeps its parent (the republish never re-parents)', parents.get(uuidOf(settledTwin)) === uuidOf(w3), `parent=${parents.get(uuidOf(settledTwin))}`)
  check('the racing insert chains onto the settled row, linear', parents.get(uuidOf(racer)) === uuidOf(settledTwin), `racer.parent=${parents.get(uuidOf(racer))}`)
}

console.log(
  failures === 0
    ? '\n ✅ INSERT-ADVERSARIAL — every writer race stays linear; birth roots once'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
