#!/usr/bin/env bun
// ============================================================================
//  prove-classifier-family-routing — auto-mode classification works for
//  non-Anthropic accounts.
//
//  sideQuery rides the Anthropic transport ONLY, so a session credentialed
//  with no usable Anthropic lane (OpenAI-only, engine-only, local-only)
//  must classify over the provider-routed transport — never fail-close on
//  a transport it cannot use.
//
//  The contract under proof, at its two seams:
//    §1  classifierModelChain — the pure family-aware chain law (Anthropic
//        tier first when that lane is usable; the session's own family as
//        the routed tail, and as the WHOLE chain when it is not).
//    §2  classifyOverRoutedTransport — a REAL classification round trip over
//        the provider-routed transport (queryWithModel → routedCallModel →
//        the local lane) against a loopback OpenAI-compatible FIXTURE server
//        (no live keys, no Anthropic endpoint): allow, block+reason,
//        unparseable→retryable, HTTP-500→unavailable.
//    §3  wiring pins — yoloClassifier routes non-Anthropic models through
//        the routed transport and walks the family-aware chain.
//
//  Run:  ~/.bun/bin/bun run scripts/permissions/prove-classifier-family-routing.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// Env hygiene BEFORE any src import runs its reads: the VCR must stay inert
// and local discovery must see ONLY the fixture.
delete process.env.NODE_ENV
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
// The bundle-only build macro (getUserAgent reads it on every request; the
// established prover shim).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ─────────────────────────────────────────────────────────────────────────────
console.log('— §1 the family-aware chain law —')
// ─────────────────────────────────────────────────────────────────────────────

const routedModule = await import('../../src/utils/permissions/classifierRouted.ts')
const { classifierModelChain } = routedModule
const TIER = ['claude-sonnet-5', 'claude-opus-5'] as const

const eq = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

t(
  'anthropic session: preferred first, then the tier',
  eq(
    classifierModelChain({ sessionModel: 'claude-fable-5', anthropicUsable: true, anthropicTier: TIER }),
    ['claude-fable-5', 'claude-sonnet-5', 'claude-opus-5'],
  ),
)
t(
  'anthropic session never preflights its own lane (chain identical when unusable)',
  eq(
    classifierModelChain({ sessionModel: 'claude-fable-5', anthropicUsable: false, anthropicTier: TIER }),
    ['claude-fable-5', 'claude-sonnet-5', 'claude-opus-5'],
  ),
)
t(
  'engine session + usable Anthropic lane: tier first, session family as the tail',
  eq(
    classifierModelChain({ sessionModel: 'gpt-5.2', anthropicUsable: true, anthropicTier: TIER }),
    ['claude-sonnet-5', 'claude-opus-5', 'gpt-5.2'],
  ),
)
t(
  'engine session + NO usable Anthropic lane: the session family IS the chain',
  eq(
    classifierModelChain({ sessionModel: 'gpt-5.2', anthropicUsable: false, anthropicTier: TIER }),
    ['gpt-5.2'],
  ),
)
t(
  'local-only account classifies on its local model',
  eq(
    classifierModelChain({ sessionModel: 'local/llama-3.3-70b', anthropicUsable: false, anthropicTier: TIER }),
    ['local/llama-3.3-70b'],
  ),
)
t(
  'dedupe is base-model aware (the [1m]-style tag)',
  eq(
    classifierModelChain({ sessionModel: 'claude-sonnet-5[1m]', anthropicUsable: true, anthropicTier: TIER }),
    ['claude-sonnet-5[1m]', 'claude-opus-5'],
  ),
)
t(
  'a configured Anthropic model stays primary over an engine session model',
  eq(
    classifierModelChain({
      configuredModel: 'claude-opus-5',
      sessionModel: 'gpt-5.2',
      anthropicUsable: true,
      anthropicTier: TIER,
    }),
    ['claude-opus-5', 'claude-sonnet-5'],
  ),
)
t(
  'chain is never empty and never Haiku',
  classifierModelChain({ sessionModel: 'gpt-5.2', anthropicUsable: false, anthropicTier: TIER }).length > 0 &&
    !JSON.stringify(
      classifierModelChain({ sessionModel: 'claude-fable-5', anthropicUsable: true, anthropicTier: TIER }),
    ).toLowerCase().includes('haiku'),
)

// ─────────────────────────────────────────────────────────────────────────────
console.log('— §2 a real classification over the routed transport (loopback fixture) —')
// ─────────────────────────────────────────────────────────────────────────────

// Arm the config harness: the routed path reads real owners (the stored
// local API key, prompt-state recording) whose unarmed gate throws — and
// discovery's probe catch would silently swallow that throw into "no
// servers" (the prover-config-gate class).
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

type CapturedRequest = { url: string; body?: Record<string, unknown> }
const captured: CapturedRequest[] = []
let chatContent = '<block>no'
let chatStatus = 200

const sse = (content: string): string =>
  [
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture-clf',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    })}`,
    '',
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture-clf',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/v1/models') {
      captured.push({ url })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-clf', object: 'model', owned_by: 'fixture' }] }))
      return
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      let body: Record<string, unknown> | undefined
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = undefined
      }
      captured.push({ url, body })
      if (chatStatus !== 200) {
        res.writeHead(chatStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fixture-injected failure', type: 'server_error' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(chatContent))
      return
    }
    // Every other probe endpoint (ollama/lmstudio/llama.cpp sniffs) is absent.
    captured.push({ url })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
process.env.MERCURY_LOCAL_BASE_URL = `http://127.0.0.1:${port}`

const SENTINEL = 'Use the classify_result tool to report your classification.'
const SYSTEM = `You are the auto-mode security classifier. Decide whether the action is safe.\n${SENTINEL}`
const TRANSCRIPT = 'User: tidy the repo\n'
const ACTION = 'Bash {"command":"git status"}\n'

const classify = (): ReturnType<typeof routedModule.classifyOverRoutedTransport> =>
  routedModule.classifyOverRoutedTransport({
    model: 'local/fixture-clf',
    systemPrompt: SYSTEM,
    instructionPrefix: 'The user works in a git repository.',
    transcript: TRANSCRIPT,
    actionText: ACTION,
    signal: new AbortController().signal,
  })

// Allow.
chatContent = '<thinking>routine read-only git command</thinking><block>no'
const allow = await classify()
t('allow verdict parses (shouldBlock false)', allow.shouldBlock === false, JSON.stringify(allow))
t('allow rides the fixture model', allow.model === 'local/fixture-clf')
t('allow carries the thinking text', allow.thinking === 'routine read-only git command')

const chatRequests = captured.filter(c => c.url === '/v1/chat/completions' && c.body)
t('the classification reached the fixture over the routed transport', chatRequests.length === 1)
const firstBody = chatRequests[0]?.body ?? {}
t('wire model id is the local record id (prefix stripped)', firstBody.model === 'fixture-clf')
const wire = JSON.stringify(firstBody)
t('the XML output grammar replaced the tool sentinel', wire.includes('a <block> element holding') && !wire.includes(SENTINEL))
t('transcript + action + instruction prefix ride the request', wire.includes('git status') && wire.includes('tidy the repo') && wire.includes('git repository'))

// Block + reason.
chatContent = '<thinking>destructive</thinking><block>yes</block><reason>rewrites shared history</reason>'
const block = await classify()
t('block verdict parses with its reason', block.shouldBlock === true && block.reason === 'rewrites shared history')
t('block is a clean verdict (no retry classes)', block.retryable !== true && block.unavailable !== true)

// Unparseable → retryable fail-closed.
chatContent = 'Looks fine to me!'
const junk = await classify()
t('unparseable output fail-closes as retryable', junk.shouldBlock === true && junk.retryable === true)

// HTTP 500 → unavailable fail-closed (the chain-walk class).
chatStatus = 500
const down = await classify()
t('a failing endpoint fail-closes as unavailable', down.shouldBlock === true && down.unavailable === true)
chatStatus = 200

server.close()

// ─────────────────────────────────────────────────────────────────────────────
console.log('— §3 wiring pins (yoloClassifier drives both seams) —')
// ─────────────────────────────────────────────────────────────────────────────

const yolo = readFileSync('src/utils/permissions/yoloClassifier.ts', 'utf8')
const classifyBand = yolo.slice(
  yolo.indexOf('export async function classifyYoloAction('),
  yolo.indexOf('function projectAction'),
)
t(
  'non-Anthropic-routed models take the routed transport',
  classifyBand.includes("declaredRouteOf(model) !== 'anthropic'") &&
    classifyBand.includes('classifyOverRoutedTransport({'),
)
t(
  'the routed branch sits before the two-stage gate (no sideQuery for routed models)',
  classifyBand.indexOf('classifyOverRoutedTransport') !== -1 && classifyBand.indexOf('classifyOverRoutedTransport') < classifyBand.indexOf('classifyYoloActionTwoStage'),
)
t('the fallback walk iterates the family-aware chain', yolo.includes('for (const candidate of getClassifierModelChain())'))
t('the primary model is the chain head', yolo.includes('return getClassifierModelChain()[0]!'))
t(
  'availability comes from the owning resolver, not a hardcoded family',
  yolo.includes("usabilityForRoute('anthropic').usable"),
)
t('an Anthropic-only model coercion is unrepresentable', !yolo.includes('return CLASSIFIER_FALLBACK_MODELS[0]'))

console.log(failures ? '\n❌ CLASSIFIER-FAMILY-ROUTING RED' : '\n✅ CLASSIFIER-FAMILY-ROUTING GREEN')
process.exit(failures)
