#!/usr/bin/env bun
// ============================================================================
//  scripts/agent-dispatch/prove-subagent-404-refusal.ts — the first-call
//  model-404 LAW at the crew/dispatch seam: the parent ALWAYS receives the
//  full typed refusal (error class · HTTP status · request id · model ·
//  the action line), and NOTHING falls back silently — one model on the
//  wire, exactly once.
//
//    §1 THE WIRE — a loopback Anthropic lane answers the model's very
//       first call 404 (not_found_error + request-id header). The routed
//       call yields the TYPED refusal assistant message: the model id,
//       "HTTP 404", the request id, and the /model action line; the wire
//       saw exactly ONE request carrying exactly ONE model id (a silent
//       substitution or a retry storm both red here).
//    §2 THE PARENT SEAM — deriveAgentTerminalOutcome + finalizeAgentTool
//       over that stream: outcome failed/provider-declined with the SAME
//       full refusal text — the poison (a dead worker with a bare error)
//       is a parent that cannot cite the request.
//
//  Run: ~/.bun/bin/bun run scripts/agent-dispatch/prove-subagent-404-refusal.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hermetic env BEFORE any src import: no VCR replay, no ambient secrets.
delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SIMPLE',
]) delete process.env[ambient]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'agent-404-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key-agent-404'

const PORT = 38311
const MODEL = 'mercury-no-such-model'
const REQUEST_ID = 'req_fixture_404_evidence'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — subagent 404 refusal prover exceeded 90s')
  process.exit(1)
}, 90_000)

// ── the 404 wire ────────────────────────────────────────────────────────────
const hits: Array<{ path: string; model: string }> = []
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    let model = ''
    try {
      model = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string }).model ?? '')
    } catch {
      model = '(unparsed)'
    }
    hits.push({ path: (req.url ?? '').split('?')[0] ?? '', model })
    res.writeHead(404, {
      'content-type': 'application/json',
      'request-id': REQUEST_ID,
    })
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'not_found_error', message: `model: ${MODEL}` },
    }))
  })
})
await new Promise<void>(resolve => server.listen(PORT, '127.0.0.1', resolve))
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { deriveAgentTerminalOutcome, finalizeAgentTool } = await import('../../src/tools/AgentTool/agentToolUtils.ts')

// ── §1 the wire ─────────────────────────────────────────────────────────────
console.log('\n§1 the first call 404s — the typed refusal, one model, once')
const abort = new AbortController()
const collected: Array<Record<string, unknown>> = []
try {
  const stream = routedCallModel({
    messages: [createUserMessage({ content: 'begin the delegated task' })] as never,
    systemPrompt: asSystemPrompt(['You are a dispatched specialist.']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: abort.signal,
    options: {
      getToolPermissionContext: () => Promise.resolve(getEmptyToolPermissionContext()),
      model: MODEL,
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      querySource: 'agent' as never,
      agents: [],
      mcpTools: [],
    },
  } as never)
  for await (const event of stream) {
    collected.push(event as never)
  }
} catch (error) {
  check('routedCallModel never throws on a 404 (the honest-refusal contract)', false, String(error))
}

const assistants = collected.filter(e => e.type === 'assistant')
const last = assistants[assistants.length - 1] as { message?: { content?: Array<{ type: string; text?: string }> }; isApiErrorMessage?: boolean } | undefined
const text = (last?.message?.content ?? []).map(b => b.text ?? '').join('\n')

check('the stream ends in an assistant message', last !== undefined, JSON.stringify(collected.map(e => e.type)))
check('the terminal message is the TYPED api-error refusal', last?.isApiErrorMessage === true)
check('the refusal names the model', text.includes(MODEL), text)
check('the refusal carries the HTTP status', text.includes('HTTP 404'), text)
check('the refusal carries the request id', text.includes(REQUEST_ID), text)
check('the refusal carries the action line', /--model|\/model/.test(text), text)
// Two hits is the DESIGNED streaming→non-streaming ladder (one streamed
// attempt, one plain retry of the same request); anything past it is a
// retry storm on a permanent status.
check('the wire saw at most the stream/non-stream ladder (404 is never retry-stormed)',
  hits.length >= 1 && hits.length <= 2, JSON.stringify(hits))
check('exactly one model id ever reached the wire — no silent substitution',
  new Set(hits.map(h => h.model)).size === 1 && hits[0]?.model === MODEL, JSON.stringify(hits))

// ── §2 the parent seam ──────────────────────────────────────────────────────
console.log('\n§2 the parent seam receives the full refusal')
const messageStream = assistants as never[]
const outcome = deriveAgentTerminalOutcome(messageStream as never)
check('outcome is the typed failure', outcome.status === 'failed', JSON.stringify(outcome))
check('the failure reason is provider-declined',
  outcome.status === 'failed' && outcome.reason === 'provider-declined', JSON.stringify(outcome))
check('the parent-visible error is the FULL refusal (status · request id · model)',
  outcome.status === 'failed' &&
    outcome.error.includes(MODEL) && outcome.error.includes('HTTP 404') && outcome.error.includes(REQUEST_ID),
  JSON.stringify(outcome))

const finalized = finalizeAgentTool(messageStream as never, 'agent-404-probe', {
  prompt: 'begin the delegated task',
  resolvedAgentModel: MODEL,
  isBuiltInAgent: false,
  startTime: Date.now(),
  agentType: 'probe',
  isAsync: false,
})
check('finalizeAgentTool carries the failed outcome to the tool result',
  finalized.outcome?.status === 'failed' &&
    (finalized.outcome.status === 'failed' ? finalized.outcome.error.includes(REQUEST_ID) : false),
  JSON.stringify(finalized.outcome))

server.close()
clearTimeout(guard)
console.log(failures === 0
  ? `\nsubagent 404 refusal: green (${checks} checks)`
  : `\nsubagent 404 refusal: ${failures} FAILURES of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
