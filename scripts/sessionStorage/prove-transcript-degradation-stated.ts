;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'degradation-home-'))
const scratch = mkdtempSync(join(tmpdir(), 'degradation-'))

const loading = await import('../../src/utils/sessionStorage/loading.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const SID = '00000000-dddd-eeee-ffff-000000000d05'
function recordLines(path: string): string {
  let encoded = ''
  const meta = (uuid: string, parent: string | null) => ({
    isSidechain: false,
    entrypoint: 'cli',
    cwd: scratch,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: '',
    parentUuid: parent,
    uuid,
    timestamp: '2026-09-01T06:00:00.000Z',
  })
  const u1 = '00000000-0000-4000-8000-00000000d501'
  const a1 = '00000000-0000-4000-8000-00000000d502'
  encoded += (encodeTranscriptLine as (p: string, e: Record<string, unknown>) => { line: string })(path, {
    ...meta(u1, null),
    type: 'user',
    message: { role: 'user', content: 'the damaged chat begins' },
  }).line
  encoded += (encodeTranscriptLine as (p: string, e: Record<string, unknown>) => { line: string })(path, {
    ...meta(a1, u1),
    type: 'assistant',
    message: { role: 'assistant', model: 'glm-5.3', content: [{ type: 'text', text: 'answered.' }] },
  }).line
  return encoded
}

section('§1 a torn final line is NOT stated — the line is still being written; the valid records fold and the fact stays null')
{
  loading._resetTranscriptLoadDegradationForTesting()
  const path = join(scratch, `${SID}.jsonl`)
  const damaged = recordLines(path) + '{"recordId":"torn-mid-append'
  writeFileSync(path, damaged)
  const loaded = await loading.loadTranscriptFile(path)
  const fact = loading.transcriptLoadDegradation()
  check('no fact latched for an unterminated final line', fact === null, JSON.stringify(fact))
  check('the fold proceeded on the valid records', loaded.messages.size === 2, String(loaded.messages.size))
  check('nothing was repaired — the bytes stay in place', readFileSync(path, 'utf8') === damaged)
}

section('§1b a torn final line completed by the writer folds on the growth read; one that stays malformed is stated there, once')
{
  loading._resetTranscriptLoadDegradationForTesting()
  const path = join(scratch, `${SID}-growth.jsonl`)
  const third = (encodeTranscriptLine as (p: string, e: Record<string, unknown>) => { line: string })(path, {
    isSidechain: false,
    entrypoint: 'cli',
    cwd: scratch,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: '',
    parentUuid: '00000000-0000-4000-8000-00000000d502',
    uuid: '00000000-0000-4000-8000-00000000d503',
    timestamp: '2026-09-01T06:00:01.000Z',
    type: 'user',
    message: { role: 'user', content: 'the third line, written in two halves' },
  }).line
  const cut = Math.floor(third.length / 2)
  writeFileSync(path, recordLines(path) + third.slice(0, cut))
  const first = await loading.loadTranscriptFile(path)
  check('the half-written line is left for the writer: two records folded, no fact', first.messages.size === 2 && loading.transcriptLoadDegradation() === null, JSON.stringify(loading.transcriptLoadDegradation()))
  writeFileSync(path, recordLines(path) + third)
  const second = await loading.loadTranscriptFile(path)
  check('the growth read folds the completed line whole and states nothing', second.messages.size === 3 && loading.transcriptLoadDegradation() === null, `${second.messages.size} ${JSON.stringify(loading.transcriptLoadDegradation())}`)

  loading._resetTranscriptLoadDegradationForTesting()
  const stays = join(scratch, `${SID}-stays.jsonl`)
  writeFileSync(stays, recordLines(stays) + '{"recordId":"torn-mid-append')
  await loading.loadTranscriptFile(stays)
  check('a torn tail alone is not stated on the load', loading.transcriptLoadDegradation() === null)
  writeFileSync(stays, recordLines(stays) + '{"recordId":"torn-mid-append and never a record\n')
  await loading.loadTranscriptFile(stays)
  const stated = loading.transcriptLoadDegradation()
  check('a completed line that is still malformed is stated by the growth read, counted once', stated !== null && stated.malformed === 1 && stated.invalid === 0 && stated.path === stays, JSON.stringify(stated))
}

section('§1c a malformed line inside the file is STATED — counts, path, valid records folded')
{
  loading._resetTranscriptLoadDegradationForTesting()
  const path = join(scratch, `${SID}-mid.jsonl`)
  const damaged = recordLines(path) + '{"recordId":"broken-in-the-middle\n'
  writeFileSync(path, damaged)
  const loaded = await loading.loadTranscriptFile(path)
  const fact = loading.transcriptLoadDegradation()
  check('the fact latched', fact !== null, JSON.stringify(fact))
  check(
    'it names the count and the path, refusal null',
    fact !== null && fact.malformed === 1 && fact.invalid === 0 && fact.path === path && fact.refusal === null,
    JSON.stringify(fact),
  )
  check('the fold proceeded on the valid records', loaded.messages.size === 2, String(loaded.messages.size))
  check('nothing was repaired — the bytes stay in place', readFileSync(path, 'utf8') === damaged)
}

section('§2 the subscription fires on latch')
{
  loading._resetTranscriptLoadDegradationForTesting()
  let fired = 0
  const unsubscribe = loading.subscribeTranscriptLoadDegradation(() => {
    fired++
  })
  const path = join(scratch, `${SID}-sub.jsonl`)
  writeFileSync(path, recordLines(path) + '{"torn\n')
  await loading.loadTranscriptFile(path)
  check('the listener fired exactly once for one degraded load', fired === 1, String(fired))
  unsubscribe()
}

section('§3 a whole-file refusal is stated — the empty resume is not silent')
{
  loading._resetTranscriptLoadDegradationForTesting()
  const path = join(scratch, `${SID}-refused.jsonl`)
  const foreign = '{"not":"a transcript"}\n{"still":"not one"}\n'
  writeFileSync(path, foreign)
  const loaded = await loading.loadTranscriptFile(path)
  const fact = loading.transcriptLoadDegradation()
  check('the load resumed empty (the pre-law behaviour, unchanged this slice)', loaded.messages.size === 0)
  check('…but the refusal is STATED with the path', fact !== null && fact.refusal !== null && fact.path === path, JSON.stringify(fact))
  check('the bytes stay in place (repair is the deferred half)', readFileSync(path, 'utf8') === foreign)
}

section('§4 a clean load latches nothing')
{
  loading._resetTranscriptLoadDegradationForTesting()
  const path = join(scratch, `${SID}-clean.jsonl`)
  writeFileSync(path, recordLines(path))
  const loaded = await loading.loadTranscriptFile(path)
  check('clean fold', loaded.messages.size === 2)
  check('no fact', loading.transcriptLoadDegradation() === null)
}

section('§5 the chat wiring, structural')
{
  const repl = readFileSync(join(import.meta.dir, '../../src/screens/REPL.tsx'), 'utf8')
  check('the chat paints the latch as ONE sticky notification', repl.includes("key: 'transcript-degraded'") && repl.includes('subscribeTranscriptLoadDegradation'))
  check('the partial-degradation sentence states counts, path and the no-repair honesty', repl.includes('the valid records loaded; nothing was repaired'))
  check('the refusal sentence states the empty resume', repl.includes('resumed WITHOUT its prior records'))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-transcript-degradation-stated — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-transcript-degradation-stated — all checks pass')
process.exit(0)
