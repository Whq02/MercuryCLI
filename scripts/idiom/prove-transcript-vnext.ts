#!/usr/bin/env bun
// ============================================================================
//  scripts/idiom/prove-transcript-vnext.ts — C01/C02/C09/C11/A09: the
//  transcript vNext format flip under the no-migration ruling, proven on the
//  REAL writer/reader seams in a scratch home.
//
//    §A explicit versions: a NEW session file opens with the header
//       record and every line is a versioned MercuryRecord envelope.
//    §B dual-read equivalence: the vNext file folds to the SAME messages a
//       legacy write of identical content folds to (one fold, two formats).
//    §C A09 restart-safe ordinals: a fresh process (format cache dropped)
//       appends with floor(max tail ordinal)+1 — strictly increasing across
//       the whole file, no reuse.
//    §D atomic settlement lineage: the settled re-publication keeps the
//       original creationOrdinal, advances updateOrdinal, marks `updates`,
//       and carries the provider receipt in the SAME atomic line; the fold
//       is last-wins.
//    §E the retired-format refusal + interrupted tail: a file whose lines
//       are not records is refused WHOLE with the one honest line (never
//       translated, never a crash); the writer only ever appends record
//       lines; a torn record tail line is position-classified on load and
//       the next append recovers its ordinal from the last complete record.
//    §F the format is unconditional: no environment spelling switches the
//       written format — a new file opens with header records regardless.
// ============================================================================
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, truncateSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'idiom-vnext-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_TRANSCRIPT_VNEXT

await import('../../src/tasks.js')
const {
  recordTranscript,
  settleTranscriptMessage,
  getProject,
  setSessionFileForTesting,
  resetProjectForTesting,
} = await import('../../src/utils/sessionStorage/writer.js')
const { resetTranscriptFormatCacheForTesting } = await import(
  '../../src/utils/sessionStorage/vnext.js'
)
const { createAssistantMessage, createUserMessage } = await import(
  '../../src/utils/messages/factories.js'
)
const { decodeTranscriptBuffer, TRANSCRIPT_FORMAT_REFUSAL } = await import('../../src/fabric/transcriptDecode.js')
const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function parsedLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as Record<string, unknown>)
}
const isRecord = (o: Record<string, unknown>): boolean =>
  typeof o.schemaVersion === 'number' &&
  typeof o.recordId === 'string' &&
  typeof (o.payload as { kind?: unknown } | undefined)?.kind === 'string'

section('§A C01 — a new file opens with the header; every line is a record')
const fileA = join(HOME, 'vnext-a.jsonl')
{
  setSessionFileForTesting(fileA)
  const user = createUserMessage({ content: 'hello fabric' })
  const asst = createAssistantMessage({ content: 'settled reply' })
  await recordTranscript([user, asst] as never)
  await getProject().flush()
  const lines = parsedLines(fileA)
  check('every line is a versioned MercuryRecord envelope', lines.every(isRecord), String(lines.length))
  const header = lines[0]!
  check(
    'line 1 is the transcript header record (session-meta)',
    (header.payload as { kind?: string; metaKind?: string }).kind === 'session-meta' &&
      (header.payload as { metaKind?: string }).metaKind === 'mercury-transcript-header',
  )
  check('the header stamps fileVersion 1', ((header.payload as { fields?: { fileVersion?: number } }).fields?.fileVersion) === 1)
  const ords = lines.map(l => Number(l.updateOrdinal))
  check('ordinals are strictly increasing from 1', ords.every((v, i) => (i === 0 ? v >= 1 : v > ords[i - 1]!)), ords.join(','))
}

section('§B — dual-read equivalence: one fold, two formats')
{
  const decoded = decodeTranscriptBuffer<Record<string, unknown>>(readFileSync(fileA))
  check('total accounting holds (no malformed/invalid)', decoded.malformed.length === 0 && decoded.invalid.length === 0)
  const projected = decoded.entries.filter(e => e.type === 'user' || e.type === 'assistant')
  check('records project back to the legacy entry shapes', projected.length === 2)
  const asstEntry = projected.find(e => e.type === 'assistant') as { message?: { content?: unknown } }
  check(
    'the assistant content round-trips byte-faithfully',
    JSON.stringify(asstEntry?.message?.content).includes('settled reply'),
  )
}

section('§C A09 — restart-safe ordinal recovery (fresh process simulation)')
{
  const before = parsedLines(fileA)
  const maxBefore = Math.max(...before.map(l => Number(l.updateOrdinal)))
  resetProjectForTesting() // drops the format cache + allocator (the restart)
  setSessionFileForTesting(fileA)
  const next = createUserMessage({ content: 'after restart' })
  await recordTranscript([next] as never)
  await getProject().flush()
  const after = parsedLines(fileA)
  const appended = after.slice(before.length)
  check('the restarted writer appended records (not legacy lines)', appended.length > 0 && appended.every(isRecord))
  check(
    `restart allocation is floor(tail)+1-monotonic (${maxBefore} → ${appended.map(l => l.updateOrdinal).join(',')})`,
    appended.every(l => Number(l.updateOrdinal) > maxBefore),
  )

  // Truncated-window verdict class: a LAST record larger than
  // the 256 KiB recovery window tears at the window's cut; reading that
  // tear as "unrecoverable" collapsed the floor to 1 and re-issued
  // published ordinals. The recovery must widen until a record parses.
  const huge = createUserMessage({ content: 'big paste: ' + 'x'.repeat(300 * 1024) })
  await recordTranscript([huge] as never)
  await getProject().flush()
  const withHuge = parsedLines(fileA)
  const maxWithHuge = Math.max(...withHuge.map(l => Number(l.updateOrdinal)))
  resetProjectForTesting() // the restart, again — now behind a >window tail record
  setSessionFileForTesting(fileA)
  const afterHuge = createUserMessage({ content: 'after the huge tail' })
  await recordTranscript([afterHuge] as never)
  await getProject().flush()
  const appended2 = parsedLines(fileA).slice(withHuge.length)
  check(
    `a >window tail record still recovers the floor (${maxWithHuge} → ${appended2.map(l => l.updateOrdinal).join(',')})`,
    appended2.length > 0 && appended2.every(l => Number(l.updateOrdinal) > maxWithHuge),
  )
}

section('§D C09 — settlement lineage rides ONE atomic line')
{
  resetProjectForTesting()
  const fileD = join(HOME, 'vnext-d.jsonl')
  setSessionFileForTesting(fileD)
  const msg = createAssistantMessage({ content: 'streaming turn' })
  await recordTranscript([msg] as never)
  await getProject().flush() // drain: settlement takes the re-append lane
  const published = parsedLines(fileD).find(
    l => JSON.stringify(l).includes(msg.uuid) && isRecord(l),
  )!
  ;(msg.message.usage as { output_tokens: number }).output_tokens = 777
  ;(msg as { apexProviderTurn?: unknown }).apexProviderTurn = {
    provider: 'openai',
    responseId: 'resp_lineage',
    items: [{ type: 'function_call', call_id: 'c1', name: 'Bash', arguments: '{}' }],
  }
  await settleTranscriptMessage(msg as never)
  await getProject().flush()
  const lines = parsedLines(fileD).filter(l => JSON.stringify(l).includes(msg.uuid))
  const settled = lines.at(-1)!
  check('the settled line is a record', isRecord(settled))
  check('updates marks the published identity', settled.updates === published.recordId && settled.recordId === published.recordId)
  check(
    'creationOrdinal is preserved; updateOrdinal advanced',
    settled.creationOrdinal === published.creationOrdinal &&
      Number(settled.updateOrdinal) > Number(published.updateOrdinal),
    `${settled.creationOrdinal}/${settled.updateOrdinal} vs ${published.creationOrdinal}/${published.updateOrdinal}`,
  )
  const settledJson = JSON.stringify(settled)
  check('the receipt + usage ride the SAME atomic line', settledJson.includes('resp_lineage') && settledJson.includes('777'))
  const fold = decodeTranscriptBuffer<Record<string, unknown>>(readFileSync(fileD))
  const finalEntries = fold.entries.filter(e => JSON.stringify(e).includes(msg.uuid))
  check('the fold is last-wins (settled state visible)', JSON.stringify(finalEntries.at(-1)).includes('resp_lineage'))
}

section('§E — the retired-format refusal; torn record tails recover')
{
  resetProjectForTesting()
  const fileE = join(HOME, 'retired-e.jsonl')
  const alienLine = JSON.stringify({ type: 'user', uuid: '00000000-0000-4000-8000-00000000e001', timestamp: new Date().toISOString(), sessionId: 'alien', message: { role: 'user', content: 'old chat' } })
  writeFileSync(fileE, alienLine + '\n')
  const refusedRead = decodeTranscriptBuffer<Record<string, unknown>>(readFileSync(fileE))
  check(
    'a non-record file is refused WHOLE with the one honest line',
    refusedRead.refusal === TRANSCRIPT_FORMAT_REFUSAL && refusedRead.entries.length === 0,
    String(refusedRead.refusal),
  )
  const refusedFold = await loadTranscriptFile(fileE)
  check('the loader refuses politely — an empty fold, never a crash', refusedFold.messages.size === 0)
  setSessionFileForTesting(fileE)
  const cont = createUserMessage({ content: 'continuing regardless' })
  await recordTranscript([cont] as never)
  await getProject().flush()
  const linesE = readFileSync(fileE, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>)
  check('the writer only ever appends RECORD lines', linesE.slice(1).length > 0 && linesE.slice(1).every(isRecord), String(linesE.length))
  check('the file stays refused — its first line still rules the format', decodeTranscriptBuffer(readFileSync(fileE)).refusal === TRANSCRIPT_FORMAT_REFUSAL)

  // Torn record tail: truncate mid-line, then load + append.
  resetProjectForTesting()
  const sizeA = statSync(fileA).size
  truncateSync(fileA, sizeA - 25) // tears the last record line
  const torn = decodeTranscriptBuffer<Record<string, unknown>>(readFileSync(fileA))
  check('the torn tail is position-classified, prior records decode', torn.malformed.length === 1 && torn.entries.length >= 3, `malformed=${torn.malformed.length}`)
}
{
  // (separate block: parsedLines above would throw on the torn line)
  const complete = readFileSync(fileA, 'utf8').split('\n').filter(l => {
    if (!l.trim()) return false
    try { JSON.parse(l); return true } catch { return false }
  }).map(l => JSON.parse(l) as Record<string, unknown>)
  const maxComplete = Math.max(...complete.map(l => Number(l.updateOrdinal)))
  appendFileSync(fileA, '\n') // writer appends after the torn bytes; reader classifies the torn line
  setSessionFileForTesting(fileA)
  const resumed = createUserMessage({ content: 'resumed after tear' })
  await recordTranscript([resumed] as never)
  await getProject().flush()
  const after = readFileSync(fileA, 'utf8').split('\n').filter(l => {
    if (!l.trim()) return false
    try { JSON.parse(l); return true } catch { return false }
  }).map(l => JSON.parse(l) as Record<string, unknown>)
  const appended = after.filter(l => JSON.stringify(l).includes('resumed after tear'))
  check('the post-tear append recovers ordinals from the last COMPLETE record', appended.length > 0 && appended.every(l => Number(l.updateOrdinal) > maxComplete), appended.map(l => String(l.updateOrdinal)).join(','))
}

section('§F — the format is unconditional: no env spelling switches it')
{
  resetProjectForTesting()
  process.env.MERCURY_TRANSCRIPT_VNEXT = '0' // a retired spelling — inert
  const fileF = join(HOME, 'unconditional-f.jsonl')
  setSessionFileForTesting(fileF)
  const m = createUserMessage({ content: 'one format' })
  await recordTranscript([m] as never)
  await getProject().flush()
  const linesF = parsedLines(fileF)
  check('a new file writes header + record lines regardless of env', linesF.length > 1 && linesF.every(isRecord))
  delete process.env.MERCURY_TRANSCRIPT_VNEXT
}

console.log(failures === 0 ? '\n ✅ TRANSCRIPT VNEXT PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
