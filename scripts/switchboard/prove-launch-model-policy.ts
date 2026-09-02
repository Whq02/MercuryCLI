#!/usr/bin/env bun
// ============================================================================
//  prove-launch-model-policy — a launch nobody named a model for lands on the
//  OPERATOR's own default, and the receipt says where it landed.
//
//  The incident this closes: the operator asked for a session, the launch
//  silently seeded a different, tighter-pool family, and the first thing that
//  came back was a usage refusal — on an account that still had usage on the
//  model they had actually chosen. Nothing in the receipt said which model had
//  been picked, so there was nothing to read back.
//
//    §1 THE SEED (pure, over hand-built registries) — the operator's own row
//       wins; a refused operator row falls to a VISIBLE available row and
//       never quietly stands in for it; no mark falls back the same way.
//    §2 THE LIVE COMPOSITION — this account's registry marks the operator's
//       resolved default, and the seed is that id.
//    §3 THE RECEIPT — a launch receipt names the model the session started on.
//    §4 THE CONTRACT — the tool tells the seat to leave the model out, never
//       to reach for a pricier family, and to ask when the ask implies one.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-launch-model-policy.ts
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
const scratch = mkdtempSync(join(tmpdir(), 'launch-model-policy-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ZAI_API_KEY', 'OPENAI_API_KEY']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' launch model policy — the operator’s default, named on the receipt')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const wm = await import('../../src/services/concourse/workerModels.ts')
const tools = await import('../../src/services/concourse/coordinatorTools.ts')

type Entry = import('../../src/services/concourse/workerModels.ts').WorkerModelEntryV1

//
section('§1 — the seed: the operator’s own row, or a visible one')
//
{
  const reg = (entries: Entry[]) => ({ schema: 1 as const, entries })
  const available = { session: { availability: 'available' }, crew: { availability: 'available' } } as const
  // A refused operator default, shaped as the composition shapes one: the
  // session arm refuses by credential (pure capability), the crew arm by
  // the standing crew policy.
  const refusedBothArms = {
    session: { availability: 'refused', refusal: 'no-credential:anthropic' },
    crew: { availability: 'refused', refusal: 'worker-policy:frontier-only' },
  } as const
  const operatorRow: Entry = { modelId: 'claude-opus-5', displayName: 'Opus 5', ...available, effort: 'high', isOperatorDefault: true }
  const pricier: Entry = { modelId: 'claude-fable-5', displayName: 'Fable 5', ...available, effort: 'high' }

  check(
    'the operator’s own row wins, wherever it sits in the list',
    wm.defaultWorkerModelId(reg([pricier, operatorRow]), 'session') === 'claude-opus-5',
    wm.defaultWorkerModelId(reg([pricier, operatorRow]), 'session'),
  )
  check(
    'no operator mark ⇒ the first AVAILABLE row, never a hard-coded family',
    wm.defaultWorkerModelId(reg([{ ...pricier, modelId: 'claude-sonnet-5', displayName: 'Sonnet 5' }, pricier]), 'session') === 'claude-sonnet-5',
  )
  // A refused operator row must not be seeded (it cannot dispatch) and must
  // not be silently replaced by the pricier family either: the fallback is
  // whatever the registry actually offers, and the chip shows it.
  const refusedOperator: Entry = { modelId: 'claude-haiku-4-5', displayName: 'Haiku 4.5', ...refusedBothArms, isOperatorDefault: true }
  const sonnet: Entry = { modelId: 'claude-sonnet-5', displayName: 'Sonnet 5', ...available, effort: 'high' }
  check(
    'a REFUSED operator default is never seeded',
    wm.defaultWorkerModelId(reg([refusedOperator, sonnet, pricier]), 'session') !== 'claude-haiku-4-5',
  )
  check(
    '…the seed is the registry’s own first available row',
    wm.defaultWorkerModelId(reg([refusedOperator, sonnet, pricier]), 'session') === 'claude-sonnet-5',
  )
  check(
    'nothing dispatchable at all ⇒ the visible row, refused downstream, never invented',
    wm.defaultWorkerModelId(reg([refusedOperator]), 'session') === 'claude-haiku-4-5',
  )
}

//
section('§2 — the live composition marks and seeds the operator’s default')
//
{
  // The operator's CHOSEN model — their /model setting resolved, else the
  // built-in default (the re-tooth: the built-in default
  // SETTING alone was the read, so a /model naming another row on the same
  // lane never became the launch seed).
  const { getMainLoopModel } = await import('../../src/utils/model/model.ts')
  const operatorDefault = await wm.canonicalWorkerModelId(getMainLoopModel())
  const registry = await wm.composeWorkerModelRegistry()
  const marked = registry.entries.filter(e => e.isOperatorDefault === true)
  check('exactly ONE row is marked the operator’s default', marked.length === 1, JSON.stringify(marked.map(e => e.modelId)))
  check('…and it is the model their own default resolves to', marked[0]?.modelId === operatorDefault, `${String(marked[0]?.modelId)} vs ${operatorDefault}`)
  check(
    'the unnamed-launch seed IS that model',
    wm.defaultWorkerModelId(registry, 'session') === operatorDefault,
    `${wm.defaultWorkerModelId(registry, 'session')} vs ${operatorDefault}`,
  )
  const validated = await wm.validateWorkerModelChoice(undefined, 'session')
  check('…and an unnamed dispatch validates onto it', validated.ok && validated.entry.modelId === operatorDefault, JSON.stringify(validated))
}

//
section('§3 — the receipt names the model the session started on')
//
{
  const defs = tools.coordinatorToolSet()
  const launch = defs.find(d => d.name === 'launch_session')!
  const ctx = tools.createCoordinatorToolContext({
    workspaceRoot: scratch,
    by: 'coordinator-seat',
    rpc: async () => ({
      ok: true,
      state: 'starting',
      sessionId: 'sess-model-1',
      runnerId: 'w-1',
      // What the daemon answers once admission resolved the model.
      modelId: 'claude-opus-5',
      modelDisplayName: 'Opus 5',
    }),
    readWorkers: async () => ({}) as never,
  })
  const out = await launch.run({ task: 'fix the parser' }, ctx)
  const body = JSON.parse(out.content) as Record<string, unknown>
  check('the launch reported ok', body.ok === true, out.content)
  check('the tool answer carries the resolved model id', body.model === 'claude-opus-5', out.content)
  const receipt = (out.receipts ?? []).find(r => r.verb === 'session.launch')
  check('a launch receipt rowed', receipt !== undefined, JSON.stringify(out.receipts))
  check('…and it NAMES the model the session started on', String(receipt?.detail).includes('on Opus 5'), String(receipt?.detail))

  // A daemon that answers without a model still rows an honest receipt — the
  // name is absent, never fabricated.
  const bare = tools.createCoordinatorToolContext({
    workspaceRoot: scratch,
    by: 'coordinator-seat',
    rpc: async () => ({ ok: true, state: 'starting', sessionId: 'sess-model-2' }),
    readWorkers: async () => ({}) as never,
  })
  const out2 = await launch.run({ task: 'fix the parser' }, bare)
  const receipt2 = (out2.receipts ?? []).find(r => r.verb === 'session.launch')
  check('no model on the reply ⇒ no model in the receipt (nothing invented)', !/ on /.test(String(receipt2?.detail)), String(receipt2?.detail))
}

//
section('§4 — the contract: leave it out, never upgrade, ask when it matters')
//
{
  const launch = tools.coordinatorToolSet().find(d => d.name === 'launch_session')!
  const text = launch.description
  check('the description says an omitted model runs the operator’s own default', /leave `model` out and the session starts on the operator’s own default/.test(text), text.slice(0, 200))
  check('…forbids reaching for a pricier family or a tighter pool', /never name a pricier family or a tighter-usage pool yourself/.test(text))
  check('…and puts an implied model to the operator as one plain question', /one plain question instead of choosing/.test(text))
  check('the receipt duty is stated where the tool is described', /receipt names the model the session started on/.test(text))
  const prop = (launch.inputJSONSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
  check('the model parameter itself says when to pass it', /only when the operator named one/.test(String(prop.model?.description)), String(prop.model?.description))
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(
  failures === 0
    ? '\n✅ prove-launch-model-policy — all checks pass'
    : '\n❌ prove-launch-model-policy — check(s) failed',
)
process.exit(failures)
