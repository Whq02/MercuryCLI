#!/usr/bin/env bun
// ============================================================================
//  scripts/repetition-guard/prove-runner-mining.ts — the runner's ADDITIVE
//  mutation-honesty fields, mined deterministically from a synthetic
//  transcript (no live spend, no model):
//
//    · mutationCalls counts Edit/Write/ChangeSet/NotebookEdit tool_use;
//    · noChangeOutcomes counts the truthful no-change result markers;
//    · maxNoChangeStreak tracks consecutive IDENTICAL (tool+input)
//      no-change outcomes, broken by any other mutation outcome;
//    · callsToFirstCorrectMutation is 1-based over mutation results;
//    · mutationFailures counts is_error mutation results;
//    · non-mutation tools never count.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stillpoint-mine-home-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — runner-mining proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

const { mineTranscript } = await import('../mission-runner/live/runner.ts')

const configHome = mkdtempSync(join(tmpdir(), 'stillpoint-mine-cfg-'))
const projectDir = join(configHome, 'projects', '-tmp-stillpoint')
mkdirSync(projectDir, { recursive: true })
const sessionId = 'st1llp01nt-sess'

let msgSeq = 0
function assistantRow(blocks: unknown[]): string {
  msgSeq += 1
  return JSON.stringify({
    type: 'assistant',
    message: { id: `msg_${msgSeq}`, model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 5 }, content: blocks },
  })
}
function userRow(blocks: unknown[]): string {
  return JSON.stringify({ type: 'user', message: { content: blocks } })
}
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const result = (id: string, text: string, isError = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: [{ type: 'text', text }],
  ...(isError ? { is_error: true } : {}),
})

const sameEditInput = { file_path: '/w/f.ts', hunks: [{ lines: '2', replace: 'l2' }] }
const rows = [
  // three IDENTICAL no-change edits (streak 3)
  assistantRow([use('t1', 'Edit', sameEditInput)]),
  userRow([result('t1', 'No changes made to /w/f.ts — the computed edit result is byte-identical to the current file content. Nothing was written.')]),
  assistantRow([use('t2', 'Edit', sameEditInput)]),
  userRow([result('t2', 'No changes made to /w/f.ts — the computed edit result is byte-identical to the current file content. Nothing was written.')]),
  assistantRow([use('t3', 'Edit', sameEditInput)]),
  userRow([result('t3', 'No changes made to /w/f.ts — the computed edit result is byte-identical to the current file content. Nothing was written.')]),
  // a DIFFERENT no-change (ChangeSet, all satisfied) — streak resets to 1
  assistantRow([use('t4', 'ChangeSet', { op: 'apply', changes: [] })]),
  userRow([result('t4', 'No changes needed — every member of plan cs-abc is already satisfied (a.ts). Nothing was written.')]),
  // the first CORRECT mutation (5th mutation result)
  assistantRow([use('t5', 'Write', { file_path: '/w/new.ts', content: 'x' })]),
  userRow([result('t5', 'File created successfully at: /w/new.ts')]),
  // one failing mutation result
  assistantRow([use('t6', 'Edit', { file_path: '/w/f.ts', old_string: 'a', new_string: 'b' })]),
  userRow([result('t6', 'The old_string was not found in the file.', true)]),
  // a non-mutation tool with a failing result — never counted as mutation
  assistantRow([use('t7', 'Bash', { command: 'false' })]),
  userRow([result('t7', 'exit 1', true)]),
]
writeFileSync(join(projectDir, `${sessionId}.jsonl`), rows.join('\n') + '\n')

const mined = mineTranscript(configHome, sessionId) as Record<string, unknown>

console.log('── mined fields ──')
check('M1 mutationCalls = 6', mined.mutationCalls === 6, String(mined.mutationCalls))
check('M2 noChangeOutcomes = 4', mined.noChangeOutcomes === 4, String(mined.noChangeOutcomes))
check('M3 maxNoChangeStreak = 3 (identical Edit ×3; ChangeSet breaks it)', mined.maxNoChangeStreak === 3, String(mined.maxNoChangeStreak))
check('M4 callsToFirstCorrectMutation = 5 (1-based over mutation results)', mined.callsToFirstCorrectMutation === 5, String(mined.callsToFirstCorrectMutation))
check('M5 mutationFailures = 1 (Bash failure never counts)', mined.mutationFailures === 1, String(mined.mutationFailures))
check('M6 toolFailures still counts every is_error (2)', mined.toolFailures === 2, String(mined.toolFailures))
check('M7 existing fields intact (turns/tools)', mined.numTurns === 7 && (mined.toolCalls as Record<string, number>).Edit === 4 && (mined.toolCalls as Record<string, number>).Bash === 1)

// a transcript with NO mutations reports zeros and omits first-correct
const emptySession = 'st1llp01nt-empty'
writeFileSync(
  join(projectDir, `${emptySession}.jsonl`),
  [assistantRow([use('x1', 'Bash', { command: 'true' })]), userRow([result('x1', 'ok')])].join('\n') + '\n',
)
const minedEmpty = mineTranscript(configHome, emptySession) as Record<string, unknown>
check('M8 no-mutation transcript: zeros + no first-correct field', minedEmpty.mutationCalls === 0 && minedEmpty.noChangeOutcomes === 0 && minedEmpty.maxNoChangeStreak === 0 && !('callsToFirstCorrectMutation' in minedEmpty))

// ── transcript vNext (the batch-D live catch: the miner must read
//    the record shape — src/fabric/record.ts owns it) ─────────────────
const vOut = (
  ordinal: number,
  msgId: string,
  content: unknown[],
  usage: Record<string, number> = {},
): string =>
  JSON.stringify({
    schemaVersion: 1,
    recordId: 'vr-' + String(ordinal),
    sessionId: 'ignored',
    threadId: 'main',
    payload: { kind: 'output', model: 'claude-fable-5', providerMessageId: msgId, usage, content },
  })
const vIn = (ordinal: number, content: unknown[]): string =>
  JSON.stringify({
    schemaVersion: 1,
    recordId: 'vr-' + String(ordinal),
    sessionId: 'ignored',
    threadId: 'main',
    payload: { kind: 'input', content },
  })
const vUse = (callId: string, name: string, input: unknown) => ({ kind: 'tool-use', callId, name, input })
const vResult = (callId: string, body: string, isError = false) => ({ kind: 'tool-result', callId, body, isError })

// A vNext turn STREAMS: several records share one providerMessageId, the
// content accumulates and usage GROWS monotonically — the LAST record per
// id carries the truth (the batch-D second live catch: first-record-wins
// mining read GM1 as 41 output tokens; the truth was ~10.8k).
const vnextSession = 'st1llp01nt-vnext'
writeFileSync(
  join(projectDir, `${vnextSession}.jsonl`),
  [
    vOut(1, 'msg-a', [{ kind: 'text', text: 'read' }], { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 10 }),
    vOut(2, 'msg-a', [{ kind: 'text', text: 'reading' }, vUse('v1', 'Read', { file_path: 'a.js' })], { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100 }),
    vIn(3, [vResult('v1', 'file body')]),
    vOut(4, 'msg-b', [vUse('v2', 'Edit', { file_path: 'a.js', old_string: 'x', new_string: 'y' })], { inputTokens: 2, outputTokens: 3 }),
    vOut(5, 'msg-b', [vUse('v2', 'Edit', { file_path: 'a.js', old_string: 'x', new_string: 'y' })], { inputTokens: 5, outputTokens: 7 }), // the same call echoed by the stream: counted ONCE
    vIn(6, [vResult('v2', 'No changes made to a.js')]),
    vOut(7, 'msg-c', [vUse('v3', 'Write', { file_path: 'b.js' })], { outputTokens: 3 }),
    vIn(8, [vResult('v3', 'wrote 40 bytes')]),
    vOut(9, 'msg-d', [vUse('v4', 'Bash', { command: 'false' })]),
    vIn(10, [vResult('v4', 'boom', true)]),
  ].join('\n') + '\n',
)
const minedVnext = mineTranscript(configHome, vnextSession) as Record<string, unknown>
console.log('── vNext fields ──')
check('V1 turns count unique providerMessageIds (4)', minedVnext.numTurns === 4, String(minedVnext.numTurns))
check('V2 model read from the wire record', JSON.stringify(minedVnext.models) === '["claude-fable-5"]')
check(
  'V3 usage is LAST-record-per-message (streamed growth, final wins)',
  minedVnext.inputTokens === 15 && minedVnext.outputTokens === 30 && minedVnext.cacheRead === 100,
  `${String(minedVnext.inputTokens)}/${String(minedVnext.outputTokens)}/${String(minedVnext.cacheRead)}`,
)
check(
  'V4 tool calls dedupe by callId across streamed echoes (Read/Edit/Write/Bash = 1 each)',
  (minedVnext.toolCalls as Record<string, number>).Read === 1 && (minedVnext.toolCalls as Record<string, number>).Edit === 1 && (minedVnext.toolCalls as Record<string, number>).Write === 1 && (minedVnext.toolCalls as Record<string, number>).Bash === 1,
)
check('V5 mutation no-change classified via callId (1)', minedVnext.noChangeOutcomes === 1, String(minedVnext.noChangeOutcomes))
check('V6 first correct mutation = 2nd mutation result', minedVnext.callsToFirstCorrectMutation === 2, String(minedVnext.callsToFirstCorrectMutation))
check('V7 non-mutation error counts toolFailures (1), never mutationFailures (0)', minedVnext.toolFailures === 1 && minedVnext.mutationFailures === 0)

// §4.7 absence is not zero: an unrecognizable transcript yields {}.
const alienSession = 'st1llp01nt-alien'
writeFileSync(
  join(projectDir, `${alienSession}.jsonl`),
  [JSON.stringify({ someFutureShape: true }), JSON.stringify({ v: 99, records: [] })].join('\n') + '\n',
)
const minedAlien = mineTranscript(configHome, alienSession) as Record<string, unknown>
check('V8 unrecognizable transcript yields ABSENT metrics ({}), never zeros', Object.keys(minedAlien).length === 0)

clearTimeout(guard)
console.log(failures === 0 ? '\nprove-runner-mining: GREEN' : `\nprove-runner-mining: RED (${failures} failure${failures === 1 ? '' : 's'})`)
process.exit(failures === 0 ? 0 : 1)
