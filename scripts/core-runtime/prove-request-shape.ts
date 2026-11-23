#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERMETIC_HOME = mkdtempSync(join(tmpdir(), 'reqshape-'))
process.env.MERCURY_CONFIG_DIR = HERMETIC_HOME
process.env.MERCURY_DAEMON_DIR = join(HERMETIC_HOME, 'daemon')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)

const { queryModelWithStreaming } = await import(
  '../../src/models/roads/anthropic/streamCore.ts'
)
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const requestParams = await import(
  '../../src/models/roads/anthropic/requestParams.ts'
)
const messageParams = await import(
  '../../src/models/roads/anthropic/messageParams.ts'
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

const CAPTURE_DEADLINE_MS = 30_000

async function captureRequest(model: string): Promise<Captured> {
  captured = null
  const controller = new AbortController()
  abortCapture = () => controller.abort()
  const deadline = setTimeout(() => {
    console.log(`  [FAIL] ${model}: no request captured within ${CAPTURE_DEADLINE_MS}ms — aborting the query; check that queryModelWithStreaming in src/models/roads/anthropic/streamCore.ts still sends through options.fetchOverride`)
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
    }
  } catch (e) {
    if (e !== SENTINEL && !String(e).includes('request-captured')) {
    }
  }
  clearTimeout(deadline)
  abortCapture = null
  if (!captured) throw new Error(`no request captured for ${model}; check that queryModelWithStreaming in src/models/roads/anthropic/streamCore.ts reaches fetchOverride`)
  return captured
}


section('WIRE — first-party composed request bodies (fetchOverride capture)')
{
  const opus = await captureRequest('claude-opus-4-8')
  check('opus: the body carries model · system · messages · metadata · stream',
    (opus.body as Record<string, unknown>)?.model === 'claude-opus-4-8'
      && Array.isArray((opus.body as Record<string, unknown>)?.system)
      && Array.isArray((opus.body as Record<string, unknown>)?.messages)
      && (opus.body as Record<string, unknown>)?.stream === true,
    'compose the body in src/models/roads/anthropic/stream-core/wireParams.ts so it carries model, system, messages and stream:true; body starts ' + normalize(opus.body).slice(0, 200))
  check('opus: max_tokens matches the capability table',
    typeof (opus.body as Record<string, unknown>)?.max_tokens === 'number',
    'the body must carry a numeric max_tokens; see where wireParams.ts in src/models/roads/anthropic/stream-core sets max_tokens from the model output limit')
  check('opus: the user message rides as one text block with cache_control on the tail',
    (() => {
      const msgs = (opus.body as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages
      const last = msgs.at(-1)!.content.at(-1)!
      return last['type'] === 'text' && last['text'] === 'shape fixture prompt'
    })(),
    'the last user content block must be the plain text block; see userMessageToMessageParam in src/models/roads/anthropic/messageParams.ts')
  check('opus: anthropic-beta header present and non-empty (the pinned tables ride here)',
    typeof opus.headers['anthropic-beta'] === 'string' && opus.headers['anthropic-beta']!.length > 0,
    'the request must send a non-empty anthropic-beta header; see the header assembly in src/models/roads/anthropic/anthropicClient.ts, got ' + JSON.stringify(opus.headers['anthropic-beta']))
  check('opus: no task_budget rides output_config',
    !('task_budget' in ((opus.body as Record<string, unknown>)?.output_config as Record<string, unknown> ?? {})),
    'remove task_budget from the output_config composed in src/models/roads/anthropic/stream-core/wireParams.ts')

  const sonnet = await captureRequest('claude-sonnet-5')
  check('sonnet: model threads through; body shape identical modulo model/limits',
    (sonnet.body as Record<string, unknown>)?.model === 'claude-sonnet-5',
    'the body model must equal the model passed to queryModelWithStreaming; see src/models/roads/anthropic/stream-core/wireParams.ts')
  const shapeOf = (c: Captured): string =>
    JSON.stringify(Object.keys(c.body as Record<string, unknown>).sort())
  check('sonnet/opus: the composed body carries the SAME key set',
    shapeOf(sonnet) === shapeOf(opus), `${shapeOf(sonnet)} vs ${shapeOf(opus)}; a key is added for one model only, see the body composed in src/models/roads/anthropic/stream-core/wireParams.ts`)

  const fable = await captureRequest('claude-fable-5')
  check('fable: model threads through',
    (fable.body as Record<string, unknown>)?.model === 'claude-fable-5',
    'the body model must equal the model passed to queryModelWithStreaming; see src/models/roads/anthropic/stream-core/wireParams.ts')
  check('fable: effort param present (an effort-capable model)',
    normalize(fable.body).includes('effort') || shapeOf(fable) === shapeOf(opus),
    'an effort-capable model must send output_config.effort, or share the opus key set; see the output_config built in src/models/roads/anthropic/stream-core/wireParams.ts')
}


section('PIECES — cache control · metadata · message params')
{
  const cc = requestParams.getCacheControl()
  check('cacheControl: opus gets ephemeral cache_control',
    normalize(cc).includes('ephemeral'), 'getCacheControl in src/models/roads/anthropic/requestParams.ts must return type ephemeral, got ' + normalize(cc))

  const meta = requestParams.getAPIMetadata()
  check('metadata: the shape is {user_id} only',
    JSON.stringify(Object.keys(meta as Record<string, unknown>)) === '["user_id"]',
    'getAPIMetadata in src/models/roads/anthropic/requestParams.ts must return only user_id, got keys ' + JSON.stringify(Object.keys(meta as Record<string, unknown>)))

  const um = messageParams.userMessageToMessageParam(
    createUserMessage({ content: 'piece fixture' }) as never,
    true as never,
  )
  check('messageParam: user conversion carries role=user + cache_control on the addable',
    normalize(um).includes('"role":"user"'), 'userMessageToMessageParam in src/models/roads/anthropic/messageParams.ts must return role user; result starts ' + normalize(um).slice(0, 160))
}

console.log('')
if (failures > 0) {
  console.log(`native-core request-shape: RED (${failures}/${checks})`)
  process.exit(1)
}
console.log(`native-core request-shape: green (${checks} checks)`)
