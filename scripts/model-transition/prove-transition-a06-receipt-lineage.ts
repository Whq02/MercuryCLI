#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-a06-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'


const { toBridgeMessages } = await import('../../src/models/roads/openai/openaiCallModel.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


const ts = '2026-08-05T00:00:00.000Z'
const uid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`
const record = (tag: string): Record<string, unknown> => ({
  provider: 'openai',
  responseId: `resp_${tag}`,
  items: [
    { type: 'reasoning', id: `rs_${tag}`, encrypted_content: `opaque-${tag}`, summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: tag }] },
  ],
})
const gptTurn = (n: number, served: string, tag: string, withRecord: boolean): Record<string, unknown> => ({
  type: 'assistant',
  uuid: uid(n),
  timestamp: ts,
  message: {
    id: `msg_${n}`,
    type: 'message',
    role: 'assistant',
    model: served,
    content: [{ type: 'text', text: tag }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  ...(withRecord ? { apexProviderTurn: record(tag) } : {}),
})
const userTurn = (n: number, text: string): Record<string, unknown> => ({
  type: 'user',
  uuid: uid(n),
  timestamp: ts,
  message: { role: 'user', content: text },
})

section('§B the sameModel guard — carried iff served == target')
{
  const history = [userTurn(1, 'q'), gptTurn(2, 'gpt-5.2', 'matching', true), gptTurn(3, 'gpt-5.1', 'older', true)] as never[]
  const walk = toBridgeMessages(history as never, 'gpt-5.2')
  const carried = walk.rows.filter(r => (r as { turnRecord?: unknown }).turnRecord).length
  check('served==target carries; served!=target resets (1 of 2)', carried === 1, `${carried} carried; toBridgeMessages in src/models/roads/openai/call-model/bridgeMessages.ts must attach turnRecord only when the served model equals the target model`)
  const other = toBridgeMessages(history as never, 'gpt-5.3')
  check('a different target carries NOTHING', other.rows.filter(r => (r as { turnRecord?: unknown }).turnRecord).length === 0, 'toBridgeMessages in src/models/roads/openai/call-model/bridgeMessages.ts must drop every record whose served model differs from the target (the sameModel test)')
}

section('§C the receipt rides its message — never extracted, never re-attached')
{
  const history = [userTurn(1, 'q'), gptTurn(2, 'gpt-5.1', 'older', true), gptTurn(3, 'gpt-5.2', 'plain', false)] as never[]
  const walk = toBridgeMessages(history as never, 'gpt-5.2')
  const rows = walk.rows as Array<{ role: string; content?: unknown; turnRecord?: unknown }>
  check('dropping a record never drops its message (content derives)', rows.length === 3 && rows[1]?.content !== undefined && rows[1]?.turnRecord === undefined, 'toBridgeMessages in src/models/roads/openai/call-model/bridgeMessages.ts must derive content from the message for a turn whose record is dropped, and keep one row per message')
  check('no row gains a record its message lacked', rows[2]?.turnRecord === undefined, 'toBridgeMessages in src/models/roads/openai/call-model/bridgeMessages.ts must set turnRecord only from the message own apexProviderTurn')
}

section('§D typed reconstruction — visible, once-per-thread, honest')
{
  const recordless = [userTurn(1, 'q'), gptTurn(2, 'gpt-5.2', 'settled-no-record', false)] as never[]
  const walk = toBridgeMessages(recordless as never, 'gpt-5.2')
  check('a settled recordless GPT turn counts as reconstructed', walk.reconstructedGptTurns === 1, `${walk.reconstructedGptTurns}; toBridgeMessages in src/models/roads/openai/call-model/bridgeMessages.ts must count a settled GPT turn with no apexProviderTurn`)
  const recorded = [userTurn(1, 'q'), gptTurn(2, 'gpt-5.2', 'recorded', true)] as never[]
  check('a carried record does NOT count', toBridgeMessages(recorded as never, 'gpt-5.2').reconstructedGptTurns === 0, 'toBridgeMessages in src/models/roads/openai/call-model/bridgeMessages.ts must not count a GPT turn that has a decoded record (recordedTurnIds)')
}


console.log(failures === 0 ? '\n ✅ RECEIPTS NEVER CROSS LINEAGE (fence · guard · visibility)' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
