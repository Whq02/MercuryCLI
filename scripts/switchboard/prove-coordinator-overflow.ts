#!/usr/bin/env bun
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

const scratch = mkdtempSync(join(tmpdir(), 'coordinator-overflow-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_MODEL',
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

section('§1 — recovered: overflow → the fold (marker names it) → the retried turn answers')
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
  check('the durable store holds marker + tail + the reply', rows.some(row => row.summary === true && row.text.startsWith(coordinatorCompactMarkerLine(5))) && rows.some(row => row.id === 'co:ovf-1' && row.text === 'answered after the fold'), JSON.stringify(rows.map(row => row.id)))
  check('the kept tail is exactly the newest eight (the operator ask among them)', rows.filter(row => row.summary !== true && row.id !== 'co:ovf-1').length === 8, String(rows.length))
}

section('§2 — exhausted: the retry overflows too → one fold, two calls, the typed refusal')
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

section('§3 — the automatic-fold switch off: no fold, the refusal names /compact')
{
  await reseed(12)
  process.env.MERCURY_AUTO_COMPACT = '0'
  const r = await drive({ id: 'ovf-3', script: ['overflow', 'reply'] })
  delete process.env.MERCURY_AUTO_COMPACT
  const reason = String(r.receipt.reason ?? '')
  check('refused after ONE call, no fold', r.receipt.outcome === 'refused' && r.seen.length === 1 && r.summarizeCalls === 0, `outcome=${String(r.receipt.outcome)} calls=${r.seen.length} folds=${r.summarizeCalls}`)
  check('the refusal names /compact by hand', reason.includes('automatic compaction is off, so the emergency fold did not run; /compact folds the conversation by hand'), reason)
}

section('§4 — the flag off: today\'s surface, the raw failure text, no fold')
{
  await reseed(12)
  process.env.MERCURY_OVERFLOW_RECOVERY = '0'
  const r = await drive({ id: 'ovf-4', script: ['overflow', 'reply'] })
  delete process.env.MERCURY_OVERFLOW_RECOVERY
  const reason = String(r.receipt.reason ?? '')
  check('refused after one call, no fold, the thrown text as the reason', r.receipt.outcome === 'refused' && r.seen.length === 1 && r.summarizeCalls === 0 && reason === 'coordinator turn failed — API Error: OpenAI stream failed (openai-context_length_exceeded) — raw sentence', reason)
}

section('§5 — a non-overflow failure is untouched')
{
  await reseed(12)
  const r = await drive({ id: 'ovf-5', script: ['plain-failure', 'reply'] })
  const reason = String(r.receipt.reason ?? '')
  check('refused with the plain reason, no fold', r.receipt.outcome === 'refused' && r.summarizeCalls === 0 && reason === 'coordinator turn failed — the provider call failed before any answer arrived', reason)
}

section('§6 — the live seam: the real coordinator call throws the TYPED overflow')
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

section('§7 — the typed overflow survives the fail-soft catch (FN-017 rank 3)')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/services/concourse/coordinatorCall.ts'), 'utf8')
  const catchAt = src.indexOf('} catch (err) {')
  const rethrowAt = src.indexOf('if (err instanceof CoordinatorOverflowError) throw err')
  const degradeAt = src.indexOf('if (!sawWork && soFar.length === 0) {')
  check('the catch rethrows CoordinatorOverflowError BEFORE the sawWork/soFar degrade (the ladder needs the typed error after round 0 spoke)', catchAt > 0 && rethrowAt > catchAt && degradeAt > rethrowAt, `catch=${catchAt} rethrow=${rethrowAt} degrade=${degradeAt}`)
}

section('§8 — the deadline owner: an expired budget is named as the budget, a caller cancel keeps its own words')
{
  const { coordinatorDeadlineExpired, coordinatorDeadlineWords, COORDINATOR_TURN_WALL_MS } = await import('../../src/services/concourse/coordinatorCall.ts')
  const { COORDINATOR_COMPACT_WALL_MS } = await import('../../src/services/concourse/coordinatorCompact.ts')
  const expired = AbortSignal.timeout(1)
  await new Promise(r => setTimeout(r, 20))
  check('a fired AbortSignal.timeout reads as the deadline (its reason is a TimeoutError)', expired.aborted && coordinatorDeadlineExpired(expired))
  const cancelled = new AbortController()
  cancelled.abort(new Error('the operator pressed esc'))
  check('a caller abort is NOT the deadline', cancelled.signal.aborted && !coordinatorDeadlineExpired(cancelled.signal))
  check('a live signal is neither', !coordinatorDeadlineExpired(AbortSignal.timeout(60_000)))
  const providerAbort = new Error('Request was aborted.')
  check('the turn words name the budget when the deadline fired, whatever the provider error said', coordinatorDeadlineWords(expired, COORDINATOR_TURN_WALL_MS, 'the coordinator turn', providerAbort) === 'the coordinator turn hit its 120 s budget before the provider finished')
  check("the compact words name its own budget", coordinatorDeadlineWords(expired, COORDINATOR_COMPACT_WALL_MS, 'the summary call', providerAbort) === 'the summary call hit its 60 s budget before the provider finished')
  check('a caller cancel keeps the error\'s own words', coordinatorDeadlineWords(cancelled.signal, COORDINATOR_TURN_WALL_MS, 'the coordinator turn', providerAbort) === 'Request was aborted.')
  check('a non-signal failure keeps its own words', coordinatorDeadlineWords(AbortSignal.timeout(60_000), COORDINATOR_TURN_WALL_MS, 'the coordinator turn', new Error('no account')) === 'no account')
  const { readFileSync } = await import('node:fs')
  const call = readFileSync(join(import.meta.dir, '..', '..', 'src/services/concourse/coordinatorCall.ts'), 'utf8')
  const compact = readFileSync(join(import.meta.dir, '..', '..', 'src/services/concourse/coordinatorCompact.ts'), 'utf8')
  const tools = readFileSync(join(import.meta.dir, '..', '..', 'src/services/concourse/coordinatorTools.ts'), 'utf8')
  const rg = readFileSync(join(import.meta.dir, '..', '..', 'src/utils/ripgrep.ts'), 'utf8')
  check('the turn\'s ONE signal is the wall budget and both catch arms speak through the owner', call.includes('const signal = AbortSignal.timeout(COORDINATOR_TURN_WALL_MS)') && call.includes("if (coordinatorDeadlineExpired(signal)) throw new Error(coordinatorDeadlineWords(signal, COORDINATOR_TURN_WALL_MS, 'the coordinator turn', err))") && call.includes("const why = coordinatorDeadlineWords(signal, COORDINATOR_TURN_WALL_MS, 'the coordinator turn', err)"))
  check('the compact call holds its signal, names its budget on a throw and on an empty answer after expiry', compact.includes('const signal = AbortSignal.timeout(COORDINATOR_COMPACT_WALL_MS)') && compact.includes("throw new Error(coordinatorDeadlineWords(signal, COORDINATOR_COMPACT_WALL_MS, 'the summary call', err))") && compact.includes("coordinatorDeadlineExpired(signal) ? coordinatorDeadlineWords(signal, COORDINATOR_COMPACT_WALL_MS, 'the summary call', undefined) : 'the summarizer returned no text'"))
  check('the grep walk\'s 10 s deadline is owned by ripGrepAnswer: a TimeoutError reason is the timeout arm, a bare abort is the cancel arm, and the answer carries complete/incomplete', tools.includes('await ripGrepAnswer(args, target, AbortSignal.timeout(10_000))') && tools.includes("...(answer.complete ? {} : { incomplete: answer.reason ?? 'the search did not finish' })") && rg.includes("(abortSignal.reason as { name?: string } | undefined)?.name === 'TimeoutError'") && rg.includes("const isAbort = code === 'ABORT_ERR' && !signalTimedOut"))
}

await fixture.close()
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
console.log(failures ? `❌ COORDINATOR-OVERFLOW RED (${checks} checks)` : `✅ COORDINATOR-OVERFLOW GREEN (${checks} checks)`)
process.exit(failures)
