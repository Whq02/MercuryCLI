// ============================================================================
//  prove-wire-id-truth — the operator's OpenRouter 400 and its whole class
//  (LANE WID).
//
//  The live failure: Mercury sent 'anthropic/openai/gpt-5.6-terra[1m]' as an
//  OpenRouter model id — a second vendor prefix composed onto an already
//  carrier-shaped id AND a display annotation riding into the wire. One
//  string, two classes. This prover pins the corrected law end-to-end on a
//  loopback fixture (every base pinned; the chat endpoint records the exact
//  wire model id):
//
//    1. catalogue row → /model row → dispatch yields the CANONICAL carrier
//       id on the wire, byte-exact — no second prefix, no display tags;
//    2. a legacy-persisted id wearing Mercury's [1m] dressing HEALS (the
//       annotation strips; the vendor's own slug dispatches — never a 400);
//    3. structural junk (the operator's exact string) REFUSES catalogue-
//       worded BEFORE any HTTP — the fixture sees zero bytes;
//    4. the persisted spelling round-trips byte-identical through the
//       session override slot and the boot-read parse
//       (parseUserSpecifiedModel — the transform every boot applies to the
//       saved setting);
//    5. the picker never offers Mercury's context toggle on a carrier row,
//       and carrier ids never substring-join onto first-party canonicals
//       (identity, window, 1M truth stay the vendor's);
//    6. the one wire-id owner (canonicalWireModelId) and the lane profile's
//       projection agree on every dispatchable id.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch config home + fixture pins BEFORE any src import (ambient-state law).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'fixture' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wid-truth-'))
delete process.env.ANTHROPIC_MODEL
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.ZAI_API_KEY
delete process.env.MOONSHOT_API_KEY
delete process.env.DEEPSEEK_API_KEY
delete process.env.GEMINI_API_KEY
delete process.env.HF_TOKEN

// ── the loopback fixture (catalogue + chat; the wire recorder) ──────────────

interface Captured {
  path: string
  model: string
}
const captured: Captured[] = []
const unknownHits: string[] = []

// The fixture catalogue: the operator's case is the terra row — an id that
// is ALREADY vendor/model; the fable row is the real live slug the healed
// legacy pick must land on; the aggregate row is the router's own. The
// poisoned-feed section swaps in CATALOGUE_POISONED — the operator's live
// screen: junk-wrapped rows ('anthropic/' qualification + Mercury [1m]
// dressing composed into the DATA) beside their clean listed twins.
let CATALOGUE: { data: Array<Record<string, unknown>>; total_count: number; links: { next: null } } = {
  data: [
    { id: 'openai/gpt-5.6-terra', name: 'OpenAI: GPT-5.6 Terra', context_length: 1_050_000 },
    { id: 'anthropic/claude-fable-5', name: 'Anthropic: Claude Fable 5', context_length: 200_000 },
    { id: 'openrouter/auto', name: 'Auto Router' },
  ],
  total_count: 3,
  links: { next: null },
}
const CATALOGUE_POISONED: typeof CATALOGUE = {
  data: [
    // Junk-wrapped rows exactly as the operator's screen spelled them…
    { id: 'anthropic/claude-opus-5[1m]', name: 'anthropic/claude-opus-5[1m]' },
    { id: 'anthropic/openai/gpt-5.6-sol[1m]', name: 'anthropic/openai/gpt-5.6-sol[1m]' },
    { id: 'anthropic/x-ai/grok-4.6', name: 'anthropic/x-ai/grok-4.6' },
    // …their clean listed twins (the vendor truth the heal adjudicates on)…
    { id: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5', context_length: 1_000_000 },
    { id: 'openai/gpt-5.6-sol', name: 'OpenAI: GPT-5.6 Sol', context_length: 1_050_000 },
    { id: 'x-ai/grok-4.6', name: 'xAI: Grok 4.6' },
    // …and junk with NO listed twin (must render visible-but-unavailable).
    { id: 'anthropic/meta/muse-spark-1.2[1m]', name: 'anthropic/meta/muse-spark-1.2[1m]' },
  ],
  total_count: 7,
  links: { next: null },
}

function chatSse(): string {
  const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`
  return [
    sse({ id: 'fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'wire-truth-final' } }] }),
    sse({ id: 'fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
    'data: [DONE]\n\n',
  ].join('')
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path === '/openrouter/api/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(CATALOGUE))
      return
    }
    if (req.method === 'POST' && path === '/openrouter/api/v1/chat/completions') {
      let model = ''
      try {
        model = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }).model ?? '')
      } catch {
        model = '<unparseable>'
      }
      captured.push({ path, model })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatSse())
      return
    }
    if (req.method === 'GET' && path === '/openrouter/api/v1/key') {
      // The polled key-usage refresh the response seam kicks — well-formed
      // empty so the usage owner stays quiet.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { usage: 0 } }))
      return
    }
    unknownHits.push(`${req.method} ${path}`)
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`

Object.assign(process.env, {
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  OPENROUTER_API_KEY: 'sk-or-v1-fixture-wire-truth',
})

// ── src imports (after env) ─────────────────────────────────────────────────
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)

const { canonicalWireModelId, qualifiedWireId, declaredRouteOf } = await import(
  '../../src/services/providers/routeLaw.ts'
)
const { compatDispatchModelId } = await import(
  '../../src/services/providers/openaicompat/compatChatCallModel.ts'
)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { refreshOpenrouterCatalogue, getOpenrouterModelOptions } = await import(
  '../../src/services/providers/openrouter/openrouterCatalogue.ts'
)
const { focusedOptionSupports1m, withContext1m } = await import(
  '../../src/utils/model/modelOptions.ts'
)
const { getCanonicalName, getMainLoopModel, parseUserSpecifiedModel } = await import(
  '../../src/utils/model/model.ts'
)
const { modelSupports1M, resolveContextWindow } = await import(
  '../../src/utils/model/capabilities.ts'
)
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type Options = import('../../src/services/providers/anthropic/streamCore.ts').Options

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

function callParams(model: string) {
  return {
    messages: [],
    systemPrompt: asSystemPrompt(['You are the fixture.']),
    thinkingConfig: { type: 'disabled' as const },
    tools: [],
    signal: new AbortController().signal,
    options: {
      model,
      querySource: 'repl_main_thread',
      isNonInteractiveSession: true,
      getToolPermissionContext: async () => ({}) as never,
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
    } as unknown as Options,
  }
}

async function drive(model: string): Promise<{ assistants: AssistantMessage[]; errors: AssistantMessage[] }> {
  const assistants: AssistantMessage[] = []
  for await (const y of routedCallModel(callParams(model) as never)) {
    if ((y as { type?: string }).type === 'assistant') assistants.push(y as AssistantMessage)
  }
  return { assistants, errors: assistants.filter(a => a.isApiErrorMessage === true) }
}

function messageText(m: AssistantMessage | undefined): string {
  const content = m?.message.content
  if (!Array.isArray(content)) return String(content ?? '')
  return content.map(b => ((b as { type?: string }).type === 'text' ? (b as { text: string }).text : '')).join('')
}

console.log('============================================================')
console.log(' wire-id truth — the OpenRouter 400 class, hardened (LANE WID)')
console.log('============================================================')

// ============================================================================
section('1 · catalogue row → /model row: canonical values, no toggle, selectable')
// ============================================================================
await refreshOpenrouterCatalogue('env', { force: true })
const rows = getOpenrouterModelOptions().filter(r => !String(r.value).startsWith('__'))
check('the fixture catalogue renders all three rows', rows.length === 3)
const terraRow = rows.find(r => r.value === 'openrouter/openai/gpt-5.6-terra')
check("the operator's row persists provider-qualified over the vendor's own id", terraRow !== undefined && terraRow.unavailable === undefined)
check(
  'every row value round-trips the routing law back to openrouter',
  rows.every(r => declaredRouteOf(String(r.value)) === 'openrouter'),
)
check(
  "Mercury's context toggle is NEVER offered on a carrier row",
  rows.every(r => focusedOptionSupports1m(String(r.value)) === false),
)
check(
  'carrier ids never substring-join onto first-party canonicals',
  getCanonicalName('openrouter/anthropic/claude-fable-5') === 'openrouter/anthropic/claude-fable-5' &&
    getCanonicalName('openrouter/anthropic/claude-opus-5') === 'openrouter/anthropic/claude-opus-5' &&
    modelSupports1M('openrouter/anthropic/claude-fable-5') === false,
)

// ============================================================================
section("2 · the operator's case: picked row → dispatch → the EXACT wire id")
// ============================================================================
{
  const before = captured.length
  const { errors } = await drive('openrouter/openai/gpt-5.6-terra')
  check('the turn settled without an API error', errors.length === 0, messageText(errors[0]))
  const wire = captured[captured.length - 1]
  check(
    'the wire received the canonical carrier id BYTE-EXACT — no second prefix, no tags',
    captured.length === before + 1 && wire?.model === 'openai/gpt-5.6-terra',
    `wire saw '${wire?.model}'`,
  )
}

// ============================================================================
section('3 · a legacy [1m]-dressed pick HEALS to the vendor slug (never a 400)')
// ============================================================================
{
  const dressed = withContext1m('openrouter/anthropic/claude-fable-5')
  check('the dressing under test is the shipped toggle spelling', dressed === 'openrouter/anthropic/claude-fable-5[1m]')
  const { assistants, errors } = await drive(dressed)
  const wire = captured[captured.length - 1]
  check('the healed dispatch settled', errors.length === 0, messageText(errors[0]))
  check(
    "the wire received the vendor's own slug (annotation healed off)",
    wire?.model === 'anthropic/claude-fable-5',
    `wire saw '${wire?.model}'`,
  )
  const stamp = assistants.find(a => !a.isApiErrorMessage)?.message.model
  check(
    'the transcript stamp keeps the QUALIFIED healed id (resume re-routes home)',
    stamp === 'openrouter/anthropic/claude-fable-5' && declaredRouteOf(String(stamp)) === 'openrouter',
    `stamp '${stamp}'`,
  )
}

// ============================================================================
section("4 · the operator's junk REFUSES catalogue-worded — zero bytes hit the wire")
// ============================================================================
{
  const junk = 'openrouter/anthropic/openai/gpt-5.6-terra[1m]'
  const before = captured.length
  const { errors } = await drive(junk)
  check('the dispatch yielded exactly one honest refusal', errors.length === 1)
  const text = messageText(errors[0])
  check(
    'the refusal names the class and the way back (catalogue words)',
    /second vendor prefix/.test(text) && /\/model/.test(text),
    text.slice(0, 160),
  )
  check('the fixture saw NO request for the junk id', captured.length === before)
}

// ============================================================================
section("5 · the router's own aggregate: openrouter/openrouter/auto → openrouter/auto")
// ============================================================================
{
  const { errors } = await drive('openrouter/openrouter/auto')
  const wire = captured[captured.length - 1]
  check('the aggregate dispatch settled', errors.length === 0, messageText(errors[0]))
  check("the wire received the router's own slug", wire?.model === 'openrouter/auto', `wire saw '${wire?.model}'`)
}

// ============================================================================
section('6 · the persistence round-trip: override slot → boot parse → dispatch, byte-identical')
// ============================================================================
{
  const picked = 'openrouter/openai/gpt-5.6-terra'
  check(
    'the boot-read parse is BYTE-IDENTICAL on every carrier spelling',
    parseUserSpecifiedModel(picked) === picked &&
      parseUserSpecifiedModel('openrouter/anthropic/claude-fable-5') === 'openrouter/anthropic/claude-fable-5' &&
      parseUserSpecifiedModel('openrouter/openrouter/auto') === 'openrouter/openrouter/auto' &&
      parseUserSpecifiedModel('huggingface/openai/gpt-oss-120b:cheapest') === 'huggingface/openai/gpt-oss-120b:cheapest' &&
      parseUserSpecifiedModel('local/hf.co/org/model:tag') === 'local/hf.co/org/model:tag' &&
      parseUserSpecifiedModel('compat/qwen3-32b') === 'compat/qwen3-32b',
  )
  bootstrap.setMainLoopModelOverride(picked)
  check('the session override slot answers the picked id byte-identical', getMainLoopModel() === picked)
  const before = captured.length
  const { errors } = await drive(getMainLoopModel())
  const wire = captured[captured.length - 1]
  check(
    'the round-tripped id dispatches the canonical wire id',
    errors.length === 0 && captured.length === before + 1 && wire?.model === 'openai/gpt-5.6-terra',
    `wire saw '${wire?.model}'`,
  )
  bootstrap.setMainLoopModelOverride(undefined)
}

// ============================================================================
section('7 · window truth: Mercury dressing on a carrier id never buys a 1M budget')
// ============================================================================
{
  const resolution = resolveContextWindow('openrouter/anthropic/claude-fable-5[1m]')
  check(
    'the suffix resolves as the base id with activation honestly unavailable',
    resolution.activation.kind === 'unavailable' && resolution.effectiveWindow < 1_000_000,
    `window ${resolution.effectiveWindow}, activation ${resolution.activation.kind}`,
  )
}

// ============================================================================
section('8 · the one owner and the lane projection agree on every dispatchable id')
// ============================================================================
{
  const ids = [
    'openrouter/openai/gpt-5.6-terra',
    'openrouter/anthropic/claude-fable-5[1m]',
    'openrouter/openrouter/auto',
    'huggingface/Qwen/Qwen3.8-2.4T-A95B',
    'compat/some-model[served]',
    'local/hf.co/org/model:tag',
    'kimi-k3[1m]',
  ]
  check(
    'owner wireId === lane projection (qualifiedWireId ∘ compatDispatchModelId) on all',
    ids.every(id => {
      const v = canonicalWireModelId(id)
      return v.ok && v.wireId === qualifiedWireId(compatDispatchModelId(id))
    }),
  )
}

// ============================================================================
section("9 · the poisoned feed: junk rows HEAL onto listed twins; the operator's screen renders vendor truth")
// ============================================================================
{
  const { __resetOpenrouterCatalogueForTest } = await import(
    '../../src/services/providers/openrouter/openrouterCatalogue.ts'
  )
  CATALOGUE = CATALOGUE_POISONED
  __resetOpenrouterCatalogueForTest()
  await refreshOpenrouterCatalogue('env', { force: true })
  const rows2 = getOpenrouterModelOptions().filter(r => !String(r.value).startsWith('__'))
  const values = rows2.map(r => String(r.value))
  check(
    'a dressed anthropic-vendor row heals onto its clean twin (one row, vendor name)',
    values.filter(v => v === 'openrouter/anthropic/claude-opus-5').length === 1 &&
      rows2.find(r => r.value === 'openrouter/anthropic/claude-opus-5')?.label === 'Anthropic: Claude Opus 5' &&
      rows2.find(r => r.value === 'openrouter/anthropic/claude-opus-5')?.unavailable === undefined,
  )
  check(
    "the operator's wrapped GPT row heals onto the listed openai/ twin",
    values.filter(v => v === 'openrouter/openai/gpt-5.6-sol').length === 1 &&
      rows2.find(r => r.value === 'openrouter/openai/gpt-5.6-sol')?.unavailable === undefined,
  )
  check(
    'the wrapped grok row (no dressing, one spurious segment) heals the same way',
    values.filter(v => v === 'openrouter/x-ai/grok-4.6').length === 1,
  )
  check(
    'no junk spelling survives as a SELECTABLE row value (unavailable rows keep the data verbatim)',
    rows2
      .filter(r => r.unavailable === undefined)
      .every(r => !String(r.value).includes('[1m]') && !/^openrouter\/anthropic\/(openai|x-ai|meta)\//.test(String(r.value))),
    values.join(' · '),
  )
  const orphan = rows2.find(r => String(r.value).includes('muse-spark'))
  check(
    'junk with NO listed twin renders visible-but-unavailable with the honest reason',
    orphan !== undefined && orphan.unavailable !== undefined && /display/.test(orphan.unavailable),
  )
  check(
    'no displayed LABEL paints a family-qualified junk spelling',
    rows2.filter(r => r.unavailable === undefined).every(r => !r.label.includes('[1m]') && !/^anthropic\/(openai|x-ai|meta)\//.test(r.label)),
    rows2.map(r => r.label).join(' · '),
  )
  check(
    'every selectable row value round-trips: openrouter route + an ok wire verdict',
    rows2
      .filter(r => r.unavailable === undefined)
      .every(r => {
        const v = String(r.value)
        const verdict = canonicalWireModelId(v)
        return declaredRouteOf(v) === 'openrouter' && verdict.ok && verdict.healed !== true
      }),
  )
}

// ============================================================================
section('10 · bare vendor slugs never join first-party identity (the carrier-shaped law)')
// ============================================================================
{
  check(
    'getCanonicalName is identity on bare vendor slugs (no substring family fold)',
    getCanonicalName('anthropic/claude-opus-5') === 'anthropic/claude-opus-5' &&
      getCanonicalName('anthropic/claude-fable-5') === 'anthropic/claude-fable-5',
  )
  check(
    "modelSupports1M refuses bare vendor slugs (no Mercury 1M opt-in on a carrier row)",
    modelSupports1M('anthropic/claude-fable-5') === false &&
      modelSupports1M('anthropic/claude-opus-5') === false &&
      modelSupports1M('anthropic/z-ai/glm-5.3') === false,
  )
  check(
    'the picker toggle never offers on bare vendor slugs',
    focusedOptionSupports1m('anthropic/claude-fable-5') === false &&
      focusedOptionSupports1m('anthropic/openai/gpt-5.6-sol') === false,
  )
  const dressed = resolveContextWindow('anthropic/claude-fable-5[1m]')
  check(
    'a dressed bare vendor slug budgets its base window, activation honestly unavailable',
    dressed.activation.kind === 'unavailable' && dressed.effectiveWindow < 1_000_000,
    `window ${dressed.effectiveWindow}, activation ${dressed.activation.kind}`,
  )
}

check('no unexpected endpoint was hit', unknownHits.length === 0, unknownHits.join(' · '))
server.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
