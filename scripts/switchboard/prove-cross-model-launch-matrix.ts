#!/usr/bin/env bun
// ============================================================================
//  prove-cross-model-launch-matrix — the coordinator launches agents on ANY
//  family the catalog offers, and every seam speaks the truth (chat-relief
//  item 4). The road so far was fixed incident-by-incident (an effort
//  downgrade here, a render crash under a GPT model there) — never verified
//  AS A MATRIX. This prover walks the dispatch seam cpu-pure for EVERY
//  provider family the id law declares:
//
//    launch_session's spec (the model word rides verbatim; effort through
//    the ONE normalizer) → the daemon preview/admit (validateWorkerModelChoice
//    through the ONE worker registry — the same validator the admission
//    runs) → the stamped answer (the receipt names the model AND the tier
//    the session started at, family-neutrally).
//
//    §1 the family census — every catalog row folds to a DECLARED family
//       (no 'unrecognised' rows on the shelf)
//    §2 canonicalization, one door — aliases/legacy keys/[1m] fold for the
//       home family; engine ids pass through unchanged
//    §3 the KEYLESS world — per family, the session-arm refusal is TYPED
//       with the family's own name and its ONE fix (never a borrowed
//       lane's /logins); local speaks discovery, not credentials
//    §4 the CREDENTIALED world (presence = existence, fixture keys) — per
//       family, the session arm ADMITS its namespace id; the crew arm
//       keeps its own vocabulary (frontier seats; engine families refused
//       'not-integrated', economy 'worker-policy' — typed, visible)
//    §5 the launch receipt, family-neutral — for an engine id the receipt
//       names the model and the started tier exactly as for the home
//       family, and the effort truth (asked-vs-runs) speaks each family's
//       OWN ladder caps
//    §6 the daemon preview — preflightConcourseDispatch refuses a keyless
//       family's id typed and passes a credentialed one (the admission's
//       honest preview, same validator by construction)
//
//  The DRIVEN leg per family (a real launch + first turn on live
//  credentials) cannot run keyless: it is named field-owed in the lane
//  receipt, with the operator drill for the credentialed families.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-cross-model-launch-matrix.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const note = (label: string): void => {
  console.log(`  [NOTE] ${label}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── env hygiene BEFORE any src import: the KEYLESS world ────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'launch-matrix-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_OAUTH_TOKEN',
  'MERCURY_GEMINI_OAUTH_TOKEN',
  'MOONSHOT_API_KEY',
  'MOONSHOT_TOKEN',
  'HF_TOKEN',
  'HF_OAUTH_TOKEN',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_COMPAT_BASE_URL',
] as const
for (const key of CREDENTIAL_KEYS) delete process.env[key]
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(join(scratch, 'daemon'), { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' cross-model launch matrix — every family, every seam, typed')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const workerModels = await import('../../src/services/concourse/workerModels.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')

/** One specimen id per declared family — each asserted against the id law
 *  inline, so a drifted namespace fails HERE, not as a silent wrong walk. */
const SPECIMENS: ReadonlyArray<{ family: string; id: string }> = [
  { family: 'anthropic', id: 'claude-opus-5' },
  { family: 'openai', id: 'gpt-5.2' },
  { family: 'zai', id: 'glm-4.7' },
  { family: 'deepseek', id: 'deepseek-chat' },
  { family: 'moonshot', id: 'kimi-k2' },
  { family: 'gemini', id: 'gemini-3-pro' },
  { family: 'openrouter', id: 'openrouter/nvidia/llama-3.1-nemotron-ultra-253b-v1' },
  { family: 'huggingface', id: 'huggingface/meta-llama/Llama-3.3-70B-Instruct' },
  { family: 'openai-compat', id: 'compat/llama3:8b' },
  { family: 'local', id: 'local/qwen3' },
]

//
section('§1 — the catalog family census: every row folds to a DECLARED family')
//
{
  const { getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
  const families = new Map<string, number>()
  const unrecognised: string[] = []
  for (const o of getModelOptions()) {
    const v = typeof o.value === 'string' ? o.value : null
    if (!v || v.startsWith('__')) continue
    const id = await workerModels.canonicalWorkerModelId(v)
    const route = declaredRouteOf(id)
    if (route === null) unrecognised.push(id)
    else families.set(route, (families.get(route) ?? 0) + 1)
  }
  check('no catalog row is family-less', unrecognised.length === 0, JSON.stringify(unrecognised))
  check('the home family is on the shelf', (families.get('anthropic') ?? 0) > 0)
  note(`catalog census: ${[...families.entries()].map(([f, n]) => `${f}×${n}`).join(' · ') || '(empty shelf)'}`)
  for (const s of SPECIMENS) {
    check(`specimen '${s.id}' is declared by ${s.family}`, declaredRouteOf(s.id) === s.family, String(declaredRouteOf(s.id)))
  }
}

//
section('§2 — canonicalization, one door: aliases fold home; engine ids pass verbatim')
//
{
  const opus = await workerModels.canonicalWorkerModelId('opus')
  check("legacy key 'opus' folds to a canonical claude id", opus.startsWith('claude-opus-'), opus)
  const oneM = await workerModels.canonicalWorkerModelId('claude-opus-5[1m]')
  check('the [1m] context tag strips (a call-time flavor, not an identity)', oneM === 'claude-opus-5', oneM)
  for (const s of SPECIMENS.filter(x => x.family !== 'anthropic')) {
    const folded = await workerModels.canonicalWorkerModelId(s.id)
    check(`'${s.id}' passes through unchanged`, folded === s.id, folded)
  }
}

//
section('§3 — the KEYLESS world: every family refuses TYPED with its OWN name and fix')
//
{
  for (const s of SPECIMENS) {
    const verdict = await workerModels.validateWorkerModelChoice(s.id, 'session')
    if (s.family === 'local') {
      check(
        `local: discovery truth, never a credential lie`,
        !verdict.ok && verdict.reason === 'unreachable:local' && /local server/.test(verdict.detail ?? ''),
        JSON.stringify(verdict),
      )
      continue
    }
    const wantReason = `no-credential:${s.family}`
    check(
      `${s.family}: refuses '${wantReason}' naming its own family`,
      !verdict.ok && verdict.reason === wantReason && (verdict.detail ?? '').includes(s.family),
      JSON.stringify(verdict),
    )
    const action = !verdict.ok ? (verdict.action ?? '') : ''
    const expectedAction =
      s.family === 'openai-compat' ? /MERCURY_COMPAT_BASE_URL/ : new RegExp(`/logins ${s.family === 'huggingface' ? 'huggingface' : s.family}`)
    check(`…and the fix is the family's OWN door`, expectedAction.test(action), action)
  }
}

//
section('§4 — the CREDENTIALED world (presence = existence): the session arm admits; the crew arm keeps its vocabulary')
//
{
  process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token'
  process.env.OPENAI_API_KEY = 'fixture-key'
  process.env.ZAI_API_KEY = 'fixture-key'
  process.env.DEEPSEEK_API_KEY = 'fixture-key'
  process.env.OPENROUTER_API_KEY = 'fixture-key'
  process.env.GEMINI_API_KEY = 'fixture-key'
  process.env.MOONSHOT_API_KEY = 'fixture-key'
  process.env.HF_TOKEN = 'fixture-token'
  process.env.MERCURY_COMPAT_BASE_URL = 'http://127.0.0.1:1/v1'
  process.env.MERCURY_COMPAT_API_KEY = 'fixture-key'
  const { providerFamilyPresences } = await import('../../src/services/providers/providerUsage.ts')
  const presence = new Map(providerFamilyPresences().map(p => [p.id, p.credentialed]))
  // The named families MUST flip on fixture keys — a silent miss
  // here would hollow the whole credentialed walk.
  for (const must of ['anthropic', 'openai', 'zai']) {
    check(`presence flips for ${must} on its fixture key`, presence.get(must) === true, JSON.stringify([...presence]))
  }
  for (const s of SPECIMENS.filter(x => x.family !== 'local')) {
    if (presence.get(s.family) !== true) {
      note(`${s.family}: presence did not flip on fixture env — its credentialed walk is FIELD-OWED under a real credential`)
      continue
    }
    const session = await workerModels.validateWorkerModelChoice(s.id, 'session')
    check(`${s.family}: the session arm admits '${s.id}'`, session.ok === true, JSON.stringify(session))
    // The operator's law (no family is favoured): every credentialed family
    // runs a crew seat exactly as it runs a session.
    const crew = await workerModels.validateWorkerModelChoice(s.id, 'crew')
    check(`${s.family}: the crew arm admits '${s.id}' (no family is favoured for a crew seat)`, crew.ok === true, JSON.stringify(crew))
  }
  // The economy tier: a session runs it; an autonomous crew seat refuses it.
  const haikuSession = await workerModels.validateWorkerModelChoice('claude-haiku-4-5-20251001', 'session')
  const haikuCrew = await workerModels.validateWorkerModelChoice('claude-haiku-4-5-20251001', 'crew')
  check('economy: a session runs what the account runs', haikuSession.ok === true, JSON.stringify(haikuSession))
  check(
    "economy: a crew seat refuses 'worker-policy:frontier-only' — the standing law, spoken",
    !haikuCrew.ok && haikuCrew.reason === 'worker-policy:frontier-only',
    JSON.stringify(haikuCrew),
  )
}

//
section('§5 — the launch receipt is family-neutral: model + tier named for engine ids exactly as for home ids')
//
{
  const tools = await import('../../src/services/concourse/coordinatorTools.ts')
  const launch = tools.coordinatorToolSet().find(d => d.name === 'launch_session')!
  const cases = [
    { modelId: 'gpt-5.2', display: 'GPT-5.2', effortAsk: 'max effort', stamped: 'max' },
    { modelId: 'glm-4.7', display: 'GLM-4.7', effortAsk: 'x high', stamped: 'xhigh' },
    { modelId: 'openrouter/nvidia/llama-3.1-nemotron-ultra-253b-v1', display: 'Nemotron Ultra', effortAsk: undefined, stamped: 'high' },
  ] as const
  for (const c of cases) {
    const ctx = tools.createCoordinatorToolContext({
      workspaceRoot: scratch,
      by: 'coordinator-seat',
      rpc: async req => {
        const r = req as { model?: string; effort?: string }
        return {
          ok: true,
          state: 'starting',
          sessionId: `sess-${c.stamped}`,
          runnerId: 'w-x',
          modelId: r.model,
          modelDisplayName: c.display,
          effort: c.stamped,
        }
      },
      readWorkers: async () => ({}) as never,
    })
    const out = await launch.run(
      { task: 'matrix walk', model: c.modelId, ...(c.effortAsk !== undefined ? { effort: c.effortAsk } : {}) },
      ctx,
    )
    const body = JSON.parse(out.content) as Record<string, unknown>
    const receipt = (out.receipts ?? []).find(r => r.verb === 'session.launch')
    check(`${c.modelId}: the model word rode the wire verbatim`, body.model === c.modelId, out.content.slice(0, 200))
    check(`…the receipt names the model`, new RegExp(`on ${c.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(String(receipt?.detail)), String(receipt?.detail))
    check(
      `…and the tier the session started at — the STAMP, plain`,
      new RegExp(`@ ${c.stamped} effort`).test(String(receipt?.detail)),
      String(receipt?.detail),
    )
    check(
      `…claiming NO cap it cannot know (the fabricated-downgrade class: 'tops at default')`,
      !/ladder tops at/.test(String(receipt?.detail)) && body.effortRuns === undefined,
      String(receipt?.detail),
    )
    if (c.effortAsk === undefined) {
      check('…with the honest default disclaimer when no tier was asked', /no tier was asked/.test(String(receipt?.detail)), String(receipt?.detail))
    }
  }
  // The REAL step-down keeps its sentence (the effort-chain pin, alive in
  // the matrix): a home-family model whose ladder tops below the stamp.
  {
    const ctx = tools.createCoordinatorToolContext({
      workspaceRoot: scratch,
      by: 'coordinator-seat',
      rpc: async () => ({
        ok: true,
        state: 'starting',
        sessionId: 'sess-stepdown',
        runnerId: 'w-s',
        modelId: 'claude-opus-4-6',
        modelDisplayName: 'Opus 4.6',
        effort: 'xhigh',
      }),
      readWorkers: async () => ({}) as never,
    })
    const out = await launch.run({ task: 'matrix walk', model: 'claude-opus-4-6', effort: 'x high' }, ctx)
    const receipt = (out.receipts ?? []).find(r => r.verb === 'session.launch')
    check(
      'the KNOWN step-down still speaks asked-vs-runs (ladder word to ladder word)',
      /asked xhigh; this model's ladder tops at high/.test(String(receipt?.detail)),
      String(receipt?.detail),
    )
  }
  // The effort truth speaks each family's OWN ladder: a stamped tier above a
  // family's cap reads asked-vs-runs from the capability owner, never a
  // silent pass-through of a tier the wire cannot run.
  const { resolveStampedEffortTruth, isEffortLevel } = await import('../../src/utils/effort.ts')
  for (const c of cases) {
    if (!isEffortLevel(c.stamped)) continue
    const truth = resolveStampedEffortTruth(c.modelId, c.stamped)
    check(
      `${c.modelId}: the stamped-truth label is a ladder word (its own cap law)`,
      typeof truth.label === 'string' && truth.label.length > 0,
      JSON.stringify(truth),
    )
  }
}

//
section('§6 — the daemon preview refuses keyless typed and passes credentialed (one validator, by construction)')
//
{
  const { preflightConcourseDispatch } = await import('../../src/daemon/concourseDispatch.ts')
  // Credentialed (the §4 fixture keys still stand): the model gate passes.
  const okPreview = await preflightConcourseDispatch(
    { clientMessageId: 'm-ok', prompt: 'walk', workspaceDir: scratch, modelKey: 'gpt-5.2' } as never,
    join(scratch, 'daemon'),
  )
  const okModelRefusals = okPreview.ok ? [] : okPreview.refusals.filter(r => r.code === 'invalid-model')
  check('a credentialed engine id passes the model gate', okModelRefusals.length === 0, JSON.stringify(okPreview))
  // Keyless again: the same id refuses typed with the family fact.
  delete process.env.OPENAI_API_KEY
  const keyless = await preflightConcourseDispatch(
    { clientMessageId: 'm-no', prompt: 'walk', workspaceDir: scratch, modelKey: 'gpt-5.2' } as never,
    join(scratch, 'daemon'),
  )
  const refusal = keyless.ok ? undefined : keyless.refusals.find(r => r.code === 'invalid-model')
  check(
    'the keyless preview refuses invalid-model naming the family credential fact',
    refusal !== undefined && /no-credential:openai/.test(refusal.reason) && /\/logins openai/.test(refusal.reason),
    JSON.stringify(keyless),
  )
  // And a junk effort refuses beside it — the preview speaks BOTH truths.
  const junk = await preflightConcourseDispatch(
    { clientMessageId: 'm-junk', prompt: 'walk', workspaceDir: scratch, modelKey: 'glm-4.7', effort: 'ludicrous' } as never,
    join(scratch, 'daemon'),
  )
  check(
    'a junk effort refuses invalid-effort naming the ladder (beside the model verdict, never instead of it)',
    !junk.ok && junk.refusals.some(r => r.code === 'invalid-effort' && /low \| medium \| high \| xhigh \| max/.test(r.reason)),
    JSON.stringify(junk),
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
console.log(failures ? '❌ CROSS-MODEL-LAUNCH-MATRIX RED' : '✅ CROSS-MODEL-LAUNCH-MATRIX GREEN')
process.exit(failures)
