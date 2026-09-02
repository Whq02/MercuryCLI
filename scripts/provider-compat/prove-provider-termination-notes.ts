#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-provider-termination-notes.ts — a provider-
//  side termination on the chat-completions dialects settles a VISIBLE note
//  (the openai lane's other-incomplete law extended to
//  the compat runtime and the Z.AI lane).
//
//  The gap this closes: FINISH_TO_STOP maps content_filter /
//  insufficient_system_resource / sensitive / model_context_window_exceeded /
//  network_error / unmapped-'other' finishes to end_turn. The stream-side
//  fault fires the post-settle apiErrorMessage (the ErrorCard + typed SDK
//  surface) — but the run then TERMINATES on the api-error tail
//  (turn-machine: an API-error last message ends the run), and the settled
//  turn the next request replays reads as the model CHOOSING to stop —
//  lane M's silent-stop shape, still open on these dialects (named in the
//  lane M receipt as the compat insufficient_system_resource leftover).
//  Now the cut turn carries the provider's own reason as settled text.
//
//  Fixture law (the auth-journeys pattern): scratch home, every base pinned
//  to *.fixture.invalid, the patched global fetch serves scripted SSE and
//  REFUSES any unpinned URL. No sockets, no network, no real credentials.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-provider-termination-notes.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Scratch home + credential isolation (before ANY src import) ─────────────

const HOME = mkdtempSync(join(tmpdir(), 'termination-notes-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_LOCAL_BASE_URL',
]) {
  delete process.env[k]
}

// ── Fixture bases + the two lane credentials under proof ────────────────────

process.env.MERCURY_DEEPSEEK_API_BASE = 'https://deepseek.fixture.invalid'
process.env.MERCURY_ZAI_API_BASE = 'https://zai.fixture.invalid/api/paas/v4'
process.env.DEEPSEEK_API_KEY = 'sk-fixture-deepseek'
process.env.ZAI_API_KEY = 'zai-fixture-key'

// ── The patched global fetch: scripted SSE per scenario ─────────────────────

type Scenario =
  | 'insufficient'
  | 'content-filter'
  | 'unmapped-word'
  | 'plain-stop'
  | 'zai-sensitive'
  | 'zai-stop'

const wire = { scenario: 'plain-stop' as Scenario, chatHits: 0, unpinned: [] as string[] }

function sseBytes(payloads: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of payloads) controller.enqueue(enc.encode(p))
      controller.close()
    },
  })
}

const sse = (events: unknown[], done = true): Response =>
  new Response(
    sseBytes([
      ...events.map(e => `data: ${JSON.stringify(e)}\n\n`),
      ...(done ? ['data: [DONE]\n\n'] : []),
    ]),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

const delta = (content: string) => ({ choices: [{ delta: { content } }] })
const finish = (reason: string) => ({
  choices: [{ delta: {}, finish_reason: reason }],
  usage: { prompt_tokens: 9, completion_tokens: 4 },
})

globalThis.fetch = (async (url: unknown) => {
  const u = String(url)
  if (!u.includes('fixture.invalid')) {
    wire.unpinned.push(u)
    throw new Error(`termination-notes prover: UNPINNED URL reached the wire: ${u}`)
  }
  if (u.includes('/chat/completions')) {
    wire.chatHits++
    switch (wire.scenario) {
      case 'insufficient':
        return sse([delta('partial work…'), finish('insufficient_system_resource')])
      case 'content-filter':
        return sse([delta('partial work…'), finish('content_filter')])
      case 'unmapped-word':
        return sse([delta('partial work…'), finish('banana_overflow')])
      case 'plain-stop':
        return sse([delta('the whole answer.'), finish('stop')])
      case 'zai-sensitive':
        return sse([delta('partial work…'), finish('sensitive')])
      case 'zai-stop':
        return sse([delta('the whole answer.'), finish('stop')])
    }
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

// ── Imports (after env pins; the config store armed first) ──────────────────

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { compatChatCallModel } = await import(
  '../../src/services/providers/openaicompat/compatChatCallModel.ts'
)
const { deepseekLaneProfile } = await import(
  '../../src/services/providers/deepseek/deepseekCallModel.ts'
)
const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.ts')
import type { AssistantMessage } from '../../src/types/message.ts'
import type { Options } from '../../src/types/options.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
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

async function drain(gen: AsyncGenerator<unknown, unknown>) {
  const yields: unknown[] = []
  for await (const y of gen) yields.push(y)
  const assistants = yields.filter(
    (y): y is AssistantMessage => (y as { type?: string }).type === 'assistant',
  )
  const settled = assistants.filter(a => a.isApiErrorMessage !== true)
  const errors = assistants.filter(a => a.isApiErrorMessage === true)
  return { yields, settled, errors }
}

const text = (ms: AssistantMessage[]): string =>
  ms
    .map(m =>
      Array.isArray(m.message.content)
        ? m.message.content
            .map(b => ((b as { type?: string }).type === 'text' ? (b as { text: string }).text : ''))
            .join('')
        : String(m.message.content),
    )
    .join('\n')

const lastStop = (ms: AssistantMessage[]): string | null | undefined =>
  ms.at(-1)?.message.stop_reason

function section(s: string): void {
  console.log(`\n── ${s} ──`)
}

// ── §1 compat lane (deepseek): insufficient_system_resource ─────────────────
section('§1 compat: insufficient_system_resource settles a visible note + the fault tail')
{
  wire.scenario = 'insufficient'
  const { settled, errors } = await drain(
    compatChatCallModel(deepseekLaneProfile, callParams('deepseek-chat')),
  )
  const t = text(settled)
  check('the partial content settles', t.includes('partial work…'))
  check('the note names the provider cut', t.includes('insufficient system resources'))
  check('the note says the turn was not finished', t.includes('not finished'))
  check('stop_reason stays end_turn (mapped)', lastStop(settled) === 'end_turn')
  check('the fault tail (ErrorCard/SDK surface) still fires', errors.length === 1)
}

// ── §2 compat: content_filter ───────────────────────────────────────────────
section('§2 compat: content_filter settles a visible note')
{
  wire.scenario = 'content-filter'
  const { settled } = await drain(
    compatChatCallModel(deepseekLaneProfile, callParams('deepseek-chat')),
  )
  const t = text(settled)
  check('the note names the content filter', t.includes('content filter'))
  check('the note says incomplete by provider policy', t.includes('incomplete by provider policy'))
}

// ── §3 compat: an unmapped finish word ──────────────────────────────────────
section("§3 compat: an unmapped finish word ('other') quotes the provider's raw word")
{
  wire.scenario = 'unmapped-word'
  const { settled } = await drain(
    compatChatCallModel(deepseekLaneProfile, callParams('deepseek-chat')),
  )
  const t = text(settled)
  check("the note quotes the raw word", t.includes("banana_overflow"))
  check('the note flags possible incompleteness', t.includes('may be incomplete'))
}

// ── §4 compat: a plain stop stays note-less ─────────────────────────────────
section('§4 compat: a plain stop settles clean (no note, no fault tail)')
{
  wire.scenario = 'plain-stop'
  const { settled, errors } = await drain(
    compatChatCallModel(deepseekLaneProfile, callParams('deepseek-chat')),
  )
  const t = text(settled)
  check('the answer settles whole', t.includes('the whole answer.'))
  check('no termination note', !t.includes('the provider ended this response'))
  check('no fault tail', errors.length === 0)
  check('stop_reason end_turn', lastStop(settled) === 'end_turn')
}

// ── §5 zai: sensitive ───────────────────────────────────────────────────────
section("§5 zai: finish 'sensitive' settles a visible note + the fault tail")
{
  wire.scenario = 'zai-sensitive'
  const { settled, errors } = await drain(zaiCallModel(callParams('glm-4.7') as never))
  const t = text(settled)
  check('the partial content settles', t.includes('partial work…'))
  check('the note names the content policy', t.includes("content policy ('sensitive')"))
  check('stop_reason stays end_turn (mapped)', lastStop(settled) === 'end_turn')
  check('the fault tail still fires', errors.length === 1)
}

// ── §6 zai: plain stop stays note-less ──────────────────────────────────────
section('§6 zai: a plain stop settles clean')
{
  wire.scenario = 'zai-stop'
  const { settled, errors } = await drain(zaiCallModel(callParams('glm-4.7') as never))
  const t = text(settled)
  check('the answer settles whole', t.includes('the whole answer.'))
  check('no termination note', !t.includes('the provider ended this response'))
  check('no fault tail', errors.length === 0)
}

check('no unpinned URL ever reached the wire', wire.unpinned.length === 0, wire.unpinned.join(' '))

console.log(
  failures === 0 ? `\nALL GREEN (${checks} checks)` : `\n${failures}/${checks} FAILURES`,
)
process.exit(failures === 0 ? 0 : 1)
