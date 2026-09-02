// ============================================================================
//  scripts/model-routing/live/smoke-turn — LIVE gpt-5.6-sol smoke through the NATIVE
//  runtime (§22; billed under the operator's §20.1 standing
//  consent; SOLO-RUN, never a gate member).
//
//  Proves ON THE REAL WIRE, via openaiCallModel (the exact production
//  callModel branch):
//    1. one Sol turn that requests a tool call (tool_use settles under the
//       provider call id; apexProviderTurn record lands);
//    2. the SECOND turn replays the recorded items + function_call_output —
//       the stateless-replay contract (store:false, encrypted reasoning) —
//       and the model answers from the tool result;
//    3. usage arrives; the in-process readiness latch flips to 'ready'.
//
//  bun run scripts/model-routing/live/smoke-turn.ts [--model gpt-5.6-sol] [--effort low]
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const modelArgIndex = process.argv.indexOf('--model')
const MODEL = modelArgIndex > 0 ? process.argv[modelArgIndex + 1]! : 'gpt-5.6-sol'
const effortArgIndex = process.argv.indexOf('--effort')
const EFFORT = effortArgIndex > 0 ? process.argv[effortArgIndex + 1]! : 'low'

const { openaiCallModel, openaiLiveProofState } = await import(
  '../../../src/services/providers/openai/openaiCallModel.js'
)
const { getEmptyToolPermissionContext } = await import('../../../src/Tool.ts')

type AnyMessage = Record<string, unknown>

const addTool = {
  name: 'AddNumbers',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  prompt: async () => 'adds two numbers and returns the sum',
  isReadOnly: () => true,
} as never

function userMessage(content: unknown): AnyMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

const baseOptions = {
  getToolPermissionContext: async () => getEmptyToolPermissionContext(),
  model: MODEL,
  isNonInteractiveSession: true,
  querySource: 'agent:builtin:apex-live-smoke',
  agents: [],
  hasAppendSystemPrompt: false,
  mcpTools: [],
  effortValue: EFFORT,
}

async function runTurn(messages: AnyMessage[], label: string): Promise<AnyMessage[]> {
  console.log(`\n===== ${label} (${MODEL}@${EFFORT}) =====`)
  const minted: AnyMessage[] = []
  const started = Date.now()
  const params = {
    messages: messages as never,
    systemPrompt: [
      'You are Mercury, a software-development harness. Answer tersely. Use the provided tools when arithmetic is requested.',
    ] as never,
    thinkingConfig: { type: 'enabled', budgetTokens: 4096 } as never,
    tools: [addTool] as never,
    signal: new AbortController().signal,
    options: baseOptions as never,
  }
  for await (const item of openaiCallModel(params as never)) {
    const rec = item as AnyMessage
    if (rec.type === 'assistant') {
      minted.push(rec)
      const content = (rec as { message?: { content?: Array<Record<string, unknown>> } }).message
        ?.content
      for (const block of content ?? []) {
        if (block.type === 'text') console.log(`  [text] ${String(block.text).slice(0, 200)}`)
        else if (block.type === 'thinking')
          console.log(`  [thinking] ${String(block.thinking).slice(0, 120)}…`)
        else if (block.type === 'tool_use')
          console.log(
            `  [tool_use] id=${block.id} name=${block.name} input=${JSON.stringify(block.input)}`,
          )
      }
    }
  }
  const last = minted.at(-1) as
    | {
        apexProviderTurn?: { provider: string; responseId?: string; items?: unknown[] }
        message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }; stop_reason?: string }
      }
    | undefined
  console.log(
    `  settled in ${Date.now() - started}ms · stop=${last?.message?.stop_reason} · usage in=${last?.message?.usage?.input_tokens} out=${last?.message?.usage?.output_tokens} cached=${last?.message?.usage?.cache_read_input_tokens}`,
  )
  if (last?.apexProviderTurn) {
    const items = last.apexProviderTurn.items ?? []
    const kinds = items.map(i => (i as { type?: string }).type).join(' · ')
    const hasEncrypted = items.some(
      i => typeof (i as { encrypted_content?: unknown }).encrypted_content === 'string',
    )
    console.log(
      `  apexProviderTurn: responseId=${last.apexProviderTurn.responseId?.slice(0, 18)}… items=[${kinds}] encryptedReasoning=${hasEncrypted}`,
    )
  } else {
    console.log('  apexProviderTurn: ABSENT')
  }
  return minted
}

// Turn 1 — the tool round-trip request.
const t1 = await runTurn(
  [userMessage('What is 17 + 25? Use the AddNumbers tool — do not compute it yourself.')],
  'TURN 1 · tool round-trip request',
)
const toolUse = t1
  .flatMap(m => ((m as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? []))
  .find(b => b.type === 'tool_use') as { id?: string; name?: string } | undefined
if (!toolUse?.id) {
  console.error('SMOKE FAILED: no tool_use settled in turn 1')
  process.exit(1)
}

// Turn 2 — answer the call; the request must REPLAY turn 1's recorded items.
const t2 = await runTurn(
  [
    userMessage('What is 17 + 25? Use the AddNumbers tool — do not compute it yourself.'),
    ...t1,
    userMessage([
      { type: 'tool_result', tool_use_id: toolUse.id, content: [{ type: 'text', text: '42' }] },
    ]),
  ],
  'TURN 2 · stateless replay + tool answer',
)
const t2Text = t2
  .flatMap(m => ((m as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? []))
  .filter(b => b.type === 'text')
  .map(b => String(b.text))
  .join(' ')
if (!t2Text.includes('42')) {
  console.error(`SMOKE FAILED: turn-2 answer does not carry the tool result (got: ${t2Text.slice(0, 200)})`)
  process.exit(1)
}

// Readiness latch.
const proof = openaiLiveProofState()
console.log(`\nlive-proof latch: ${proof ? `${proof.model} at ${new Date(proof.at).toISOString()}` : 'ABSENT'}`)
if (!proof) {
  console.error('SMOKE FAILED: the live-proof readiness latch did not flip')
  process.exit(1)
}
console.log('\nAPEX LIVE SMOKE (tool round-trip + stateless replay) GREEN')
