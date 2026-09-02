// ============================================================================
//  prove-transcript-degradation-stated — FN-013 CRASH-05a: a load that
//  classifies malformed or shape-invalid records STATES it in-session, and
//  a whole-file refusal is stated rather than resuming silently empty.
//
//  The loader always classified damage and folded the valid set — but the
//  fact reached logError alone (operator-invisible), and a refused file
//  returned an empty fold with nobody told: a session could resume as if
//  it had no history. The classification now latches a subscribable fact
//  (the writer's store-health pattern) that the chat paints as one sticky
//  notification. The repair half (quarantine + rewrite) is the split's
//  deferred sibling — nothing here touches bytes, and this proof pins that
//  the bytes stay in place.
//
//    §1 a torn final line: the fact latches with counts and the path; the
//       fold proceeds on the valid records; the file is untouched.
//    §2 the subscription fires on latch (the surface's wiring contract).
//    §3 a whole-file refusal latches the refusal sentence — the empty
//       resume is no longer silent; the bytes stay in place.
//    §4 a clean load latches NOTHING.
//    §5 the chat wiring, structural: one sticky notification, both
//       sentences, painted from the latch.
//
//  Run:  ~/.bun/bin/bun run scripts/sessionStorage/prove-transcript-degradation-stated.ts
// ============================================================================
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
    userType: 'external',
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

section('§1 a torn final line is STATED — counts, path, valid records folded')
{
  loading._resetTranscriptLoadDegradationForTesting()
  const path = join(scratch, `${SID}.jsonl`)
  const damaged = recordLines(path) + '{"recordId":"torn-mid-append'
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
  writeFileSync(path, recordLines(path) + '{"torn')
  await loading.loadTranscriptFile(path)
  check('the listener fired exactly once for one degraded load', fired === 1, String(fired))
  unsubscribe()
}

section('§3 a whole-file refusal is stated — the empty resume is not silent')
{
  loading._resetTranscriptLoadDegradationForTesting()
  const path = join(scratch, `${SID}-refused.jsonl`)
  // The refusal law: the first PARSEABLE object line decides — a foreign
  // JSON file (not the record envelope) refuses whole.
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
