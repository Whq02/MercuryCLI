#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR!, 'think-pulse-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const CONFIG = join(HOME, 'config')
const DAEMON_DIR = join(HOME, 'daemon')
mkdirSync(CONFIG, { recursive: true })
mkdirSync(DAEMON_DIR, { recursive: true })
process.env.MERCURY_CONFIG_DIR = CONFIG
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
delete process.env.MERCURY_HOME
writeFileSync(join(DAEMON_DIR, 'control.key'), 'k'.repeat(64))

const words = await import('../../src/components/Spinner/liveCounterWords.ts')
const hud = await import('../../src/components/Spinner/spinnerHud.ts')
const { onSeatRow, onSeatSpawned } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail, publishSessionFacts, readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
type Facts = import('../../src/components/Spinner/liveCounterWords.ts').LiveCounterFacts

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const T = 1_800_000_000_000
const facts = (over: Partial<Facts>): Facts => ({ phase: 'thinking', sentAtMs: T - 271_000, firstByteAtMs: T - 270_000, replyChars: 0, thinkingChars: 0, wireOutputTokens: null, wait: null, ...over })
const line = (f: Facts, now = T): string => words.liveCounterSegments(words.liveCounterWords(f, now)).join(' · ')

section('§1 quiet words retain counters without heartbeat or block narration')
{
  const air = line(facts({ replyChars: 872, wireOutputTokens: 218, thinkingBlocks: 1, lastByteAtMs: T - 3_000 }))
  check(`known reply tokens remain exact: ${air}`, air === '4m 31s · ↓ 218', air)
  const opus = line(facts({ sentAtMs: T - 300_000, thinkingBlocks: 1, lastByteAtMs: T - 12_000 }))
  check(`unknown withheld thinking has no token count: ${opus}`, opus === '5m 0s', opus)
  const two = line(facts({ replyChars: 872, wireOutputTokens: 218, thinkingBlocks: 2, lastByteAtMs: T - 65_000 }))
  check(`multiple hidden blocks add no screen words: ${two}`, two === '4m 31s · ↓ 218', two)
  const absent = line(facts({}))
  check(`a seat without token facts paints only its clock: ${absent}`, absent === '4m 31s', absent)
  const texted = line(facts({ sentAtMs: T - 40_000, firstByteAtMs: T - 38_000, thinkingChars: 3_000, thinkingBlocks: 1, lastByteAtMs: T - 1_000 }))
  check(`thinking text retains one estimated total: ${texted}`, texted === '40s · ↓ ~750', texted)
  const writing = line(facts({ phase: 'writing', replyChars: 1_360, thinkingBlocks: 1, lastByteAtMs: T - 1_000 }))
  check(`reply prose retains one estimated total: ${writing}`, writing === '4m 31s · ↓ ~340', writing)
  const working = line(facts({ phase: 'working', replyChars: 1_360, thinkingBlocks: 1, lastByteAtMs: T - 1_000 }))
  check(`a running tool retains the existing total: ${working}`, working === '4m 31s · ↓ ~340', working)
  const wait = line(facts({ firstByteAtMs: null, thinkingBlocks: 0, lastByteAtMs: T - 1_000, wait: { kind: 'first-byte', cold: true, promptTokens: 65_000, model: 'Opus 5.5', budgetMs: 271_000, sinceMs: T - 12_000, attempt: 1 } }))
  check(`prefill keeps known zero and time, no budget: ${wait}`, wait === '4m 31s · ↓ 0', wait)
  const full = words.liveCounterWords(facts({ replyChars: 872, wireOutputTokens: 218, thinkingBlocks: 1, lastByteAtMs: T - 3_000, wait: { kind: 'silence', model: 'Opus 5.5', silentMs: 45_000, sinceMs: T - 45_000, answered: true } }), T)
  const wide = words.liveCounterLine(full, 120)
  const tight = words.liveCounterLine(full, 60)
  const tighter = words.liveCounterLine(full, 40)
  const tightest = words.liveCounterLine(full, 34)
  check('all four widths fit the same quiet row', [wide, tight, tighter, tightest].every(text => text === '4m 31s · ↓ 218'), j([wide, tight, tighter, tightest]))
  const never = [facts({ thinkingBlocks: 0, lastByteAtMs: null }), facts({ thinkingBlocks: 0 }), facts({ lastByteAtMs: Number.NaN })].map(f => line(f))
  check('no block and no stamp paint no extra words', never.every(text => text === '4m 31s'), j(never))
}

section('§2 spinner HUD keeps time and count without duplicate phase or heartbeat')
{
  const live = words.liveCounterWords(facts({ replyChars: 872, wireOutputTokens: 218, thinkingBlocks: 1, lastByteAtMs: T - 3_000 }), T)
  const plan = hud.planSpinnerHud(
    {
      mode: 'thinking',
      message: 'Build glowing…',
      columns: 100,
      verbose: false,
      still: false,
      suffixText: '',
      liveWords: live,
      effectiveElapsedMs: 271_000,
      otps: 0,
      wasStacked: true,
    },
    () => 2,
  )
  const keys = plan.ordered.map(segment => segment.key)
  check(`the HUD keeps only elapsed and count: ${keys.join(' · ')}`, keys.join(' · ') === 'timer · tokens', keys.join(' · '))
  const texts = plan.ordered.map(segment => segment.text)
  check(`the HUD reads the existing exact count: ${texts.join(' · ')}`, texts.join(' · ') === '4m 31s · ↓ 218', texts.join(' · '))
  check('the internal pulse remains available, not on screen', live.pulse === '↻3s' && live.phase === 'thinking')
  const row = read('src/components/Spinner/SpinnerAnimationRow.tsx')
  check('the row paints the quiet HUD in order', row.includes('for (const segment of ordered)'))
}

section('§3 THE SEAT — a reasoning block\'s start counts on the tail; text blocks do not; the outcome and a respawn zero it')
{
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-thinkpulse01'
  const SHORT = 'concourse-tp1'
  updateConcourseWorkers(workers => {
    workers[SHORT] = {
      schema: 1,
      runnerId: SHORT,
      sessionId: sid,
      workspaceId: 'ws-tp',
      isolation: 'exclusive',
      modelKey: 'claude-opus-5',
      effort: 'max',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
      workspaceKind: 'plain-folder',
    } as never
  }, DAEMON_DIR)
  const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
  const published = (): Promise<void> => new Promise(resolveWait => setTimeout(resolveWait, 80))
  const row = (o: Record<string, unknown>): Record<string, unknown> => ({ seq: 1, timestamp: 't', session_id: sid, turn: 1, ...o })
  const USAGE = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }
  const tail = () => readSessionTail(sid, DAEMON_DIR) as (ReturnType<typeof readSessionTail> & { turnThinkingBlocks?: number }) | null

  const before = Date.now()
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_1', block: 0, of: 'reasoning' }), roster as never, DAEMON_DIR)
  await published()
  check('RED ON THE BASE: a reasoning block\'s start publishes turnThinkingBlocks 1 on the tail', tail()?.turnThinkingBlocks === 1, j(tail()))
  check('…and the liveness stamp rides the same publish', typeof tail()?.lastEventAtMs === 'number' && (tail()?.lastEventAtMs ?? 0) >= before, j(tail()))
  onSeatRow(SHORT, row({ type: 'reasoning_delta', message_id: 'msg_1', block: 0, text: '' }), roster as never, DAEMON_DIR)
  onSeatRow(SHORT, row({ type: 'heartbeat' }), roster as never, DAEMON_DIR)
  await published()
  check('an empty reasoning delta and a heartbeat move the stamp, never the block count', tail()?.turnThinkingBlocks === 1 && (tail()?.turnThinkingChars ?? 0) === 0, j(tail()))
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_1', block: 1, of: 'text' }), roster as never, DAEMON_DIR)
  await published()
  check('a text block does not count as a thinking block', tail()?.turnThinkingBlocks === 1, j(tail()))
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_2', block: 0, of: 'reasoning' }), roster as never, DAEMON_DIR)
  await published()
  check('a second message\'s reasoning block counts 2 (per turn, across messages)', tail()?.turnThinkingBlocks === 2, j(tail()))
  onSeatRow(SHORT, row({ type: 'outcome', schema: 1, turn_id: 't-tp', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: {}, denials: [] }), roster as never, DAEMON_DIR)
  await published()
  check('the outcome zeroes the count (absent on the tail)', (tail()?.turnThinkingBlocks ?? 0) === 0, j(tail()))
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_3', block: 0, of: 'reasoning' }), roster as never, DAEMON_DIR)
  await published()
  check('the next turn counts afresh', tail()?.turnThinkingBlocks === 1, j(tail()))
  onSeatSpawned(SHORT, roster as never, DAEMON_DIR)
  await published()
  check('a respawn zeroes the half-turn\'s count', (tail()?.turnThinkingBlocks ?? 0) === 0, j(tail()))

  section('§4 THE CONNECTOR — the facts the status line reads carry the block count and the last byte\'s stamp while the turn is in flight')
  const record = { sessionId: sid, runnerId: SHORT, title: 'cockpit', projectLabel: 'scratch', workspaceId: 'ws-tp', home: CONFIG }
  const base = { schema: 1 as const, sessionId: sid, atMs: Date.now(), model: { effective: 'claude-opus-5', setting: null }, usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }, identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default' as const, workspace: { cwd: '/x', originalCwd: '/x', projectRoot: '/x', instructionRoots: [] }, queue: [], pendingModel: null, busy: true }
  const untilBusy = async (busy: boolean): Promise<void> => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const seen = readSessionFacts(sid, DAEMON_DIR) as { busy?: boolean } | null
      if (seen?.busy === busy) return
      await new Promise(r => setTimeout(r, 10))
    }
  }
  publishSessionFacts(base as never, DAEMON_DIR)
  await untilBusy(true)
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_4', block: 0, of: 'reasoning' }), roster as never, DAEMON_DIR)
  await published()
  const stamp = tail()?.lastEventAtMs
  const busySeat = new DaemonSessionConnector(record)
  await busySeat.attach()
  const inFlight = busySeat.turnFacts()
  busySeat.detach()
  check('RED ON THE BASE: the connector\'s turn facts carry thinkingBlocks 1', inFlight.thinkingBlocks === 1, j(inFlight))
  check('RED ON THE BASE: …and lastByteAtMs equal to the seat\'s liveness stamp', typeof stamp === 'number' && inFlight.lastByteAtMs === stamp, j({ stamp, facts: inFlight }))
  const pulse = words.liveCounterWords({ ...inFlight, phase: 'thinking', sentAtMs: Date.now() - 65_000 }, Date.now())
  check(`the status line keeps only the elapsed for unknown withheld output: ${words.liveCounterSegments(pulse).join(' · ')}`, words.liveCounterSegments(pulse).join(' · ') === '1m 5s', words.liveCounterSegments(pulse).join(' · '))
  publishSessionFacts({ ...base, busy: false } as never, DAEMON_DIR)
  await untilBusy(false)
  onSeatRow(SHORT, row({ type: 'outcome', schema: 1, turn_id: 't-tp2', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: {}, denials: [] }), roster as never, DAEMON_DIR)
  await published()
  const idleSeat = new DaemonSessionConnector(record)
  await idleSeat.attach()
  const idle = idleSeat.turnFacts()
  idleSeat.detach()
  check('idle: no block count and no stamp (the row paints nothing)', (idle.thinkingBlocks ?? 0) === 0 && idle.lastByteAtMs === null, j(idle))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-think-pulse-reading: ${failures} failure(s)`)
  process.exit(1)
}
console.log('PASS: internal thinking blocks and byte stamps survive; the screen stays quiet')
process.exit(0)
