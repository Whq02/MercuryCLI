#!/usr/bin/env bun
// ============================================================================
//  prove-coordinator-overflow — the context-overflow recovery ladder on the
//  coordinator's chair: a turn the provider refuses for not fitting the
//  window is answered in-turn (fold the durable conversation once through
//  the landed summarize-in-place owner, retry the turn once) instead of
//  refused raw; the exhaustion is a typed, visible refusal.
//
//    §1 recovered — the first call overflows, the fold runs with the
//       overflow clause on its marker, the retried turn reads the folded
//       replay and answers; the store holds marker + tail + the reply
//    §2 exhausted — the retry overflows too: ONE fold, TWO calls, a typed
//       refusal naming what was tried and the remedies
//    §3 the automatic-fold switch off — no fold, the refusal names /compact
//    §4 the flag off — today's surface (the raw failure text, no fold)
//    §5 a non-overflow failure is untouched (no fold, the plain reason)
//    §6 the live seam — the real coordinator call over a loopback answering
//       the home wire's refusal throws the TYPED overflow (family stamped)
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-coordinator-overflow.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — coordinator overflow prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

// ── env hygiene BEFORE any src import ───────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'coordinator-overflow-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_OVERFLOW_RECOVERY', 'ANTHROPIC_MODEL',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(join(scratch, 'daemon'), { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { startOverflowFixture, OVERFLOW_WIRE_SHAPES } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' coordinator overflow — fold once, retry once, refuse typed')
console.log('============================================================')

const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
const conv = await import('../../src/services/concourse/coordinatorConversation.ts')
const lane = await import('../../src/services/concourse/coordinatorLane.ts')
const { CoordinatorOverflowError, coordinatorOverflowOf } = await import('../../src/services/concourse/coordinatorOverflow.ts')
const { coordinatorCompactMarkerLine } = await import('../../src/services/concourse/coordinatorCompact.ts')

type Sig = import('../../src/services/api/overflowSignal.ts').OverflowSignal
const MODEL = 'claude-opus-4-8'
const SIGNAL: Sig = { source: 'provider', family: 'openai', shape: 'context-length-exceeded', actualTokens: 135_000, limitTokens: 128_000, detail: 'raw sentence' }
const overflowThrow = (): never => {
  throw new CoordinatorOverflowError(SIGNAL, 'API Error: OpenAI stream failed (openai-context_length_exceeded) — raw sentence')
}

saveGlobalConfig(c => ({ ...c, concourseCoordinator: { ...c.concourseCoordinator, mode: 'agent-assisted' as const, assistModel: MODEL } }))
check('the config took the assisted mode', getGlobalConfig().concourseCoordinator?.mode === 'agent-assisted')

const entry = (i: number) => ({ id: `op:a${i}`, role: 'operator' as const, text: `ask number ${i}`, ts: 1_700_000_000_000 + i * 1000 })
async function reseed(n: number): Promise<void> {
  await conv.clearCoordinatorConversation?.()
  for (let i = 0; i < n; i++) await conv.appendCoordinatorConversation(entry(i))
  lane._resetCoordinatorLaneForTesting()
}
const board = { counts: {}, sessions: [], openObligations: [] } as never

type Row = { role: string; text: string }
async function drive(opts: {
  id: string
  script: Array<'overflow' | 'reply' | 'plain-failure'>
  summary?: string
}): Promise<{ receipt: Record<string, unknown>; seen: Array<ReadonlyArray<Row> | undefined>; summarizeCalls: number }> {
  const seen: Array<ReadonlyArray<Row> | undefined> = []
  let summarizeCalls = 0
  let n = 0
  const receipt = (await lane.runOperatorMessageTurn(
    'and now?',
    {
      board,
      summarizeForCompact: async () => {
        summarizeCalls++
        return opts.summary ?? 'the overflow-folded thread, summarized'
      },
      callModel: async input => {
        seen.push(input.conversation as ReadonlyArray<Row> | undefined)
        const step = opts.script[Math.min(n++, opts.script.length - 1)]
        if (step === 'overflow') overflowThrow()
        if (step === 'plain-failure') throw new Error('the provider call failed before any answer arrived')
        return { decisions: [], reply: 'answered after the fold' }
      },
    },
    { clientMessageId: opts.id },
  )) as unknown as Record<string, unknown>
  return { receipt, seen, summarizeCalls }
}

//
section('§1 — recovered: overflow → the fold (marker names it) → the retried turn answers')
//
{
  await reseed(12)
  const r = await drive({ id: 'ovf-1', script: ['overflow', 'reply'] })
  check('the turn executed', r.receipt.outcome === 'executed', JSON.stringify(r.receipt).slice(0, 200))
  check('two model calls, one fold', r.seen.length === 2 && r.summarizeCalls === 1, `calls=${r.seen.length} folds=${r.summarizeCalls}`)
  check('the first call saw no marker (the fold came AFTER the refusal)', r.seen[0] !== undefined && !r.seen[0].some(row => row.text.startsWith('conversation compacted')))
  const marker = r.seen[1]?.find(row => row.text.startsWith('conversation compacted'))
  check('the retried call read the folded replay — the harness marker leads', marker !== undefined && marker.role === 'harness', JSON.stringify(r.seen[1]?.map(row => row.role)))
  check('the marker names the overflow, the family, the numbers, the retry', marker !== undefined && marker.text.includes(`(automatic — the context overflowed the ${MODEL} window: OpenAI: 135,000 tokens > 128,000; folded and the turn retried)`), marker?.text.slice(0, 220))
  const rows = await conv.readCoordinatorConversation()
  // Twelve seeded rows plus the operator's own entry (the door appends it
  // before the turn) = 13; the fold keeps the newest 8 and folds 5.
  check('the durable store holds marker + tail + the reply', rows.some(row => row.summary === true && row.text.startsWith(coordinatorCompactMarkerLine(5))) && rows.some(row => row.id === 'co:ovf-1' && row.text === 'answered after the fold'), JSON.stringify(rows.map(row => row.id)))
  check('the kept tail is exactly the newest eight (the operator ask among them)', rows.filter(row => row.summary !== true && row.id !== 'co:ovf-1').length === 8, String(rows.length))
}

//
section('§2 — exhausted: the retry overflows too → one fold, two calls, the typed refusal')
//
{
  await reseed(12)
  const r = await drive({ id: 'ovf-2', script: ['overflow', 'overflow'] })
  check('the turn refused', r.receipt.outcome === 'refused', JSON.stringify(r.receipt).slice(0, 200))
  check('exactly two calls and one fold — no third', r.seen.length === 2 && r.summarizeCalls === 1, `calls=${r.seen.length} folds=${r.summarizeCalls}`)
  const reason = String(r.receipt.reason ?? '')
  check('the refusal names the numbers, what was tried, and the remedies', reason.includes('context overflowed (OpenAI: 135,000 tokens > 128,000) — the conversation was folded and the turn retried once, and it still overflows; /clear starts fresh, or pick a model with a larger window'), reason)
  check('the raw sentence never rides the refusal', !reason.includes('raw sentence'))
  const rows = await conv.readCoordinatorConversation()
  check('the fold stands in the store (the marker survives the refusal)', rows.some(row => row.summary === true))
}

//
section('§3 — the automatic-fold switch off: no fold, the refusal names /compact')
//
{
  await reseed(12)
  process.env.DISABLE_AUTO_COMPACT = '1'
  const r = await drive({ id: 'ovf-3', script: ['overflow', 'reply'] })
  delete process.env.DISABLE_AUTO_COMPACT
  const reason = String(r.receipt.reason ?? '')
  check('refused after ONE call, no fold', r.receipt.outcome === 'refused' && r.seen.length === 1 && r.summarizeCalls === 0, `outcome=${String(r.receipt.outcome)} calls=${r.seen.length} folds=${r.summarizeCalls}`)
  check('the refusal names /compact by hand', reason.includes('automatic compaction is off, so the emergency fold did not run; /compact folds the conversation by hand'), reason)
}

//
section('§4 — the flag off: today\'s surface, the raw failure text, no fold')
//
{
  await reseed(12)
  process.env.MERCURY_OVERFLOW_RECOVERY = '0'
  const r = await drive({ id: 'ovf-4', script: ['overflow', 'reply'] })
  delete process.env.MERCURY_OVERFLOW_RECOVERY
  const reason = String(r.receipt.reason ?? '')
  check('refused after one call, no fold, the thrown text as the reason', r.receipt.outcome === 'refused' && r.seen.length === 1 && r.summarizeCalls === 0 && reason === 'coordinator turn failed — API Error: OpenAI stream failed (openai-context_length_exceeded) — raw sentence', reason)
}

//
section('§5 — a non-overflow failure is untouched')
//
{
  await reseed(12)
  const r = await drive({ id: 'ovf-5', script: ['plain-failure', 'reply'] })
  const reason = String(r.receipt.reason ?? '')
  check('refused with the plain reason, no fold', r.receipt.outcome === 'refused' && r.summarizeCalls === 0 && reason === 'coordinator turn failed — the provider call failed before any answer arrived', reason)
}

//
section('§6 — the live seam: the real coordinator call throws the TYPED overflow')
//
{
  const { liveCoordinatorCallModel } = await import('../../src/services/concourse/coordinatorCall.ts')
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  fixture.script([{ error: { status: shape.status, body: shape.body } }])
  let thrown: unknown
  try {
    await liveCoordinatorCallModel(
      {
        contractVersion: lane.COORDINATOR_CONTRACT_VERSION,
        contract: lane.COORDINATOR_CONTRACT,
        event: { kind: 'operator-message', messageId: 'live-1', text: 'status?' },
        board,
      },
      MODEL,
      {},
    )
  } catch (err) {
    thrown = err
  }
  const sig = coordinatorOverflowOf(thrown)
  check('the live call threw the typed overflow', thrown instanceof CoordinatorOverflowError, String(thrown))
  check('…stamped with the family and the numbers from the wire', sig?.family === 'anthropic' && sig.shape === 'prompt-too-long' && sig.actualTokens === 213_462, JSON.stringify(sig))
  check('the loopback saw exactly one request', fixture.captured.length === 1, String(fixture.captured.length))
}

//
section('§7 — the typed overflow survives the fail-soft catch (FN-017 rank 3)')
//
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/services/concourse/coordinatorCall.ts'), 'utf8')
  const catchAt = src.indexOf('} catch (err) {')
  const rethrowAt = src.indexOf('if (err instanceof CoordinatorOverflowError) throw err')
  const degradeAt = src.indexOf('if (!sawWork && soFar.length === 0) throw err')
  check('the catch rethrows CoordinatorOverflowError BEFORE the sawWork/soFar degrade (the ladder needs the typed error after round 0 spoke)', catchAt > 0 && rethrowAt > catchAt && degradeAt > rethrowAt, `catch=${catchAt} rethrow=${rethrowAt} degrade=${degradeAt}`)
}

await fixture.close()
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
console.log(failures ? `❌ COORDINATOR-OVERFLOW RED (${checks} checks)` : `✅ COORDINATOR-OVERFLOW GREEN (${checks} checks)`)
process.exit(failures)
