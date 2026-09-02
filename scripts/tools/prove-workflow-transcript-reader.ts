#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-workflow-transcript-reader.ts
//  PROOF for the agent-transcript reader backing the /workflows inspector.
//  Fully behavioral — the reader is bun-loadable by design. The fixture uses
//  the REAL persisted shapes (verified against live agent-<id>.jsonl files):
//  one entry per content block, assistant entries sharing message.id + usage
//  within an API turn, tool_result joined by tool_use_id, thinking blocks that
//  may carry empty text (signature-only), torn trailing line (live tail).
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-workflow-transcript-reader.ts
// ============================================================================
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { entryToRecord } from '../../src/fabric/entryCodec.js'
import { ordinalOf } from '../../src/fabric/ordinal.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACTIVITY_LAST_N,
  agentTranscriptFile,
  OUTCOME_CAP_CHARS,
  PROMPT_CAP_CHARS,
  readAgentMeta,
  readAgentTranscript,
  summarizeToolInput,
} from '../../src/tools/WorkflowTool/agentTranscriptReader.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' workflow agent-transcript reader — inspector data source')
console.log('============================================================')

const tmp = mkdtempSync(join(tmpdir(), 'wf-reader-proof-'))
const dir = tmp
const agentId = 'proof1'
const file = agentTranscriptFile(dir, agentId)

const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } })
const asst = (id: string, content: unknown[], usage?: Record<string, number>, model = 'claude-sonnet-5') => ({
  type: 'assistant',
  timestamp: '2026-07-02T12:00:00.000Z',
  message: { id, role: 'assistant', model, content, usage },
})

const bigPrompt = 'P'.repeat(PROMPT_CAP_CHARS + 500)
const bigOutcome = 'O'.repeat(OUTCOME_CAP_CHARS + 500)
const entries: unknown[] = [
  user(bigPrompt),
  // API turn 1: thinking (readable) + 20 tool_use blocks, one entry per block,
  // all sharing message id m1 + the same usage (dedupe must count ONE turn).
  asst('m1', [{ type: 'thinking', thinking: 'let me think about this', signature: 'sig' }], { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }),
  ...Array.from({ length: 20 }, (_, i) =>
    asst('m1', [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } }], { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }),
  ),
  // joined results for two calls (one error)
  user([{ type: 'tool_result', tool_use_id: 't19', content: 'ok nineteen', is_error: false }]),
  user([{ type: 'tool_result', tool_use_id: 't18', content: [{ type: 'text', text: 'boom' }], is_error: true }]),
  // API turn 2: signature-only thinking + redacted + final text
  asst('m2', [{ type: 'thinking', thinking: '', signature: 'sig2' }], { input_tokens: 10, output_tokens: 5 }),
  asst('m2', [{ type: 'redacted_thinking', data: 'x' }], { input_tokens: 10, output_tokens: 5 }),
  asst('m2', [{ type: 'text', text: bigOutcome }], { input_tokens: 10, output_tokens: 5 }),
]
let __ord = 0
const encLine = (e: unknown): string =>
  JSON.stringify(
    entryToRecord(e as never, {
      sessionId: 'wf-reader-proof',
      nextOrdinal: () => ordinalOf(++__ord),
      observedAt: '2026-07-02T12:00:00.000Z',
      source: { channel: 'interactive' },
    } as never),
  )
// the torn tail stays a torn RECORD head — the reader must skip it, same law
writeFileSync(file, entries.map(encLine).join('\n') + '\n{"schemaVersion":1,"recordId":"torn', 'utf8')
writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', description: 'proof agent' }), 'utf8')

const v = (await readAgentTranscript(file))!

section('prompt — verbatim first user message, honestly capped')
check('reader returned a view', v !== undefined)
check('prompt captured + capped', v.prompt !== undefined && v.prompt.length <= PROMPT_CAP_CHARS + 1)
check('promptTruncated flagged', v.promptTruncated === true)

section('activity — tool calls joined to results, bounded, totals honest')
check(
  `last min(fixture 20, cap ${ACTIVITY_LAST_N}) shown`,
  v.toolCalls.length === Math.min(20, ACTIVITY_LAST_N),
)
check('total is the REAL count (20), not the display cap', v.toolCallsTotal === 20)
const t19 = v.toolCalls.find(c => c.inputSummary.includes('echo 19'))
const t18 = v.toolCalls.find(c => c.inputSummary.includes('echo 18'))
check('result joined by tool_use_id', t19?.resultPreview === 'ok nineteen' && t19.isError === false)
check('error result joined + flagged', t18?.resultPreview === 'boom' && t18.isError === true)
check('unresolved calls keep undefined result (never fabricated)',
  v.toolCalls.some(c => c.resultPreview === undefined))

section('reasoning — readable vs unreadable split (the honesty boundary)')
check('readable thinking captured', v.reasoningTotal === 1 && v.reasoning[0]!.includes('let me think'))
check('signature-only + redacted counted as unreadable', v.unreadableReasoningTotal === 2)

section('outcome + usage + meta')
check('finalText is the last text block, capped', v.finalText !== undefined && v.finalText.length <= OUTCOME_CAP_CHARS + 1 && v.finalTextTruncated === true)
check('model surfaced', v.model === 'claude-sonnet-5')
check('usage deduped by message id (2 API turns, not 24)', v.usage?.apiTurns === 2)
check('usage sums per-turn once', v.usage?.inputTokens === 110 && v.usage?.outputTokens === 55 && v.usage?.cacheReadTokens === 7)
check('torn trailing line tolerated (live tail)', v.entryCount === entries.length)
const meta = await readAgentMeta(dir, agentId)
check('meta sidecar read', meta?.agentType === 'workflow-subagent' && meta.description === 'proof agent')

section('edge cases')
check('missing file → undefined (honest not-found)', (await readAgentTranscript(join(dir, 'agent-none.jsonl'))) === undefined)
check("summarizeToolInput prefers the meaningful field", summarizeToolInput({ command: 'ls -la' }) === 'ls -la')
check('summarizeToolInput collapses whitespace + clips', summarizeToolInput({ prompt: 'a\n\n' + 'b'.repeat(300) }).length <= 121)

rmSync(tmp, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.log(`RESULT: RED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('RESULT: GREEN — transcript reader proven against real persisted shapes')
