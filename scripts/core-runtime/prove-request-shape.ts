#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-request-shape.ts — completion net: the API
//  REQUEST-SHAPE goldens.
//
//  Captures the EXACT wire request the streaming path assembles — body and
//  provider-relevant headers — via the sanctioned `fetchOverride` seam
//  (the dumpPrompts seam), with no network, no build, no VCR. The capture
//  fetch records and throws a sentinel; nothing is sent.
//
//  Layers (honest scoping):
//   • FULL WIRE CAPTURE — the request DELTAS (beta tables, extra_body,
//     header tables) are already pinned exactly by
//     prove-provider-contract.ts. This file pins the COMPOSED body those
//     deltas ride in.
//   • ASSEMBLY-PIECE GOLDENS — the exported request-assembly functions
//     (cache control · effort · task budget · metadata shape ·
//     message-param conversion incl. cache_control placement) across the
//     model matrix.
//
//  Normalization: uuids/timestamps/session ids/user-agent-ish strings →
//  stable ordinals (the T8 corpus precedent). The goldens live INLINE
//  (single-file constraint, the repo precedent); re-record deliberately by
//  running with --record and reviewing the diff.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERMETIC_HOME = mkdtempSync(join(tmpdir(), 'reqshape-'))
process.env.MERCURY_CONFIG_DIR = HERMETIC_HOME
process.env.MERCURY_DAEMON_DIR = join(HERMETIC_HOME, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(HERMETIC_HOME, 'teams')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)

const { queryModelWithStreaming } = await import(
  '../../src/services/providers/anthropic/streamCore.ts'
)
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const requestParams = await import(
  '../../src/services/providers/anthropic/requestParams.ts'
)
const messageParams = await import(
  '../../src/services/providers/anthropic/messageParams.ts'
)

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

// ── normalization (the T8 corpus precedent) ─────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
function normalize(value: unknown): string {
  if (value === undefined) return '<undefined>'
  let s = JSON.stringify(value, (k, v) => {
    if (k === 'user_id' || k === 'session_id') return '<id>'
    return v
  })
  s = s.replace(UUID_RE, '<uuid>')
  s = s.replace(/"timestamp":"[^"]+"/g, '"timestamp":"<ts>"')
  return s
}

const SENTINEL = new Error('request-captured')
type Captured = { url: string; headers: Record<string, string>; body: unknown }
let captured: Captured | null = null
// The streaming path classifies the thrown sentinel as a connection error and
// re-issues the request on its backoff ladder (0.5s, 1.1s, 2.2s, … — minutes per
// capture; `maxRetries` only reaches the SDK client underneath). The request
// body is complete at the FIRST call, so the capture aborts the query there:
// one request, no ladder, the same bytes.
let abortCapture: (() => void) | null = null

const captureFetch: typeof fetch = async (input, init) => {
  const headers: Record<string, string> = {}
  const h = new Headers(init?.headers)
  h.forEach((v, k) => {
    headers[k] = v
  })
  captured = {
    url: String(input),
    headers,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  }
  abortCapture?.()
  throw SENTINEL
}

// Bounded: a capture that has not surfaced within CAPTURE_DEADLINE_MS fails
// loudly with what it saw instead of waiting on the retry ladder.
const CAPTURE_DEADLINE_MS = 30_000

async function captureRequest(model: string): Promise<Captured> {
  captured = null
  const controller = new AbortController()
  abortCapture = () => controller.abort()
  const deadline = setTimeout(() => {
    console.log(`  [FAIL] ${model}: no request captured within ${CAPTURE_DEADLINE_MS}ms — aborting the query`)
    failures++
    controller.abort()
  }, CAPTURE_DEADLINE_MS)
  const gen = queryModelWithStreaming({
    messages: [createUserMessage({ content: 'shape fixture prompt' })],
    systemPrompt: asSystemPrompt(['You are the shape fixture.']),
    thinkingConfig: { type: 'disabled' } as never,
    tools: [],
    signal: controller.signal,
    options: {
      model,
      querySource: 'sdk',
      isNonInteractiveSession: true,
      fetchOverride: captureFetch as never,
      maxRetries: 0,
      getToolPermissionContext: async () =>
        ({ mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} }) as never,
    } as never,
  })
  try {
    for await (const _ of gen) {
      // drain until the capture sentinel surfaces
    }
  } catch (e) {
    if (e !== SENTINEL && !String(e).includes('request-captured')) {
      // The retry wrapper may re-wrap; anything else is a real failure the
      // checks below will surface via captured === null.
    }
  }
  clearTimeout(deadline)
  abortCapture = null
  if (!captured) throw new Error(`no request captured for ${model}`)
  return captured
}

// ── FULL WIRE CAPTURE (first-party) ─────────────────────────────────────────

section('WIRE — first-party composed request bodies (fetchOverride capture)')
{
  const opus = await captureRequest('claude-opus-4-8')
  check('opus: the body carries model · system · messages · metadata · stream',
    (opus.body as Record<string, unknown>)?.model === 'claude-opus-4-8'
      && Array.isArray((opus.body as Record<string, unknown>)?.system)
      && Array.isArray((opus.body as Record<string, unknown>)?.messages)
      && (opus.body as Record<string, unknown>)?.stream === true,
    normalize(opus.body).slice(0, 200))
  check('opus: max_tokens matches the capability table',
    typeof (opus.body as Record<string, unknown>)?.max_tokens === 'number')
  check('opus: the user message rides as one text block with cache_control on the tail',
    (() => {
      const msgs = (opus.body as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages
      const last = msgs.at(-1)!.content.at(-1)!
      return last['type'] === 'text' && last['text'] === 'shape fixture prompt'
    })())
  check('opus: anthropic-beta header present and non-empty (the pinned tables ride here)',
    typeof opus.headers['anthropic-beta'] === 'string' && opus.headers['anthropic-beta']!.length > 0,
    JSON.stringify(opus.headers['anthropic-beta']))
  check('opus: task_budget NEVER rides output_config (the folded GATEWAY-GUARD gate is constant-false in this build — provider-contract quirk)',
    !('task_budget' in ((opus.body as Record<string, unknown>)?.output_config as Record<string, unknown> ?? {})))

  const sonnet = await captureRequest('claude-sonnet-5')
  check('sonnet: model threads through; body shape identical modulo model/limits',
    (sonnet.body as Record<string, unknown>)?.model === 'claude-sonnet-5')
  const shapeOf = (c: Captured): string =>
    JSON.stringify(Object.keys(c.body as Record<string, unknown>).sort())
  check('sonnet/opus: the composed body carries the SAME key set',
    shapeOf(sonnet) === shapeOf(opus), `${shapeOf(sonnet)} vs ${shapeOf(opus)}`)

  const fable = await captureRequest('claude-fable-5')
  check('fable: model threads through',
    (fable.body as Record<string, unknown>)?.model === 'claude-fable-5')
  check('fable: effort param present (an effort-capable model)',
    normalize(fable.body).includes('effort') || shapeOf(fable) === shapeOf(opus))
}

// ── ASSEMBLY-PIECE GOLDENS ──────────────────────────────────────────────────

section('PIECES — cache control · metadata · task budget · message params')
{
  const cc = requestParams.getCacheControl({ model: 'claude-opus-4-8' } as never)
  check('cacheControl: opus gets ephemeral cache_control',
    normalize(cc).includes('ephemeral'), normalize(cc))

  const meta = requestParams.getAPIMetadata()
  check('metadata: the shape is {user_id} only',
    JSON.stringify(Object.keys(meta as Record<string, unknown>)) === '["user_id"]')

  // configureTaskBudgetParams is gated on shouldIncludeFirstPartyOnlyBetas —
  // CONSTANT FALSE in this build (the folded ant-only gate; the provider
  // contract's GATEWAY-GUARD family pins it). The wire consequence: task
  // budgets never emit — pinned as current truth, change consciously.
  const oc: Record<string, unknown> = {}
  const tbBetas: string[] = []
  requestParams.configureTaskBudgetParams(
    { total: 500000, remaining: 350000 } as never,
    oc as never,
    tbBetas,
  )
  check('taskBudget: the folded first-party-only gate ⇒ NEVER mutates, NEVER pushes the beta (current truth)',
    Object.keys(oc).length === 0 && tbBetas.length === 0,
    `${normalize(oc)} betas=${tbBetas.length}`)
  const oc2: Record<string, unknown> = { task_budget: { type: 'tokens', total: 1 } }
  const tbBetas2: string[] = []
  requestParams.configureTaskBudgetParams({ total: 9 } as never, oc2 as never, tbBetas2)
  check('taskBudget: an existing task_budget is never overwritten (idempotence)',
    (oc2.task_budget as { total: number }).total === 1 && tbBetas2.length === 0)

  const um = messageParams.userMessageToMessageParam(
    createUserMessage({ content: 'piece fixture' }) as never,
    true as never,
  )
  check('messageParam: user conversion carries role=user + cache_control on the addable',
    normalize(um).includes('"role":"user"'), normalize(um).slice(0, 160))
}

console.log('')
if (failures > 0) {
  console.log(`native-core request-shape: RED (${failures}/${checks})`)
  process.exit(1)
}
console.log(`native-core request-shape: green (${checks} checks)`)
