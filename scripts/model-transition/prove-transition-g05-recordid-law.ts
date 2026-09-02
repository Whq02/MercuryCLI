#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-g05-recordid-law.ts —
//  THE IDENTITY LAW, ratified and pinned (src/fabric/record.ts §7.1a).
//
//  The law (the replay prerequisite — the materialization fold keys on the PAIR):
//    · recordId = MESSAGE identity — bridge-derived from the legacy uuid,
//      minted only for uuid-less lines; re-publication REUSES it.
//    · LINE identity = (recordId, updateOrdinal), unique per file: creation
//      lines have updateOrdinal == creationOrdinal; a settlement
//      re-publication PRESERVES creationOrdinal, ADVANCES updateOrdinal,
//      and self-points `updates` (updates === recordId).
//    · The writer's still-queued fast path swaps bytes in place: a settled
//      message durably lands as EITHER one already-settled line or two
//      (as-published + superseding) — never a third (S16).
//    · Readers fold LAST-WINS per recordId (loading.ts messages.set).
//    · Replay/fold kernels key on (recordId, updateOrdinal), NEVER on
//      recordId alone — unique-recordId keying collapses a supersession
//      chain (the absorbed repro-ctm-g05 red: true BY DESIGN, now law).
//
//    §A bridge derivation — recordId ≡ legacy uuid; minted when absent
//    §B vnext re-publication — same recordId, preserved creation, advanced
//       update, self-pointing `updates`; pair-keying distinguishes lines,
//       id-keying collapses them (the law's own observable)
//    §C REAL writer, fast path — settle while queued ⇒ ONE durable line,
//       already settled, self-pointing
//    §D REAL writer, re-publication — settle after drain ⇒ TWO durable
//       lines under one recordId, distinct updateOrdinals
//    §E reader fold — last-wins per recordId (the loading.ts:146 pin)
//
//  Seams: the real entryToRecord/encodeTranscriptLine/recordTranscript/
//  settleTranscriptMessage against a scratch home (ambient-state law).
// ============================================================================
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ctm-g05-law-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/tasks.js')
const { entryToRecord } = await import('../../src/fabric/entryCodec.js')
const { asOrdinal } = await import('../../src/fabric/ordinal.js')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.js')
const { recordTranscript, settleTranscriptMessage, getProject, setSessionFileForTesting } =
  await import('../../src/utils/sessionStorage/writer.js')
const { emptyFoldState, applyTranscriptEntry } = await import(
  '../../src/utils/sessionStorage/loading.js'
)
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.js')
const { createAssistantMessage } = await import('../../src/utils/messages/factories.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type RawRecord = {
  recordId: string
  creationOrdinal: string
  updateOrdinal: string
  updates?: string
  payload?: { kind?: string }
}

/** Raw record lines (the envelope view — NOT the projecting read seam). */
const rawRecords = (p: string): RawRecord[] =>
  existsSync(p)
    ? (readFileSync(p, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l) as RawRecord))
    : []

section('§A bridge derivation — recordId is MESSAGE identity (the legacy uuid)')
{
  let n = 0
  const ctx = {
    sessionId: 'a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5' as never,
    nextOrdinal: () => asOrdinal(String(++n)),
    observedAt: '2026-08-05T00:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const rec = entryToRecord(
    { type: 'user', message: { role: 'user', content: 'law' }, uuid, timestamp: ctx.observedAt },
    ctx,
  )
  check('a uuid line derives recordId ≡ uuid', String(rec.recordId) === uuid, String(rec.recordId))
  check(
    'a creation record has updateOrdinal == creationOrdinal and no `updates`',
    String(rec.updateOrdinal) === String(rec.creationOrdinal) && rec.updates === undefined,
    `creation=${String(rec.creationOrdinal)} update=${String(rec.updateOrdinal)} updates=${String(rec.updates)}`,
  )
  const minted1 = entryToRecord({ type: 'custom-title', customTitle: 'no uuid here' }, ctx)
  const minted2 = entryToRecord({ type: 'custom-title', customTitle: 'still no uuid' }, ctx)
  check(
    'uuid-less lines mint fresh distinct recordIds',
    Boolean(minted1.recordId) &&
      Boolean(minted2.recordId) &&
      String(minted1.recordId) !== String(minted2.recordId) &&
      String(minted1.recordId) !== uuid,
    `${String(minted1.recordId)} / ${String(minted2.recordId)}`,
  )
}

section('§B vnext re-publication — line identity is (recordId, updateOrdinal)')
{
  const file = join(HOME, 'b-encode.jsonl')
  const uuid = '11111111-2222-3333-4444-555555555555'
  const entry = {
    type: 'user',
    message: { role: 'user', content: 'one message, two published lines' },
    uuid,
    timestamp: '2026-08-05T00:00:00.000Z',
  }
  const first = encodeTranscriptLine(file, { ...entry })
  const r1 = first.record!
  const second = encodeTranscriptLine(
    file,
    { ...entry },
    { settleCreationOrdinal: String(r1.creationOrdinal) },
  )
  const r2 = second.record!
  check('re-publication REUSES the recordId (message identity held)', String(r1.recordId) === String(r2.recordId))
  check(
    'creationOrdinal preserved, updateOrdinal ADVANCED',
    String(r2.creationOrdinal) === String(r1.creationOrdinal) &&
      Number(r2.updateOrdinal) > Number(r1.updateOrdinal),
    `r1=(${String(r1.creationOrdinal)},${String(r1.updateOrdinal)}) r2=(${String(r2.creationOrdinal)},${String(r2.updateOrdinal)})`,
  )
  check('`updates` self-points on the superseding line', String(r2.updates) === String(r2.recordId))
  const pairKeys = new Set([
    `${String(r1.recordId)}@${String(r1.updateOrdinal)}`,
    `${String(r2.recordId)}@${String(r2.updateOrdinal)}`,
  ])
  const idKeys = new Set([String(r1.recordId), String(r2.recordId)])
  check(
    'pair-keying distinguishes both lines; id-keying collapses them (the law)',
    pairKeys.size === 2 && idKeys.size === 1,
    `pairs=${pairKeys.size} ids=${idKeys.size}`,
  )
}

section('§C REAL writer, fast path — settle while queued ⇒ ONE already-settled line')
{
  const file = join(HOME, 'c-fastpath.jsonl')
  setSessionFileForTesting(file)
  const msg = createAssistantMessage({ content: 'fast-path publication' })
  await recordTranscript([msg] as never)
  // Settle in the same tick — the 100 ms drain has not fired; the queued
  // line swaps in place (writer.ts settleMessage fast path).
  ;(msg.message.usage as { output_tokens: number }).output_tokens = 777
  await settleTranscriptMessage(msg as never)
  await getProject().flush()

  const mine = rawRecords(file).filter(r => r.recordId === msg.uuid)
  check('exactly ONE durable line for the message', mine.length === 1, `lines=${mine.length}`)
  const line = mine[0]
  check(
    'the single line is ALREADY SETTLED: preserved creation, advanced update, self-pointing',
    line !== undefined &&
      Number(line.updateOrdinal) > Number(line.creationOrdinal) &&
      line.updates === line.recordId,
    line ? `(${line.creationOrdinal},${line.updateOrdinal}) updates=${String(line.updates)}` : 'missing',
  )
  const projected = decodeTranscriptBuffer<Record<string, unknown>>(readFileSync(file)).entries
  const view = projected.find(e => e.uuid === msg.uuid) as
    | { message?: { usage?: { output_tokens?: number } } }
    | undefined
  check('the settled bytes are the durable bytes', view?.message?.usage?.output_tokens === 777)
}

section('§D REAL writer, re-publication — settle after drain ⇒ TWO lines, one recordId')
{
  const file = join(HOME, 'd-republication.jsonl')
  setSessionFileForTesting(file)
  const msg = createAssistantMessage({ content: 'as-published, then superseded' })
  await recordTranscript([msg] as never)
  await getProject().flush() // the as-published line is durable
  ;(msg.message.usage as { output_tokens: number }).output_tokens = 888
  await settleTranscriptMessage(msg as never)
  await getProject().flush()

  const mine = rawRecords(file).filter(r => r.recordId === msg.uuid)
  check('exactly TWO durable lines under the one recordId (never a third)', mine.length === 2, `lines=${mine.length}`)
  const [a, b] = mine
  check(
    'line identities are distinct: same recordId, distinct updateOrdinals',
    a !== undefined && b !== undefined && a.recordId === b.recordId && a.updateOrdinal !== b.updateOrdinal,
    a && b ? `a@${a.updateOrdinal} b@${b.updateOrdinal}` : 'missing',
  )
  check(
    'the superseding line preserves creationOrdinal, advances updateOrdinal, self-points',
    a !== undefined &&
      b !== undefined &&
      b.creationOrdinal === a.creationOrdinal &&
      Number(b.updateOrdinal) > Number(a.updateOrdinal) &&
      b.updates === b.recordId &&
      a.updates === undefined,
    a && b
      ? `a=(${a.creationOrdinal},${a.updateOrdinal},${String(a.updates)}) b=(${b.creationOrdinal},${b.updateOrdinal},${String(b.updates)})`
      : 'missing',
  )

  section('§E reader fold — last-wins per recordId (the loading.ts pin)')
  const decoded = decodeTranscriptBuffer<Record<string, unknown>>(readFileSync(file)).entries
  const duplicates = decoded.filter(e => e.uuid === msg.uuid)
  check('the projecting read seam yields BOTH lines in publication order', duplicates.length === 2)
  const st = emptyFoldState()
  for (const entry of decoded) applyTranscriptEntry(st, entry as never)
  const folded = st.messages.get(msg.uuid as never) as
    | { message?: { usage?: { output_tokens?: number } } }
    | undefined
  check(
    'the fold keeps ONE message per recordId and it is the SETTLED state',
    st.messages.size === 1 && folded?.message?.usage?.output_tokens === 888,
    `size=${st.messages.size} tokens=${folded?.message?.usage?.output_tokens}`,
  )
  // The absorbed red, stated positively: an id-keyed map of LINES loses one;
  // the pair-keyed map holds both.
  const idKeyed = new Map(mine.map(r => [r.recordId, r]))
  const pairKeyed = new Map(mine.map(r => [`${r.recordId}@${r.updateOrdinal}`, r]))
  check(
    'a unique-recordId line map collapses the chain; the PAIR map holds every line',
    idKeyed.size === 1 && pairKeyed.size === 2,
    `id=${idKeyed.size} pair=${pairKeyed.size}`,
  )
}

console.log(failures === 0 ? '\n ✅ THE IDENTITY LAW HOLDS (record.ts §7.1a)' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
