#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-rows-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { CheckpointTool } = await import('../../src/tools/CheckpointTool/CheckpointTool.js')
const { RewindTool } = await import('../../src/tools/RewindTool/RewindTool.js')
type Row = { type?: unknown; props?: { dimColor?: boolean; children?: unknown } }

section('§1 THE SHARED CONTRACT — deferred, bounded, read-only, never concurrent, a dim message row, JSON to the model')
for (const tool of [CheckpointTool, RewindTool]) {
  check(`${tool.name} is deferred and bounded at 10000 characters`, tool.shouldDefer === true && tool.maxResultSizeChars === 10_000)
  check(`${tool.name} is read-only and never concurrent`, tool.isReadOnly({} as never) === true && tool.isConcurrencySafe({} as never) === false)
  const row = tool.renderToolResultMessage!({ message: 'the words', goal: 'g', messageCount: 1, takenAt: 't', abandonedMessages: 0 } as never, {} as never) as Row
  check(`${tool.name} paints its message dim`, React.isValidElement(row) && (row as Row).props?.dimColor === true && (row as Row).props?.children === 'the words', j(row))
  const block = tool.mapToolResultToToolResultBlockParam!({ message: 'm', goal: 'g' } as never, 'toolu_x') as { type: string; tool_use_id: string; content: string }
  check(`${tool.name} hands the model the output as JSON`, block.type === 'tool_result' && block.tool_use_id === 'toolu_x' && JSON.parse(block.content).goal === 'g', j(block))
}
check('the user-facing names', CheckpointTool.userFacingName() === 'Checkpoint' && RewindTool.userFacingName() === 'Rewind')

section('§2 THE HEADERS AND ACTIVITIES')
check('the checkpoint header is the goal, or empty', CheckpointTool.renderToolUseMessage!({ goal: 'probe the store' } as never, {} as never) === 'probe the store' && CheckpointTool.renderToolUseMessage!({} as never, {} as never) === '')
check('the checkpoint activity names the goal, or stands alone', CheckpointTool.getActivityDescription!({ goal: 'probe' } as never) === 'Checkpointing: probe' && CheckpointTool.getActivityDescription!({} as never) === 'Checkpointing')
const long = 'x'.repeat(81)
check('the rewind header cuts a report over 80 characters to 77 and an ellipsis', RewindTool.renderToolUseMessage!({ report: long } as never, {} as never) === `${'x'.repeat(77)}…` && RewindTool.renderToolUseMessage!({ report: 'x'.repeat(80) } as never, {} as never) === 'x'.repeat(80) && RewindTool.renderToolUseMessage!({} as never, {} as never) === '')
check('the rewind activity is fixed', RewindTool.getActivityDescription!({} as never) === 'Rewinding to the checkpoint')

section('§3 THE CHECKPOINT RESULT — the count, the goal, an ISO stamp')
{
  const before = Date.now()
  const result = await CheckpointTool.call({ goal: 'first' } as never, { messages: [{ type: 'user' }, { type: 'assistant' }] } as never)
  const data = (result as { data: { message: string; goal: string; messageCount: number; takenAt: string } }).data
  check('the message counts the messages', data.message === 'Checkpoint taken (2 messages). Rewind { report } restores this context state; files and git are never touched.', data.message)
  check('the goal and count ride along with an ISO stamp of now', data.goal === 'first' && data.messageCount === 2 && Date.parse(data.takenAt) >= before - 1000 && data.takenAt.endsWith('Z'), j(data))
  const none = await CheckpointTool.call({ goal: 'bare' } as never, {} as never)
  check('a context without messages counts zero', (none as { data: { messageCount: number } }).data.messageCount === 0)
}

console.log(failures === 0 ? '\nPASS checkpoint pair rows' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
