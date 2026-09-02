#!/usr/bin/env bun
// ============================================================================
//  prove-coordinator-auto-compact — auto-compaction reaches the coordinator
//  chat (chat-relief item 2): the message door folds BEFORE the model turn,
//  riding the LANDED threshold law over the stamped gauge — never a second
//  threshold system — plus the store-cap arm that pre-empts the silent
//  eviction at CONVERSATION_CAP (the silent-downgrade-or-drop class).
//
//    §1 quiet world — below the ceiling and the cap: no fold, the
//       summarizer never invoked
//    §2 the context-threshold arm — the stamped gauge over the model's own
//       auto-compact ceiling folds, the marker names the WINDOW as the
//       reason (the operator is never surprised), the gauge clears
//    §3 the store-cap arm — a conversation near CONVERSATION_CAP folds with
//       the cap named, BEFORE the cap can evict silently
//    §4 the kill switch — DISABLE_COMPACT gates both arms (the one law
//       with the main chat)
//    §5 the door — runOperatorMessageTurn folds first, so the turn that
//       follows READS the folded tail: the model's replay opens on the
//       harness summary row, and the durable store holds marker + tail +
//       the turn's reply
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-coordinator-auto-compact.ts
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
const scratch = mkdtempSync(join(tmpdir(), 'coordinator-autocompact-'))
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
console.log(' coordinator auto-compaction — the landed law, this surface')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const conv = await import('../../src/services/concourse/coordinatorConversation.ts')
const compact = await import('../../src/services/concourse/coordinatorCompact.ts')
const { getAutoCompactThreshold } = await import('../../src/services/compact/autoCompact.ts')

const MODEL = 'claude-opus-5'
const CEILING = getAutoCompactThreshold(MODEL)

const entry = (i: number) => ({
  id: `op:a${i}`,
  role: 'operator' as const,
  text: `ask number ${i}`,
  ts: 1_700_000_000_000 + i * 1000,
})
const seed = async (dir: string, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await conv.appendCoordinatorConversation(entry(i), dir)
}

//
section('§1 — quiet world: below the ceiling and the cap, nothing folds')
//
{
  const dir = join(scratch, 'q')
  mkdirSync(dir, { recursive: true })
  await seed(dir, 12)
  await conv.stampCoordinatorGauge({ contextTokens: Math.max(1, CEILING - 40_000), modelId: MODEL, ts: 1 }, dir)
  let calls = 0
  const r = await compact.maybeAutoCompactCoordinator(MODEL, {
    dir,
    summarize: async () => {
      calls++
      return 'never'
    },
  })
  check('no fold fired', r.compacted === 0 && r.trigger === undefined, JSON.stringify(r))
  check('the summarizer was never invoked', calls === 0, String(calls))
  check('the twelve rows stand', (await conv.readCoordinatorConversation(dir)).length === 12)
}

//
section('§2 — the context-threshold arm: the gauge over the ceiling folds, naming the window')
//
{
  const dir = join(scratch, 'ctx')
  mkdirSync(dir, { recursive: true })
  await seed(dir, 12)
  await conv.stampCoordinatorGauge({ contextTokens: CEILING + 1, modelId: MODEL, ts: 1 }, dir)
  const r = await compact.maybeAutoCompactCoordinator(MODEL, { dir, summarize: async () => 'the folded thread, summarized' })
  check('the fold fired on the threshold arm', r.trigger === 'context-threshold' && r.compacted === 4, JSON.stringify(r))
  const rows = await conv.readCoordinatorConversation(dir)
  const marker = rows[0]!
  check('the marker leads with the fold sentence', marker.text.startsWith(compact.coordinatorCompactMarkerLine(4)), marker.text.slice(0, 60))
  check(
    '…and NAMES the window as the reason (the operator is never surprised)',
    marker.text.includes(`(automatic — the context neared the ${MODEL} window)`),
    marker.text.slice(0, 160),
  )
  check('…harness-voiced with the summary flag', marker.harness === true && marker.summary === true)
  check('the gauge cleared with the fold', (await conv.readCoordinatorGauge(dir)) === undefined)
  check('the keep tail survives', rows.length === 1 + 8, String(rows.length))
}

//
section('§3 — the store-cap arm: near CONVERSATION_CAP the fold pre-empts the silent eviction')
//
{
  const dir = join(scratch, 'cap')
  mkdirSync(dir, { recursive: true })
  await seed(dir, conv.CONVERSATION_CAP - compact.CONVERSATION_CAP_FOLD_MARGIN)
  const r = await compact.maybeAutoCompactCoordinator(MODEL, { dir, summarize: async () => 'the capped thread, summarized' })
  check('the fold fired on the cap arm', r.trigger === 'store-cap' && r.compacted > 0, JSON.stringify(r))
  const rows = await conv.readCoordinatorConversation(dir)
  check('the marker names the stored cap as the reason', rows[0]!.text.includes('(automatic — the conversation neared its stored cap)'), rows[0]!.text.slice(0, 160))
  check('the conversation is far from the cap again', rows.length === 1 + 8, String(rows.length))
}

//
section('§4 — the kill switch gates both arms (the one law with the main chat)')
//
{
  const dir = join(scratch, 'kill')
  mkdirSync(dir, { recursive: true })
  await seed(dir, 12)
  await conv.stampCoordinatorGauge({ contextTokens: CEILING + 1, modelId: MODEL, ts: 1 }, dir)
  process.env.DISABLE_COMPACT = '1'
  let calls = 0
  const r = await compact.maybeAutoCompactCoordinator(MODEL, {
    dir,
    summarize: async () => {
      calls++
      return 'never'
    },
  })
  delete process.env.DISABLE_COMPACT
  check('DISABLE_COMPACT held the fold', r.compacted === 0 && calls === 0, JSON.stringify({ r, calls }))
}

//
section('§5 — the door folds FIRST, and the turn reads the folded tail')
//
{
  // The default store (the scratch config home) — the door passes no dir.
  const { getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { ...c.concourseCoordinator, mode: 'agent-assisted' as const, assistModel: MODEL } }))
  check('the config took the assisted mode', getGlobalConfig().concourseCoordinator?.mode === 'agent-assisted')
  for (let i = 0; i < 12; i++) await conv.appendCoordinatorConversation(entry(i))
  await conv.stampCoordinatorGauge({ contextTokens: CEILING + 1, modelId: MODEL, ts: 1 })
  const lane = await import('../../src/services/concourse/coordinatorLane.ts')
  lane._resetCoordinatorLaneForTesting()
  let seenConversation: ReadonlyArray<{ role: string; text: string }> | undefined
  const receipt = await lane.runOperatorMessageTurn(
    'and now?',
    {
      board: { counts: {}, sessions: [], openObligations: [] } as never,
      summarizeForCompact: async () => 'the auto-folded thread, summarized',
      callModel: async input => {
        seenConversation = input.conversation
        return { decisions: [], reply: 'read the summary, all set' }
      },
    },
    { clientMessageId: 'auto-door-1' },
  )
  check('the turn executed', !('kind' in receipt) && receipt.outcome === 'executed', JSON.stringify(receipt).slice(0, 200))
  const markerRow = seenConversation?.find(r => r.text.startsWith('conversation compacted'))
  check('the model’s replay carries the harness summary row (the fold ran FIRST)', markerRow !== undefined && markerRow.role === 'harness', JSON.stringify(seenConversation?.map(r => r.role)))
  const rows = await conv.readCoordinatorConversation()
  check('the durable store holds marker + tail + the turn’s exchange', rows.some(r => r.summary === true) && rows.some(r => r.id === 'co:auto-door-1'), JSON.stringify(rows.map(r => r.id)))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
console.log(failures ? '❌ COORDINATOR-AUTO-COMPACT RED' : '✅ COORDINATOR-AUTO-COMPACT GREEN')
process.exit(failures)
