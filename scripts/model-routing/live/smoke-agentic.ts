;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { agenticVerdict } from './smokeVerdicts.ts'

const { openaiCallModel } = await import(
  '../../../src/services/providers/openai/openaiCallModel.js'
)
const { getEmptyToolPermissionContext } = await import('../../../src/Tool.ts')

type AnyMessage = Record<string, unknown>
type Block = Record<string, unknown>

const calcTool = {
  name: 'Calc',
  inputSchema: z.object({ op: z.string(), a: z.number(), b: z.number() }),
  prompt: async () => 'one arithmetic operation: add | subtract | multiply | divide',
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

function calc(op: string, a: number, b: number): number {
  switch (op) {
    case 'add':
      return a + b
    case 'subtract':
      return a - b
    case 'multiply':
      return a * b
    case 'divide':
      return a / b
    default:
      return Number.NaN
  }
}

const transcript: AnyMessage[] = [
  userMessage(
    'Compute ((37*89)+1443)/7 step by step. You MUST use the Calc tool for every single arithmetic operation, one call at a time. State the final number when done.',
  ),
]

let reasoningReplayed = 0
let reasoningRecordedBeforeLastRequest = 0
let finalText: string | null = null
let turns = 0
for (; turns < 8; turns++) {
  reasoningRecordedBeforeLastRequest = reasoningReplayed
  const minted: AnyMessage[] = []
  const params = {
    messages: transcript as never,
    systemPrompt: ['You are Mercury. Use tools for every arithmetic step.'] as never,
    thinkingConfig: { type: 'enabled', budgetTokens: 4096 } as never,
    tools: [calcTool] as never,
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model: 'gpt-5.6-sol',
      isNonInteractiveSession: true,
      querySource: 'agent:builtin:apex-agentic-smoke',
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
      effortValue: 'xhigh',
    } as never,
  }
  for await (const item of openaiCallModel(params as never)) {
    if ((item as AnyMessage).type === 'assistant') minted.push(item as AnyMessage)
  }
  const last = minted.at(-1) as {
    apexProviderTurn?: { items?: Array<{ type?: string }> }
    message?: { stop_reason?: string }
  }
  const record = last?.apexProviderTurn
  const kinds = (record?.items ?? []).map(i => i.type).join('·')
  const reasoningCount = (record?.items ?? []).filter(i => i.type === 'reasoning').length
  console.log(
    `turn ${turns + 1}: stop=${last?.message?.stop_reason} items=[${kinds}] reasoning=${reasoningCount}`,
  )
  const errorText = minted
    .flatMap(m => ((m as { message?: { content?: Block[] } }).message?.content ?? []))
    .filter(b => b.type === 'text' && String(b.text).startsWith('API Error'))
    .map(b => String(b.text))
  if (errorText.length > 0) {
    console.error(`SMOKE FAILED (turn ${turns + 1}): ${errorText[0]}`)
    process.exit(1)
  }
  transcript.push(...minted)
  const calls = minted
    .flatMap(m => ((m as { message?: { content?: Block[] } }).message?.content ?? []))
    .filter(b => b.type === 'tool_use') as Array<{ id: string; input: { op: string; a: number; b: number } }>
  if (calls.length === 0) {
    const text = minted
      .flatMap(m => ((m as { message?: { content?: Block[] } }).message?.content ?? []))
      .filter(b => b.type === 'text')
      .map(b => String(b.text))
      .join(' ')
    console.log(`final answer: ${text.slice(0, 200)}`)
    finalText = text
    break
  }
  reasoningReplayed += reasoningCount
  for (const call of calls) {
    const result = calc(call.input.op, call.input.a, call.input.b)
    transcript.push(
      userMessage([
        { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: String(result) }] },
      ]),
    )
    console.log(`  answered ${call.id}: ${call.input.op}(${call.input.a},${call.input.b}) = ${result}`)
  }
}

const replayedInLastRequest = transcript
  .filter(m => (m as { type?: string }).type === 'assistant')
  .flatMap(m => ((m as { apexProviderTurn?: { items?: Array<{ type?: string }> } }).apexProviderTurn?.items ?? []))
  .filter(i => i.type === 'reasoning').length
console.log(`\nreasoning items recorded before the final request: ${reasoningRecordedBeforeLastRequest} · carried into it: ${replayedInLastRequest}`)
const verdict = agenticVerdict({
  finalText,
  turnsUsed: turns + 1,
  maxTurns: 8,
  reasoningRecordedBeforeLastRequest,
  reasoningReplayedInLastRequest: replayedInLastRequest,
  expected: '676.57',
})
if (!verdict.ok) {
  console.error(`SMOKE FAILED: ${verdict.reason}`)
  process.exit(1)
}
console.log('AGENTIC LIVE SMOKE GREEN — encrypted reasoning replayed in position on the real wire')
