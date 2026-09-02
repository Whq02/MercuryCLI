#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-neutral-home.ts — the sovereign-home
// poison: a home with NO first-party credential and
//  an OpenRouter free-tier default must resolve, count, mint and refuse
//  without naming or calling the first-party vendor.
//
//  THE LAW: the product assumes no family. Every default projects the
//  session's OWN lane; every request fires on the session's own wire; every
//  refusal names the id and the family it was judged against. On a
//  sovereign home the first-party origin sees ZERO requests across the
//  small-call estate.
//
//    §1 THE HOME — settings.model names the operator's OpenRouter free tier,
//       OPENROUTER_API_KEY is present, nothing first-party exists: the
//       main-loop model routes to openrouter; the session's small-fast tier
//       is that same id (never a first-party small model).
//    §2 THE COUNTERS — countTokensWithAPI, countMessagesTokensWithAPI and
//       countTokensViaHaikuFallback answer null on the sovereign home and
//       the first-party origin sees NO request (base: each POSTed the
//       OpenRouter id to the first-party count endpoint / create probe).
//    §3 THE CONTROL — the same counters on an Anthropic-route home with a
//       first-party key DO reach the origin (the spy bites; a pin that
//       cannot fail proves nothing).
//
//  POISON (recorded): against the base tokenEstimation.ts the §2 legs each
//  observe a POST toward the loopback origin.
//
//  Hermetic: a loopback listener stands in for the origin (ANTHROPIC_BASE_URL
//  pinned), the file credential plane on a scratch home, every credential
//  and proxy env cleared. Run:
//    ~/.bun/bin/bun run scripts/providers/prove-neutral-home.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' sovereign home — no first-party credential, an OpenRouter default')
console.log('============================================================')

// ── hermetic ground ─────────────────────────────────────────────────────────
for (const key of [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'ANTHROPIC_UNIX_SOCKET',
  'MERCURY_CLIENT_CERT',
  'MERCURY_CLIENT_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
const scratch = mkdtempSync(join(tmpdir(), 'prove-sovereign-home-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const HOME_MODEL = 'openrouter/nvidia/nemotron-nano-9b-v2:free'
const HOME_SLUG = 'nvidia/nemotron-nano-9b-v2:free'

// One loopback, two faces: every path outside /openrouter/ is the
// FIRST-PARTY origin stand-in (recorded as a first-party hit; answers a
// count-shaped body so a control leg settles cleanly); /openrouter/api/v1
// is the OpenRouter catalogue stand-in serving the operator's one free row
// (never a first-party hit — the default walk's live legs read it).
const seen: Array<{ method: string; url: string; firstParty: boolean }> = []
const CATALOGUE = {
  data: [{ id: HOME_SLUG, name: 'NVIDIA: Nemotron Nano 9B (free)', context_length: 128_000 }],
  total_count: 1,
  links: { next: null },
}
const origin = createServer((req, res) => {
  const url = req.url ?? ''
  const path = url.split('?')[0] ?? ''
  const catalogue = path.startsWith('/openrouter/')
  seen.push({ method: req.method ?? '', url, firstParty: !catalogue })
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', () => {
    if (catalogue) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(path.endsWith('/models') ? CATALOGUE : {}))
      return
    }
    // A STREAMING create gets a real SSE answer. The client's stream lane
    // recovers from a non-SSE body by ONE non-streaming fallback POST (the
    // streamCore ladder) — so a JSON answer to a stream:true request made
    // every one-probe window count TWO wire hits and red the ===1 needles
    // against a door that probed exactly once (the
    // adjudication of this pin's first run). The spy now answers the shape
    // the request asked for; the hit counts are the door's own again.
    if (Buffer.concat(chunks).toString('utf8').includes('"stream":true')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const message = { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'fixture', stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 1 } }
      res.end([
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message })}`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
        `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })}`,
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
        '',
      ].join('\n\n'))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ input_tokens: 7, id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'fixture', stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 1 } }))
  })
})
const port = await new Promise<number>(resolve => {
  origin.listen(0, '127.0.0.1', () => {
    const address = origin.address()
    resolve(typeof address === 'object' && address !== null ? address.port : 0)
  })
})
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
process.env.MERCURY_OPENROUTER_API_BASE = `http://127.0.0.1:${port}/openrouter/api/v1`
const firstPartyHits = (): number => seen.filter(hit => hit.firstParty).length

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')

function seedHome(model: string): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ model }))
  resetSettingsCache()
}

/** Run `work` and count the FIRST-PARTY requests it caused. */
async function hitsDuring<T>(work: () => Promise<T>): Promise<{ result: T | 'threw'; hits: number; last?: { method: string; url: string } }> {
  const before = firstPartyHits()
  let result: T | 'threw'
  try {
    result = await work()
  } catch {
    result = 'threw'
  }
  const hits = firstPartyHits() - before
  const last = seen.filter(hit => hit.firstParty).at(-1)
  return { result, hits, ...(hits > 0 && last ? { last: { method: last.method, url: last.url } } : {}) }
}

// ── §1 the home ─────────────────────────────────────────────────────────────
section('§1 the sovereign home resolves onto its own lane, small tier included')
process.env.OPENROUTER_API_KEY = 'sk-or-fixture-sovereign-home'
seedHome(HOME_MODEL)
const { getMainLoopModel } = await import('../../src/utils/model/model.js')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.js')
const { sessionSmallFastModel, smallFastModelFor } = await import('../../src/utils/model/providerFrontier.js')
{
  const main = getMainLoopModel()
  check('the main-loop model is the operator\'s OpenRouter free tier', main === HOME_MODEL, main)
  check('…and routes to openrouter', declaredRouteOf(main) === 'openrouter', declaredRouteOf(main))
  const small = sessionSmallFastModel()
  check('the session small-fast tier is the session\'s own id (no recorded small tier ⇒ never a first-party hop)', small === HOME_MODEL, small)
  check('…the pure resolver agrees', smallFastModelFor(HOME_MODEL) === HOME_MODEL, smallFastModelFor(HOME_MODEL))
  check('no first-party id anywhere in the small tier', !/claude/i.test(small), small)
}

// ── §2 the counters ─────────────────────────────────────────────────────────
section('§2 the token counters answer null on the sovereign home and the origin sees nothing')
const tokEst = await import('../../src/services/tokenEstimation.js')
{
  const text = 'x '.repeat(30_000)
  const a = await hitsDuring(() => tokEst.countTokensWithAPI(text))
  check('countTokensWithAPI answers null (the caller keeps its estimate)', a.result === null, JSON.stringify(a))
  check('…and no request reached the first-party origin (base: one POST carrying the OpenRouter id)', a.hits === 0, JSON.stringify(a))
  const b = await hitsDuring(() => tokEst.countMessagesTokensWithAPI([{ role: 'user', content: text }], []))
  check('countMessagesTokensWithAPI answers null', b.result === null, JSON.stringify(b))
  check('…with no request', b.hits === 0, JSON.stringify(b))
  const c = await hitsDuring(() => tokEst.countTokensViaHaikuFallback([{ role: 'user', content: text }], []))
  check('countTokensViaHaikuFallback answers null (no first-party create probe)', c.result === null, JSON.stringify(c))
  check('…with no request', c.hits === 0, JSON.stringify(c))
  check('the sovereign home never named a first-party id to the origin', firstPartyHits() === 0, JSON.stringify(seen))
}

// ── §3 the control ──────────────────────────────────────────────────────────
section('§3 an Anthropic-route home with a first-party key DOES reach the origin (the spy bites)')
{
  delete process.env.OPENROUTER_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-control-leg-0000000000'
  seedHome('claude-sonnet-5')
  const main = getMainLoopModel()
  check('premise: the control home routes to anthropic', declaredRouteOf(main) === 'anthropic', main)
  const a = await hitsDuring(() => tokEst.countTokensWithAPI('x '.repeat(30_000)))
  check('countTokensWithAPI reached the origin', a.hits >= 1, JSON.stringify(a))
  check('…at the count endpoint', /count_tokens/.test(a.last?.url ?? ''), JSON.stringify(a.last))
  check('…and answered the origin\'s count', a.result === 7, JSON.stringify(a))
  delete process.env.ANTHROPIC_API_KEY
}

// ── §4 the id-space law ─────────────────────────────────────────────────────
section('§4 the home lane is a declared family; an id no family declares names itself')
const { recognizeModelId, unrecognisedModelIdReason, declaredIdSpacesLine } = await import('../../src/services/providers/idSpaces.js')
const { homeLaneAdmissionRefusal } = await import('../../src/services/providers/homeLaneAdmission.js')
{
  const kind = (id: string, env?: Record<string, string | undefined>): string => {
    const r = recognizeModelId(id, env ?? {})
    return r.kind === 'declared' ? `declared:${r.route}` : r.kind === 'first-party' ? `first-party:${r.why}` : r.kind
  }
  check('the operator\'s OpenRouter id is declared:openrouter', kind(HOME_MODEL) === 'declared:openrouter', kind(HOME_MODEL))
  check('gpt-5.6-sol is declared:openai · glm is declared:zai · huggingface/x/y is declared:huggingface',
    kind('gpt-5.6-sol') === 'declared:openai' && kind('glm') === 'declared:zai' && kind('huggingface/Qwen/Qwen3') === 'declared:huggingface')
  check('a claude-* id is first-party by its mark, context rider detached', kind('claude-sonnet-5[1m]') === 'first-party:claude-mark', kind('claude-sonnet-5[1m]'))
  check('a gateway spelling keeps the mark inside the family', kind('us.anthropic.claude-opus-5-v1:0') === 'first-party:claude-mark')
  check('the setting aliases are first-party (opus · fable[1m] · opusplan · sonnet5)',
    kind('opus') === 'first-party:alias' && kind('fable[1m]') === 'first-party:alias' && kind('opusplan') === 'first-party:alias' && kind('sonnet5') === 'first-party:alias')
  check('an env-pinned id is first-party by the pin\'s own name (a gateway-served spelling included)',
    kind('my-gateway-model', { ANTHROPIC_CUSTOM_MODEL_OPTION: 'my-gateway-model' }) === 'first-party:env-pin' &&
      kind('proxy-served', { ANTHROPIC_MODEL: 'proxy-served[1m]' }) === 'first-party:env-pin')
  check('a bare vendor slug is carrier-shaped (the wire owner refuses it on every bare lane)',
    kind('anthropic/claude-opus-5') === 'carrier-shaped' && kind('qwen/qwen3-coder') === 'carrier-shaped')
  check('an id no family declares is UNRECOGNISED — never first-party by remainder', kind('foo-bar-9') === 'unrecognised' && kind('nemotron-nano') === 'unrecognised')
  check('the reason names the id and every declared family from the table',
    /'foo-bar-9'/.test(unrecognisedModelIdReason('foo-bar-9')) && /openrouter\/…/.test(declaredIdSpacesLine()) && /gpt-\*/.test(declaredIdSpacesLine()) && /claude-\*/.test(declaredIdSpacesLine()))

  // The admission law (pure over injected reads). The operator's neutrality
  // ruling: the ride is EARNED — an ANTHROPIC_* pin or a
  // gateway base URL — and a credential is not an earned fact.
  const firstPartyNoFact = { firstPartyBaseUrl: () => true, env: {} }
  const refusal = homeLaneAdmissionRefusal('foo-bar-9', firstPartyNoFact)
  check('unrecognised + first-party origin + no earned fact ⇒ the typed refusal, byte-stable on the sentence head',
    typeof refusal === 'string' && refusal.startsWith("'foo-bar-9' is not a model id any provider family declares ("), String(refusal))
  check('…naming BOTH earned roads and the /model remedy (operator-fixable without reading code)',
    typeof refusal === 'string' && /ANTHROPIC_\* model pin/.test(refusal) && /ANTHROPIC_BASE_URL/.test(refusal) && /\/model/.test(refusal), String(refusal))
  check('…and stating the refusal came before any request', typeof refusal === 'string' && /Refused before any request/.test(refusal), String(refusal))
  check('a gateway base URL admits (its endpoint owns its ids)',
    homeLaneAdmissionRefusal('foo-bar-9', { ...firstPartyNoFact, firstPartyBaseUrl: () => false }) === null)
  const admissionSource = readFileSync(join(ROOT, 'src/services/providers/homeLaneAdmission.ts'), 'utf8')
  check('a credentialed home refuses the same — a credential is not an earned fact, and NO credential read exists in the admission owner',
    homeLaneAdmissionRefusal('foo-bar-9', { ...firstPartyNoFact, env: { ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_API_KEY: 'k' } }) !== null &&
      !/anthropicCredentialPresence|firstPartyCredentialed/.test(admissionSource))
  check('the env-pin road admits — the pinned id is first-party by the pin\'s own name AND the routing law carries it home (routing joins recognition)',
    homeLaneAdmissionRefusal('proxy-served', { ...firstPartyNoFact, env: { ANTHROPIC_MODEL: 'proxy-served' } }) === null &&
      declaredRouteOf('proxy-served', { ANTHROPIC_MODEL: 'proxy-served' }) === 'anthropic')
  check('a first-party id keeps the lane\'s own auth refusal (admitted here)', homeLaneAdmissionRefusal('claude-sonnet-5', firstPartyNoFact) === null)
  check('a declared family never reaches this door (admitted here, routed elsewhere)', homeLaneAdmissionRefusal('gpt-5.6-sol', firstPartyNoFact) === null)

  // The live wiring: on this home the origin is a loopback (NOT first-party),
  // so /model's typing door PROBES an unrecognised id — the gateway-serves-
  // its-own-ids law, observed at the spy (a poisoned door refusing here
  // would show zero requests; a poisoned door classing it first-party on a
  // first-party origin is the pure leg above).
  seedHome(HOME_MODEL)
  process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-gateway-token'
  const { validateModel } = await import('../../src/utils/model/validateModel.js')
  const probed = await hitsDuring(() => validateModel('foo-bar-9'))
  check('on a gateway base URL the typing door probes the endpoint (one request at the spy)', probed.hits === 1, JSON.stringify(probed))
  check('…and the gateway\'s answer validates the id (the endpoint owns it)', typeof probed.result === 'object' && probed.result !== null && (probed.result as { valid: boolean }).valid === true, JSON.stringify(probed.result))
  delete process.env.ANTHROPIC_AUTH_TOKEN
  const validator = readFileSync(join(ROOT, 'src/utils/model/validateModel.ts'), 'utf8')
  const router = readFileSync(join(ROOT, 'src/services/providers/callModelRouter.ts'), 'utf8')
  check('the typing door and the dispatch seam read the ONE admission owner', /homeLaneAdmissionRefusal\(trimmed\)/.test(validator) && /homeLaneAdmissionRefusal\(params\.options\.model\)/.test(router))
}

// ── §5 the wire-id owner on the home lane ───────────────────────────────────
section('§5 a carrier-shaped id never reaches the first-party wire verbatim (w3-f07-01)')
{
  const firstParty = { firstPartyBaseUrl: () => true, env: {} }
  const slug = homeLaneAdmissionRefusal('anthropic/claude-opus-5', firstParty)
  check('a bare vendor slug refuses on the first-party origin even when credentialed (junk is junk)',
    typeof slug === 'string' && /'anthropic\/claude-opus-5'/.test(slug) && /carry no '\/'/.test(slug), String(slug))
  check('…with the wire-id owner\'s own catalogue words (never a 404 from the wire)', typeof slug === 'string' && /openrouter\/<vendor>\/<model>/.test(slug), String(slug))
  check('a first-party id with Mercury dressing admits (the annotation heals on the wire, the 1M rider rides)',
    homeLaneAdmissionRefusal('claude-sonnet-5[1m]', firstParty) === null)
  check('a gateway base URL admits the slug (a multi-vendor proxy on an Anthropic-compatible wire owns such ids)',
    homeLaneAdmissionRefusal('anthropic/claude-opus-5', { ...firstParty, firstPartyBaseUrl: () => false }) === null)
  check('the wire-id law precedes recognition: a slug refuses as junk, not as unrecognised',
    typeof slug === 'string' && !/any provider family declares/.test(slug))
  // Live at the loopback gateway: the dispatch seam ADMITS the slug there
  // (the gateway owns its ids) — the request reaches the spy with the id
  // verbatim; the first-party-origin refusal is the pure leg above.
  seedHome(HOME_MODEL)
  process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-gateway-token'
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.js')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
  const { createUserMessage } = await import('../../src/utils/messages.js')
  const drive = await hitsDuring(async () => {
    const seen: string[] = []
    const stream = routedCallModel({
      messages: [createUserMessage({ content: 'hi' })],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'anthropic/claude-opus-5',
        toolChoice: undefined,
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'model_validation',
        mcpTools: [],
        maxOutputTokens: 1,
        maxRetries: 0,
        skipCacheWrite: true,
      },
    } as never)
    // A non-SSE loopback answer settles as an error yield or a throw; the
    // race keeps a mis-parsed stream from ever hanging the prover.
    await Promise.race([
      (async () => {
        for await (const message of stream) seen.push(String((message as { type?: string }).type))
      })(),
      new Promise<void>(resolve => setTimeout(resolve, 5_000)),
    ])
    return seen
  })
  check('on the gateway the seam dispatched (the spy saw the request)', drive.hits >= 1, JSON.stringify(drive))
  delete process.env.ANTHROPIC_AUTH_TOKEN
}

// ── §6 the credential-less default walks every lane ─────────────────────────
section('§6 a home with no first-party credential lands its default on a credentialed lane — any lane, by sign-in recency')
const { getDefaultMainLoopModel } = await import('../../src/utils/model/model.js')
const { evaluateComputedDefault, orderCredentials, resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.js')
{
  const REG = ['anthropic', 'openai', 'zai', 'openrouter', 'gemini', 'moonshot', 'deepseek', 'openai-compat', 'huggingface', 'local'] as const
  type Verdict = { usable: true; setting: string; row: string; why: string } | { usable: false; why: string }
  const usable = (setting: string): Verdict => ({ usable: true, setting, row: setting, why: 'usable' })
  const gated = (why: string): Verdict => ({ usable: false, why })
  const KEYLESS = { setting: 'claude-opus-5', why: 'no provider is signed in yet' }
  const T = 1_788_298_400_000
  const decide = (credentials: Array<{ family: string; at: number | null }>, rows: Record<string, Verdict>, recorded?: string) =>
    evaluateComputedDefault({ credentials, ...(recorded !== undefined ? { recordedDefaultProvider: recorded } : {}), registryOrder: REG, laneRow: family => rows[family] ?? gated('no selectable row'), keyless: KEYLESS })
  const names = (list: ReadonlyArray<{ family: string }>): string => list.map(c => c.family).join(',')
  check('THE ORDER: sign-in recency, every family alike — the home lane is a family like every other, never the remainder',
    names(orderCredentials({ credentials: [{ family: 'anthropic', at: T + 2 }, { family: 'openrouter', at: T + 1 }], registryOrder: REG })) === 'anthropic,openrouter' &&
      names(orderCredentials({ credentials: [{ family: 'anthropic', at: T + 1 }, { family: 'openrouter', at: T + 2 }], registryOrder: REG })) === 'openrouter,anthropic')
  check('the most recent sign-in wins over a ready GPT seat signed in earlier',
    decide([{ family: 'openai', at: T + 1 }, { family: 'openrouter', at: T + 2 }], { openai: usable('gpt-5.6-sol'), openrouter: usable(HOME_MODEL) }).setting === HOME_MODEL)
  const unqualified = decide([{ family: 'openai', at: T + 2 }, { family: 'zai', at: T + 1 }], { openai: gated('GPT-5.6: not served by the connected source'), zai: usable('glm-5.2') })
  check('a credentialed seat that is not QUALIFIED (no selectable row) answers nothing — the default falls through to the next sign-in, named',
    unqualified.setting === 'glm-5.2' && unqualified.source === 'fallthrough' && unqualified.why.includes('Skipped: openai'), unqualified.why)
  const nothing = decide([], {})
  check('no credential anywhere ⇒ NO default: the keyless placeholder, named no sign-in yet (typed refusal downstream, never silent)',
    nothing.source === 'keyless' && nothing.setting === 'claude-opus-5' && nothing.row === 'no sign-in yet' && nothing.provider === null)
  check('a first-party credential is one lane among equals — it wins exactly when it is the most recent sign-in',
    decide([{ family: 'anthropic', at: T + 2 }, { family: 'openrouter', at: T + 1 }], { anthropic: usable('claude-opus-5'), openrouter: usable(HOME_MODEL) }).setting === 'claude-opus-5' &&
      decide([{ family: 'anthropic', at: T + 1 }, { family: 'openrouter', at: T + 2 }], { anthropic: usable('claude-opus-5'), openrouter: usable(HOME_MODEL) }).setting === HOME_MODEL)
  check('untimed credentials (before the ledger; env keys) order after every timed sign-in, the recorded default provider leading them',
    names(orderCredentials({ credentials: [{ family: 'zai', at: null }, { family: 'openrouter', at: null }, { family: 'deepseek', at: T }], recordedDefaultProvider: 'openrouter', registryOrder: REG })) === 'deepseek,openrouter,zai')

  // LIVE A — the env-key-only home: no settings.model, no first-party
  // credential, OPENROUTER_API_KEY alone (an env key records no sign-in —
  // an untimed credential, the only one). The catalogue stand-in serves
  // the one free row; the computed default lands on it.
  rmSync(join(home, 'settings.json'), { force: true })
  resetSettingsCache()
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture-sovereign-home'
  resetComputedDefaultMemo() // an env pin lands without a ledger record — the proof drops the memo itself
  const { refreshOpenrouterCatalogue } = await import('../../src/services/providers/openrouter/openrouterCatalogue.js')
  const snapshot = await refreshOpenrouterCatalogue('env', { force: true }).catch(() => null)
  check('premise: the catalogue stand-in served the free row', (snapshot?.models.length ?? 0) === 1, JSON.stringify(snapshot?.models))
  const walked = await hitsDuring(async () => getMainLoopModel())
  check('LIVE: the env-key-only home boots its default onto the OpenRouter free row (base: claude-opus-5, every turn refused)', walked.result === HOME_MODEL, JSON.stringify(walked))
  check('…with no first-party request', walked.hits === 0, JSON.stringify(walked))

  // LIVE B — the operator's exact home: the legacy RECORDED default provider
  // is openrouter, a lane with no frontier fact. The resolver composes the
  // picker, whose Default row runs the resolver again: with the latch the
  // outer composition lands on the lane's first row; without it a swallowed
  // stack overflow fell back to the first-party frontier default.
  const { saveGlobalConfig, getGlobalConfig } = await import('../../src/utils/config/globalConfig.js')
  saveGlobalConfig(config => ({ ...config, defaultProvider: 'openrouter' }))
  resetComputedDefaultMemo()
  check('premise: the recorded default provider is openrouter', (getGlobalConfig() as { defaultProvider?: string }).defaultProvider === 'openrouter')
  const recorded = await hitsDuring(async () => getDefaultMainLoopModel())
  check('LIVE: the recorded OpenRouter default lands on the lane\'s first picker row (the latch; base: the frontier default by swallowed overflow)', recorded.result === HOME_MODEL, JSON.stringify(recorded))
  check('…and the main-loop model agrees', getMainLoopModel() === HOME_MODEL, getMainLoopModel())
  const resolver = readFileSync(join(ROOT, 'src/utils/model/computedDefault.ts'), 'utf8')
  check('the picker composition carries its reentrancy latch', /walkingPicker/.test(resolver))
  saveGlobalConfig(config => {
    const { defaultProvider: _drop, ...rest } = config as { defaultProvider?: string }
    return rest as typeof config
  })
  delete process.env.OPENROUTER_API_KEY
  resetComputedDefaultMemo()
}

// ── §7 the surfaces name the session's family ───────────────────────────────
section("§7 the surfaces name the session's family — never the first-party one by default")
{
  const { loginFamilyFocusFor, loginFamilyRows } = await import('../../src/components/loginFamilyRows.js')
  check("the /logins card pre-focuses the recorded default provider's own row (anthropic → its subscription row; unset or row-less → the list's first)",
    loginFamilyFocusFor('openrouter') === 'openrouter' && loginFamilyFocusFor('anthropic') === 'claudeai' && loginFamilyFocusFor(undefined) === undefined && loginFamilyFocusFor('local') === undefined)
  const rows = loginFamilyRows({ engineLegs: true })
  const consoleRow = rows.find(r => r.value === 'console')
  // OS-AUTH-1 (operator-ruled): the homes SPLIT — the console row
  // is purely Anthropic in every host ("one should be Anthropic and one
  // should be OpenAI key — they shouldn't share the same home"); the OpenAI
  // key rides its own family's row. POISON: a revived two-vendor console
  // door reds here.
  check('the usage-based door is purely Anthropic (OS-AUTH-1 split — a revived two-vendor door reds)', /Anthropic Console/.test(consoleRow?.label ?? '') && !/OpenAI/.test(consoleRow?.label ?? ''), consoleRow?.label)
  const openaiRow = rows.find(r => r.value === 'openai')
  check("…and the OpenAI key's home is the OpenAI family's own row", /OpenAI/.test(openaiRow?.label ?? '') && /API key/.test(openaiRow?.label ?? ''), openaiRow?.label)
  check('…and the narrowed door names its one vendor', /Anthropic Console/.test(loginFamilyRows({ engineLegs: false }).find(r => r.value === 'console')?.label ?? ''))
  const { nonAnthropicBootNotice } = await import('../../src/services/providers/providerUsability.js')
  const lane = (provider: string, usable: boolean) => ({ provider, credential: usable ? 'api-key' : 'none', limit: 'unknown', usable, blockers: usable ? [] : ['x'] })
  const notice = nonAnthropicBootNotice({ anthropic: lane('anthropic', false), openai: lane('openai', false), openrouter: lane('openrouter', true) } as never)
  check('the boot honesty notice LEADS with the working lane (base: "No Anthropic credential: …")', typeof notice === 'string' && /^OpenRouter is the working lane/.test(notice), String(notice))
  check('…and still names the dormant first-party surfaces honestly', typeof notice === 'string' && /usage windows/.test(notice) && /No Anthropic credential —/.test(notice), String(notice))
  const { notLoggedInGateDecision } = await import('../../src/services/wallet/wallet.js')
  const missing = notLoggedInGateDecision([{ provider: 'openai' }] as never, 'anthropic')
  check('the wallet gate names the missing family by its one-owner display name', missing.state === 'provider-missing' && missing.missingProvider === 'Anthropic' && /No Anthropic account/.test(missing.steering), JSON.stringify(missing))
  check('a session on a key lane is never steered to the first-party sign-in', notLoggedInGateDecision([], 'openrouter').state === 'ok')
  const routerText = readFileSync(join(ROOT, 'src/commands/router/router.tsx'), 'utf8')
  check('the /router header names the estate as it is, with the ruled fence beside it', /every provider lane beside the home lane/.test(routerText) && /seats stay Anthropic/.test(routerText))
}

// ── §8 THE OPERATOR'S SIGHTING — the unnamed launch on a fresh box ──────────
section("§8 the operator's sighting: a fresh box's New Session is born keyless; a spelled-out id keeps its family's door, spoken to the operator")
{
  const wm = await import('../../src/services/concourse/workerModels.js')
  // Pure: the ruled sentence fires exactly for no-default + no-credential-anywhere.
  const ruled = wm.noAccountRefusal('no-credential:anthropic', undefined, false)
  check('no default recorded + nothing signed in ⇒ the ruled two-door sentence', ruled !== undefined && ruled.reason === 'no-credential:any' && ruled.action === '/logins to choose an account, or /router key <provider> to connect an API key', JSON.stringify(ruled))
  check('…and no family word rides it', ruled !== undefined && !/anthropic|claude|openai|openrouter|gemini|zai|moonshot|deepseek|huggingface/i.test(`${ruled.detail} ${ruled.action}`), JSON.stringify(ruled))
  check('a recorded default is the drift note\'s case, not this one', wm.noAccountRefusal('no-credential:anthropic', 'openrouter', false) === undefined)
  check('any credentialed family means the launch lands there — never this refusal', wm.noAccountRefusal('no-credential:anthropic', undefined, true) === undefined)
  check('a non-credential refusal is untouched', wm.noAccountRefusal('worker-policy:frontier-only', undefined, false) === undefined)

  // LIVE, the sighting itself: this home holds no credential in any family
  // and no recorded default (the legs above cleared both). THE LANDED LAW
  // (the neutral-default ruling): an unnamed SESSION launch on a keyless
  // home is BORN — admitted keyless on the neutral placeholder, the row
  // wearing the keyless words and no family — never a refusal; the cockpit
  // paints, its composer's own gate names the logins door, and the first
  // send is what a credential gates. The two-door sentence above stays the
  // crew seat's (a crew seat cannot run keyless).
  rmSync(join(home, 'settings.json'), { force: true })
  resetSettingsCache()
  const fresh = await wm.validateWorkerModelChoice(undefined, 'session')
  const freshLine = fresh.ok ? `ok · keyless=${String(fresh.keyless)} · ${fresh.entry.displayName}` : `${fresh.reason} · ${fresh.action ?? ''} — ${fresh.detail ?? ''}`
  check("LIVE: the fresh box's unnamed launch is BORN keyless (base: '…run /logins anthropic — the anthropic family holds no credential on this account', then the two-door refusal)",
    fresh.ok && fresh.keyless === true && fresh.entry.displayName === 'no sign-in yet', freshLine)
  check('…naming no family anywhere on the row', !/anthropic|claude|openai|openrouter|gemini|zai|moonshot|deepseek|huggingface/i.test(freshLine), freshLine)
  const freshCrew = await wm.validateWorkerModelChoice(undefined, 'crew')
  check('…while the keyless CREW seat keeps the ruled two-door sentence (naming no family)', !freshCrew.ok && freshCrew.reason === 'no-credential:any' && !/anthropic|claude|openai/i.test(`${freshCrew.detail} ${freshCrew.action}`), JSON.stringify(freshCrew))

  // LIVE, THE FACE'S ROAD (FC-097's sighting, re-trued to the landed law):
  // the boot face's New Session sends NO model on a keyless home — the
  // door's screen arm is the neutral owner's word (screenBirthModel:
  // nothing while computedDefault reads keyless), so the daemon sees the
  // unnamed launch above and births it. The registry's keyless seed is the
  // operator's own row (the id the old face named): spelled out as a NAMED
  // id it is the operator's own pick and keeps its family's door — and on
  // the operator's own road that door is spoken TO the operator (the
  // daemon addresses its way-out to a relay; bornSession rewrites it).
  const facts = await import('../../src/services/switchboard/bootBirthFacts.js')
  // The neutral owner memoises on the ledger epoch; the legs above put keys
  // on and off the process — read the fresh box afresh.
  ;(await import('../../src/utils/model/computedDefault.js')).resetComputedDefaultMemo()
  check("LIVE: the face's road sends NO model on the fresh box (screenBirthModel is nothing while the default reads keyless)", facts.screenBirthModel() === undefined, String(facts.screenBirthModel()))
  const facedRegistry = await wm.composeWorkerModelRegistry()
  const facedId = wm.defaultWorkerModelId(facedRegistry, 'session')
  const faced = await wm.validateWorkerModelChoice(facedId, 'session')
  const facedLine = faced.ok ? 'ok' : `${faced.reason} · ${faced.action ?? ''} — ${faced.detail ?? ''}`
  check("LIVE: the registry's keyless seed spelled out as a NAMED id is the operator's own pick — its family's own door (base: the two-door sentence)",
    !faced.ok && faced.reason === 'no-credential:anthropic' && /\/logins anthropic/.test(faced.action ?? ''), facedLine)
  check('…naming ITS family and no other on that line', /anthropic/i.test(facedLine) && !/openai|openrouter|gemini|zai|moonshot|deepseek|huggingface/i.test(facedLine), facedLine)
  const { operatorFacingBirthReason } = await import('../../src/services/switchboard/bornSession.js')
  const spoken = operatorFacingBirthReason(`model refused (${faced.ok ? '' : faced.reason}) · ${faced.ok ? '' : faced.action ?? ''} — ${faced.ok ? '' : faced.detail ?? ''} (got "${facedId}")`)
  check("…and on the operator's own road the sentence is spoken TO the operator — no 'ask the operator', the imperative kept", !/ask the operator/.test(spoken) && /run \/logins anthropic/.test(spoken), spoken)
  // The operator's OWN pick keeps its family: a named id that is NOT the
  // default speaks that family's refusal, never the two-door sentence.
  const otherEntry = facedRegistry.entries.find(e => e.modelId !== facedId && e.session.availability !== 'available')
  if (otherEntry !== undefined) {
    const named = await wm.validateWorkerModelChoice(otherEntry.modelId, 'session')
    check(`a named NON-default id (${otherEntry.modelId}) keeps its own family's refusal`, !named.ok && named.reason !== 'no-credential:any', named.ok ? 'ok' : `${named.reason}`)
  }

  // LIVE, the positive twin: the operator's own home — only an OpenRouter
  // key, /model naming the free tier — launches unnamed ONTO that model.
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture-sovereign-home'
  seedHome(HOME_MODEL)
  const chosen = await wm.validateWorkerModelChoice(undefined, 'session')
  check("LIVE: with only an OpenRouter key and /model naming nemotron:free, the unnamed launch lands ON the operator's chosen model (base: the lane's first catalogue row)",
    chosen.ok && chosen.entry.modelId === HOME_MODEL, chosen.ok ? chosen.entry.modelId : freshLine)
  // …and with the key alone (no /model), any credentialed family wins over
  // the keyless first-party remainder.
  rmSync(join(home, 'settings.json'), { force: true })
  resetSettingsCache()
  const keyOnly = await wm.validateWorkerModelChoice(undefined, 'session')
  check('LIVE: with the key alone the unnamed launch lands on the credentialed lane, never a keyless first-party row',
    keyOnly.ok && declaredRouteOf(keyOnly.entry.modelId) === 'openrouter', keyOnly.ok ? keyOnly.entry.modelId : `${keyOnly.reason}`)
  delete process.env.OPENROUTER_API_KEY
}

await new Promise<void>(resolve => origin.close(() => resolve()))
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(failures === 0 ? '\n✅ prove-neutral-home — all checks pass' : `\n❌ prove-neutral-home — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
