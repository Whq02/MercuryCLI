#!/usr/bin/env bun
// ============================================================================
//  scripts/tabula/prove-minerva-decode.ts
//  PROOF: MINERVA accepts what routed families actually return (operator
//  live-drive block B — "non-JSON output" on talk turns since the submodels
//  re-slot, while the free-text Console worked).
//
//  Locks:
//   (1) the decodeModelJson ladder — bare JSON · fenced · prose-wrapped ·
//       array · empty/garbage refusals — and the typed degrade line that
//       names the MODEL and the head of what it said;
//   (2) END-TO-END on the OpenAI Responses dialect (the operator's exact
//       family): a fake /responses wire answers a Minerva chat turn with
//       reasoning + FENCED JSON — the plan must apply (a note lands);
//   (3) the same wire answering pure prose — the failure is typed, names
//       the model, and lands in meta.lastError (never a bare "non-JSON
//       output");
//   (4) the queryWithModel settlement fold: the routed families mint one
//       assistant message per block — reasoning must not displace the text.
//       (2) exercises exactly this: the fenced JSON rides the SECOND minted
//       message; last-yield-wins would still pass here, but a trailing
//       provider note would not — the fold law is (2)+(3) plus the unit
//       table on the shared decode.
//
//  No network: the wire is a URL-dispatching global-fetch patch and every
//  OpenAI base pins to the patched paths (unroutable if unpatched).
//
//  Run: ~/.bun/bin/bun run scripts/tabula/prove-minerva-decode.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as unknown as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// The wire below is a URL-dispatching fetch patch — the VCR layer
// (services/vcr.ts, active only under NODE_ENV=test) must stay disarmed:
// armed, its first run RECORDS the fake wire's answer into fixtures/ and
// every later run REPLAYS it without touching fetch — which would make the
// request-body assertions below (the identity stamp on the wire) vacuous
// and leave stray fixture files in the tree. The CI arm of the same layer
// would demand a fixture this no-network proof never needs.
delete process.env.NODE_ENV
delete process.env.CI

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' MINERVA decode — routed-family answers (fake wires only)')
console.log('============================================================')

// Hermetic env bracket: scratch config home, every OpenAI base pinned.
const work = mkdtempSync(join(tmpdir(), 'minerva-decode-'))
const saved: Record<string, string | undefined> = {}
for (const k of [
  'MERCURY_CONFIG_DIR',
  'MERCURY_TABULA',
  'MERCURY_TABULA_DIR',
  'MERCURY_MINERVA_MODEL',
  'OPENAI_API_KEY',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_SESSION_ROOM',
  'MERCURY_ROOM_TOKEN',
  'MERCURY_WORKER_PARENT_PID',
]) {
  saved[k] = process.env[k]
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = join(work, 'home')
process.env.MERCURY_TABULA_DIR = join(work, 'tabula')
process.env.MERCURY_TABULA = '1'
process.env.MERCURY_MINERVA_MODEL = 'gpt-5.6-sol'
process.env.OPENAI_API_KEY = 'sk-minerva-decode-proof'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'

// ── (0) the config read guard is ARMED here (NODE_ENV is deleted above) ─────
// A container resolution before the config home is enabled must answer,
// never throw: the env pin carries the model and the effort dial reads as
// unset (an SDK host or a harness may reach a container before the boot's
// enableConfigs).
section('(0) a container answers before the config home is enabled')
{
  const slots = await import('../../src/utils/model/subModelSlots.ts')
  let origin: unknown = null
  let threw = ''
  try {
    origin = slots.resolveSubModel('minerva').origin
  } catch (e) {
    threw = String(e)
  }
  check('the minerva model resolves from the env pin, never a throw through the read guard', origin === 'env' && threw === '', threw)
  let effort: unknown = 'unread'
  try {
    effort = slots.resolveSubModelEffort('minerva')
  } catch (e) {
    threw = String(e)
  }
  check("the effort dial reads as unset before the home is enabled (the model's own default), never a throw", effort === undefined && threw === '', threw)
}
// The enableConfigs-before-mounting law: the boot enables the config home
// before any container runs; the harness does the same, on the scratch home.
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { decodeModelJson, describeUndecodableModelText } = await import(
  '../../src/utils/messages/modelJson.ts'
)
const store = await import('../../src/utils/tabula/tabulaStore.ts')
const minerva = await import('../../src/utils/tabula/minerva.ts')
const { __resetOpenaiCatalogueForTest } = await import(
  '../../src/services/providers/openai/openaiCatalogue.ts'
)

// ── (1) the decode ladder ───────────────────────────────────────────────────
section('(1) decodeModelJson ladder + typed degrade')
{
  const plan = '{"ops":[{"op":"add","text":"x"}],"reply":"ok"}'
  check('bare JSON decodes', decodeModelJson(plan).ok)
  check(
    'fenced JSON decodes (```json)',
    (() => {
      const d = decodeModelJson('```json\n' + plan + '\n```')
      return d.ok && (d.value as { reply?: string }).reply === 'ok'
    })(),
  )
  check(
    'bare-fence JSON decodes (```)',
    decodeModelJson('```\n' + plan + '\n```').ok,
  )
  check(
    'prose-wrapped JSON decodes (outermost object)',
    (() => {
      const d = decodeModelJson('Here is the plan you asked for:\n' + plan + '\nLet me know!')
      return d.ok && (d.value as { reply?: string }).reply === 'ok'
    })(),
  )
  check('array payloads decode', decodeModelJson('noise [1,2,3] noise').ok)
  check('empty text refuses', !decodeModelJson('').ok && !decodeModelJson(null).ok)
  check('pure prose refuses', !decodeModelJson('I cannot help with that.').ok)
  const line = describeUndecodableModelText('gpt-5.6-sol', 'I cannot help with that, sorry.')
  check('degrade names the model', line.includes('gpt-5.6-sol'))
  check('degrade carries the head of the answer', line.includes('I cannot help'))
  check(
    'degrade bounds a long head',
    describeUndecodableModelText('m', 'y'.repeat(400)).length < 200,
  )
  check(
    'empty answer degrades as "no text"',
    describeUndecodableModelText('glm-4.7', '   ').includes('no text'),
  )
}

// ── the fake Responses wire ─────────────────────────────────────────────────
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text'],
      supported_in_api: true,
    },
  ],
}
const realFetch = globalThis.fetch
let answerText = ''
/** Every /responses request body the fake wire saw — the prompt as it
 *  actually rode the wire (the identity-stamp assertion reads it). */
const wireBodies: string[] = []
function patchWire(): void {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url)
    if (u.endsWith('/responses') && typeof init?.body === 'string') wireBodies.push(init.body)
    if (u.includes('/models')) {
      return new Response(JSON.stringify(MODELS_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.endsWith('/responses')) {
      return sseResponse([
        sse({ type: 'response.created', response: { id: 'resp_md' } }),
        sse({ type: 'response.reasoning_summary_text.delta', delta: 'weighing the ops' }),
        sse({
          type: 'response.output_item.done',
          item: {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{ type: 'summary_text', text: 'weighing the ops' }],
            encrypted_content: 'ENC',
          },
        }),
        sse({ type: 'response.output_text.delta', delta: answerText }),
        sse({
          type: 'response.output_item.done',
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answerText }] },
        }),
        sse({
          type: 'response.completed',
          response: { id: 'resp_md', usage: { input_tokens: 50, output_tokens: 20 } },
        }),
      ])
    }
    throw new Error(`unexpected fixture URL: ${u}`)
  }) as unknown as typeof fetch
}

const dir = join(work, 'tabula', 'decode-proj')
store.appendEvents(dir, [
  { t: '2026-08-24T10:00:00Z', op: 'add', id: 'seed01', text: 'a seeded note', pri: 'next' },
])

// ── (2) fenced JSON from the openai dialect applies ─────────────────────────
section('(2) reasoning + fenced JSON answer → the plan applies')
{
  __resetOpenaiCatalogueForTest()
  patchWire()
  answerText =
    'Sure — here is the plan:\n```json\n' +
    JSON.stringify({
      ops: [{ op: 'add', text: 'benchmark the pooled gate', pri: 'now' }],
      reply: 'added the benchmark note',
    }) +
    '\n```\n'
  const res = await minerva.runMinervaMessage(dir, 'decode-proj', 'note the benchmark work')
  globalThis.fetch = realFetch
  check('the chat turn ran ok', res.ran === true && (res as { ok?: boolean }).ok === true, JSON.stringify(res))
  const notes = store.readNotes(dir)
  check(
    'the fenced-JSON plan landed (note added)',
    notes.notes.some(n => n.text === 'benchmark the pooled gate' && n.pri === 'now'),
  )
  // THE IDENTITY STAMP ON THE WIRE: the request that
  // actually rode the fake /responses wire carries the harness-stamped
  // engine line for the RESOLVED slot (the env pin above, gpt-5.6-sol on
  // the OpenAI wire) and Minerva's role statement — the model never has to
  // guess its own name, and the prompt tells it whose work is whose.
  const { providerDisplayName } = await import('../../src/services/providers/routeLaw.ts')
  const body = wireBodies.at(-1) ?? ''
  check('the wire saw exactly one /responses request for the turn', wireBodies.length === 1, String(wireBodies.length))
  check(
    'the request carries the engine-identity line with the resolved model id',
    body.includes('stamped by the Mercury harness') && body.includes('gpt-5.6-sol'),
    body.slice(0, 300),
  )
  check(
    '…naming the wire by the routing law\'s display name',
    body.includes(`via the ${providerDisplayName('openai')} wire`),
  )
  check(
    '…beside the role statement (the notepad and nothing else, never the main agent)',
    body.includes('curate this project notepad and nothing else') && body.includes('not Mercury\'s main agent'),
  )
  // The request body is JSON: the prompt's own quotes ride escaped, so the
  // shape needle is read on the unescaped text.
  const unescaped = body.replace(/\\"/g, '"')
  check(
    '…and the exact JSON shape the plan must take (spelled in the prompt, so a schema-less wire answers the same shape)',
    unescaped.includes('Output format — exactly this JSON object') && unescaped.includes('"ops":['),
    unescaped.slice(unescaped.indexOf('Output format'), unescaped.indexOf('Output format') + 80),
  )
  wireBodies.length = 0
}

// ── (3) pure prose degrades typed, names the model ──────────────────────────
section('(3) prose answer → typed degrade naming the model')
{
  __resetOpenaiCatalogueForTest()
  patchWire()
  answerText = 'I would rather discuss this in plain words.'
  const res = await minerva.runMinervaMessage(dir, 'decode-proj', 'add something else')
  globalThis.fetch = realFetch
  const reason = (res as { reason?: string }).reason ?? ''
  check('the turn ran and was refused', res.ran === true && (res as { ok?: boolean }).ok === false)
  check('the reason names the model', reason.includes('gpt-5.6-sol'), reason)
  check('the reason carries the answer head', reason.includes('rather discuss'), reason)
  check('never the bare legacy words', reason !== 'non-JSON output')
  const meta = store.readTabulaMeta(dir)
  check('meta.lastError carries the typed line', (meta.lastError ?? '').includes('gpt-5.6-sol'), meta.lastError ?? '')
}

// ── restore ─────────────────────────────────────────────────────────────────
globalThis.fetch = realFetch
for (const [k, v] of Object.entries(saved)) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
rmSync(work, { recursive: true, force: true })

console.log(failures === 0 ? '\n✅ minerva-decode GREEN' : `\n❌ minerva-decode RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
