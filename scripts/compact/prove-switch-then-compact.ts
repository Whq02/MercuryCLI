#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-switch-then-compact.ts — the frontier matrix
//  (compact-frontier part 4): a session that ran one provider family
//  mid-conversation and switched to another must FOLD CLEAN on the model it
//  now runs — mixed-provider transcript shapes read without choking, the
//  summary lands provider-neutral, and the token counters stay truthful
//  across the switch and zero correctly at the fold.
//
//  THE MIXED TRANSCRIPT: gpt-era rounds (thinking blocks with the empty
//  signature the Responses bridge mints) → opus-era rounds (signed thinking)
//  → glm-era rounds (plain text), every round carrying real usage stamps.
//  A covering set of switch targets folds the SAME transcript: the home
//  family (anthropic), both engine dialects (openai · zai), and the
//  operator's live case (a free OpenRouter id).
//
//    M1 per target: the fold RESOLVES over the mixed shapes and lands on
//       exactly the current family's wire — no other family's lane is hit;
//    M2 the summary is PROVIDER-NEUTRAL: a plain text user message — no
//       content-block array, no vendor block vocabulary smuggled through;
//    M3 the boundary records the real pre-fold weight and the verbatim tail
//       survives the fold;
//    M4 THE COUNTERS (red-first — the stale-anchor thrash): the canonical
//       context gauge over the post-fold projection reads the folded truth,
//       never the pre-fold weight. Before the fence, the re-homed keep-tail's
//       usage rows anchored the gauge at the WHOLE dead conversation's
//       weight (probe: 154,560 of 154,560 pre-fold tokens reported over a
//       48-token folded context) — every next turn re-tripped the
//       auto-compact threshold until the rapid-refill breaker killed the
//       session;
//    M5 the counter FOLLOWS THE SWITCH: a fresh post-fold turn on the new
//       model re-anchors the gauge on its own usage — the estimate yields to
//       the wire fact;
//    M6 poison control: an UN-folded transcript anchors on its live usage
//       exactly as before — the fence never kills a live anchor.
//
//  Run:  ~/.bun/bin/bun run scripts/compact/prove-switch-then-compact.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_SIMPLE',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_HOME',
  'MERCURY_EFFORT_LEVEL',
  'MAX_THINKING_TOKENS',
  'GOOGLE_API_KEY',
  'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-compact-'))
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'

const FIXTURE_PORT = 34117

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — switch-then-compact prover exceeded 150s')
  process.exit(1)
}, 150_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: FIXTURE_PORT })
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { compactConversation, buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
const { tokenCountWithEstimation, contextFill } = await import('../../src/utils/tokens.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

/** The mixed three-family transcript. Usage stamps carry a big pre-fold
 *  weight on the late rounds, as real long sessions do. */
function makeMixedMessages(): unknown[] {
  const out: unknown[] = []
  const round = (index: number, model: string, blocks: unknown[], inputTokens: number): void => {
    out.push(createUserMessage({ content: `ask ${index}: adjust module ${index}` }))
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-0000000001${String(10 + index).slice(-2)}`,
      requestId: `req_x${index}`,
      message: {
        id: `msg_x${index}`,
        type: 'message',
        role: 'assistant',
        model,
        content: blocks,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })
  }
  // gpt era: the Responses bridge mints thinking blocks with EMPTY signatures.
  for (let index = 0; index < 3; index++) {
    round(index, 'gpt-5.5', [
      { type: 'thinking', thinking: `gpt-era reasoning ${index}`, signature: '' },
      { type: 'text', text: `gpt answer ${index}.` },
    ], 20_000 + index * 1000)
  }
  // opus era: signed thinking.
  for (let index = 3; index < 6; index++) {
    round(index, 'claude-opus-4-8', [
      { type: 'thinking', thinking: `opus reasoning ${index}`, signature: `sig-${index}-abcdef` },
      { type: 'text', text: `opus answer ${index}.` },
    ], 60_000 + index * 1000)
  }
  // glm era: plain text.
  for (let index = 6; index < 10; index++) {
    round(index, 'glm-5.2', [{ type: 'text', text: `glm answer ${index}.` }], 120_000 + index * 1000)
  }
  return out
}

function makeContext(model: string): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    denialTracking: undefined,
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
  }
  const readFileState = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    readFileState,
    options: {
      tools: [],
      mcpClients: [],
      mainLoopModel: model,
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
}

const VENDOR_BLOCK_WORDS = ['"type":"thinking"', 'reasoning_content', 'encrypted_content', 'redacted_thinking', 'function_call']

const TARGETS = [
  { name: 'switch to home (…→ opus)', model: 'claude-opus-4-8', lane: 'anthropic-seat' },
  { name: 'switch to openai (…→ gpt)', model: 'gpt-5.5', lane: 'openai-seat' },
  { name: 'switch to zai (…→ glm)', model: 'glm-5.2', lane: 'zai-seat' },
  { name: 'the live case (…→ free OpenRouter)', model: 'openrouter/nvidia/nemotron-nano-9b-v2:free', lane: 'openrouter-seat' },
]

for (const target of TARGETS) {
  section(`M1–M4 ${target.name}`)
  const before = fixture.captured.length
  const messages = makeMixedMessages()
  const preWeight = tokenCountWithEstimation(messages as never)
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await compactConversation(
      messages as never,
      makeContext(target.model) as never,
      { systemPrompt: asSystemPrompt(['mixed-history session posture']) } as never,
      true,
    )) as never as Record<string, unknown>
  } catch (err) {
    error = err as Error
  }
  const hits = fixture.captured.slice(before)
  check('M1 the fold RESOLVES over the mixed shapes', result !== undefined && error === undefined, (error?.stack ?? '').slice(0, 500))
  check(`M1 every hit rode the current family's lane (${target.lane})`, hits.length >= 1 && hits.every(h => h.lane === target.lane), hits.map(h => h.lane).join(', '))
  if (result === undefined) continue

  const summaries = (result.summaryMessages ?? []) as Array<{ message?: { content?: unknown } }>
  const summaryContent = summaries[0]?.message?.content
  check('M2 the summary is ONE plain text user message (no block array)', typeof summaryContent === 'string', typeof summaryContent)
  const summaryJson = j(summaries)
  check(
    'M2 no vendor block vocabulary rides the summary',
    VENDOR_BLOCK_WORDS.every(word => !summaryJson.includes(word)),
    VENDOR_BLOCK_WORDS.filter(word => summaryJson.includes(word)).join(', '),
  )

  const boundary = result.boundaryMarker as { compactMetadata?: { preTokens?: number } }
  check('M3 the boundary records the real pre-fold weight', boundary.compactMetadata?.preTokens === preWeight, j({ preTokens: boundary.compactMetadata?.preTokens, preWeight }))
  const kept = (result.messagesToKeep as unknown[] | undefined)?.length ?? 0
  check('M3 the verbatim tail survived the fold', kept > 0, `kept=${kept}`)

  const post = buildPostCompactMessages(result as never)
  const postFill = contextFill(post as never)
  check(
    'M4 the gauge over the post-fold projection reads the folded truth (estimate, not the dead anchor)',
    postFill.source === 'estimate' && postFill.tokens < Math.max(2000, preWeight * 0.05),
    j({ postFill, preWeight }),
  )
  check('M4 …and never the pre-fold weight', postFill.tokens !== preWeight, j(postFill))

  // M5: a fresh turn on the NEW model re-anchors the gauge on its own usage.
  const fresh = {
    type: 'assistant',
    uuid: '00000000-0000-4000-a000-000000000999',
    requestId: 'req_fresh',
    message: {
      id: 'msg_fresh',
      type: 'message',
      role: 'assistant',
      model: target.model,
      content: [{ type: 'text', text: 'first post-fold answer on the new model.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12_345, output_tokens: 55, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }
  const withFresh = [...post, createUserMessage({ content: 'first post-fold ask' }), fresh]
  const freshFill = contextFill(withFresh as never)
  check(
    'M5 the counter follows the switch: the new turn’s wire usage anchors the gauge',
    freshFill.source === 'usage' && freshFill.tokens >= 12_400 && freshFill.tokens < 13_500,
    j(freshFill),
  )
}

// ---------------------------------------------------------------------------
section('M6 poison control — an UN-folded transcript anchors on its live usage')
{
  const messages = makeMixedMessages()
  const fill = contextFill(messages as never)
  check('the live anchor stands (source usage, the last round’s weight)', fill.source === 'usage' && fill.tokens >= 129_000, j(fill))
}

await fixture.close()
clearTimeout(guard)

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ SWITCH-THEN-COMPACT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SWITCH-THEN-COMPACT FAILURE(S)`)
process.exit(1)
