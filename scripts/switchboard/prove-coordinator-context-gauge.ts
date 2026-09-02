#!/usr/bin/env bun
// ============================================================================
//  prove-coordinator-context-gauge — the coordinator chat's context-fill
//  truth (chat-relief item 3's substrate).
//
//  The sighting this serves: the coordinator conversation survives restarts
//  by design, its context only ever grows, and NOTHING warned the operator
//  as it filled — no gauge existed at all. The fix: every assisted turn
//  stamps the provider's OWN usage envelope (input + cache reads + cache
//  writes of the largest round) beside the model it ran on, in the SAME
//  durable store the pane already subscribes to; the warning line derives
//  from that one fact through the main chat's own threshold law
//  (calculateTokenWarningState — never a second threshold system).
//
//  THE GAUGE-READS-A-DIFFERENT-SOURCE LAW (the lens class this pins
//  against): the display and the auto-compact decision read the STAMPED
//  provider usage — never a parallel estimator. A turn whose runtime
//  reported no input usage stamps NOTHING (the gauge goes honestly silent
//  rather than guessing).
//
//    §1 the store law — stamp → read → append preserves; junk decodes away;
//       /clear clears the gauge with the conversation
//    §2 the assisted turn stamps the gauge (the lane's callModel seam):
//       contextTokens + the model the turn ran on; a usage-less turn leaves
//       the prior stamp untouched (no fabricated estimate)
//    §3 the threshold relation — the warning levels over a stamped gauge
//       ride the main chat's own ladder (ok below the warn floor, warn
//       inside it, compact at the ceiling) for the gauge's model
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-coordinator-context-gauge.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── env hygiene BEFORE any src import ───────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'coordinator-gauge-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE']) {
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

console.log('============================================================')
console.log(' coordinator context gauge — provider usage in, honest warning out')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const conv = await import('../../src/services/concourse/coordinatorConversation.ts')

//
section('§1 — the store law: stamp, read, preserve, decode, clear')
//
{
  const dir = join(scratch, 's1')
  mkdirSync(dir, { recursive: true })
  const before = await conv.readCoordinatorGauge(dir)
  check('a fresh store holds no gauge', before === undefined, JSON.stringify(before))
  await conv.stampCoordinatorGauge({ contextTokens: 123_456, modelId: 'claude-opus-5', ts: 1_700_000_000_000 }, dir)
  const stamped = await conv.readCoordinatorGauge(dir)
  check('stamp → read roundtrips', stamped?.contextTokens === 123_456 && stamped.modelId === 'claude-opus-5', JSON.stringify(stamped))
  await conv.appendCoordinatorConversation({ id: 'op:g1', role: 'operator', text: 'hello', ts: 1 }, dir)
  const afterAppend = await conv.readCoordinatorGauge(dir)
  check('an append PRESERVES the gauge (the mutate spreads the file)', afterAppend?.contextTokens === 123_456, JSON.stringify(afterAppend))
  await conv.clearCoordinatorConversation(dir)
  const afterClear = await conv.readCoordinatorGauge(dir)
  check('/clear clears the gauge with the conversation', afterClear === undefined, JSON.stringify(afterClear))
  // Junk on disk decodes away instead of poisoning readers.
  await conv.stampCoordinatorGauge({ contextTokens: Number.NaN as never, modelId: 'x', ts: 1 }, dir)
  const junk = await conv.readCoordinatorGauge(dir)
  check('a junk stamp decodes to no gauge (NaN tokens)', junk === undefined, JSON.stringify(junk))
}

//
section('§2 — the assisted turn stamps the gauge (the lane seam)')
//
{
  const lane = await import('../../src/services/concourse/coordinatorLane.ts')
  lane._resetCoordinatorLaneForTesting()
  const board = { counts: {}, sessions: [], openObligations: [] } as never
  const turn = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'g2-1', text: 'status?' },
    {
      manager: true,
      managerModelId: 'claude-opus-5',
      board,
      callModel: async () => ({ decisions: [], reply: 'all quiet', turnUsage: { contextTokens: 42_000 } }),
    },
  )
  check('the turn executed', turn.outcome === 'executed', JSON.stringify({ outcome: turn.outcome, reason: turn.reason }))
  const g = await conv.readCoordinatorGauge()
  check('the gauge stamped the turn usage', g?.contextTokens === 42_000, JSON.stringify(g))
  check('…beside the model the turn ran on', g?.modelId === 'claude-opus-5', JSON.stringify(g))
  lane._resetCoordinatorLaneForTesting()
  const usageless = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'g2-2', text: 'again?' },
    {
      manager: true,
      managerModelId: 'claude-sonnet-5',
      board,
      callModel: async () => ({ decisions: [], reply: 'still quiet' }),
    },
  )
  check('a usage-less turn still executes', usageless.outcome === 'executed', JSON.stringify(usageless.outcome))
  const g2 = await conv.readCoordinatorGauge()
  check(
    'a usage-less turn leaves the prior stamp untouched (no fabricated estimate)',
    g2?.contextTokens === 42_000 && g2.modelId === 'claude-opus-5',
    JSON.stringify(g2),
  )
}

//
section('§3 — the threshold relation: the main chat’s own ladder over the gauge’s model')
//
{
  const auto = await import('../../src/services/compact/autoCompact.ts')
  const model = 'claude-opus-5'
  const ceiling = auto.getAutoCompactThreshold(model)
  check('the ceiling is a real positive threshold', Number.isFinite(ceiling) && ceiling > 50_000, String(ceiling))
  const below = auto.calculateTokenWarningState(Math.max(0, ceiling - 25_000), model)
  const inside = auto.calculateTokenWarningState(ceiling - 10_000, model)
  const over = auto.calculateTokenWarningState(ceiling + 1, model)
  check('25k under the ceiling: ok (nothing paints)', below.level === 'ok', below.level)
  check('10k under the ceiling: warn (the line paints)', inside.level === 'warn', inside.level)
  check('over the ceiling: compact', over.level === 'compact' || over.level === 'blocked', over.level)
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
console.log(failures ? '❌ COORDINATOR-CONTEXT-GAUGE RED' : '✅ COORDINATOR-CONTEXT-GAUGE GREEN')
process.exit(failures)
