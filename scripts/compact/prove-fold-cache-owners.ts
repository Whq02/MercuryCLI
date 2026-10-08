#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-cache-owners-'))
delete process.env.MERCURY_EFFORT_LEVEL
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { shouldRideCacheSharingFork } = await import('../../src/services/compact/compact.ts')
const { addCacheBreakpoints } = await import('../../src/services/providers/anthropic/cacheAndUsage.ts')
const { lastAssistantTimestamp, restoreSessionStateFromLog } = await import('../../src/utils/sessionRestore.ts')
const { getLastApiCompletionTimestamp, setLastApiCompletionTimestamp } = await import('../../src/bootstrap/state.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)
for (const type of ['disabled', 'adaptive', 'enabled']) {
  check(`the Anthropic cache fork is independent of ${type} thinking`, shouldRideCacheSharingFork('claude-fable-5-1', { type }))
  check(`the OpenAI direct request is independent of ${type} thinking`, !shouldRideCacheSharingFork('gpt-5.5', { type }))
}
{
  let seq = 0
  const uuid = (): string => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`
  const assistant = (text: string): unknown => ({ type: 'assistant', uuid: uuid(), timestamp: new Date().toISOString(), message: { id: `msg_${seq}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  const toolResult = (): unknown => createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] })
  const markedIndexes = (params: unknown[]): number[] => params.flatMap((p, i) => {
    const content = (p as { content: unknown }).content
    return Array.isArray(content) && content.some(b => (b as { cache_control?: unknown }).cache_control !== undefined) ? [i] : []
  })
  const forkMessages = [createUserMessage({ content: 'first' }), assistant('a'), toolResult(), assistant('b'), createUserMessage({ content: 'summarise' })]
  const fork = addCacheBreakpoints(forkMessages as never, true, false, null, [], true)
  check('a fork marks the last parent user row, not the assistant before its prompt', j(markedIndexes(fork as never)) === j([2]), j(markedIndexes(fork as never)))
  const forkAfterUser = [createUserMessage({ content: 'first' }), assistant('a'), createUserMessage({ content: 'second' }), createUserMessage({ content: 'summarise' })]
  const fork2 = addCacheBreakpoints(forkAfterUser as never, true, false, null, [], true)
  check('a parent ending in a user row keeps its marker position', j(markedIndexes(fork2 as never)) === j([2]), j(markedIndexes(fork2 as never)))
  const plain = addCacheBreakpoints(forkMessages.slice(0, 4) as never, true, false, null, [], false)
  check('a plain request still marks its own last row', j(markedIndexes(plain as never)) === j([3]), j(markedIndexes(plain as never)))
  check('exactly one marker per request in every shape', markedIndexes(fork as never).length === 1 && markedIndexes(fork2 as never).length === 1 && markedIndexes(plain as never).length === 1)
}
{
  const at = '2026-09-05T10:00:00.000Z'
  const later = '2026-09-05T10:05:00.000Z'
  const log = [
    createUserMessage({ content: 'first' }),
    { type: 'assistant', uuid: '00000000-0000-4000-a000-000000000901', timestamp: at, message: { id: 'msg_a', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'a' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    createUserMessage({ content: 'second' }),
    { type: 'assistant', uuid: '00000000-0000-4000-a000-000000000902', timestamp: later, message: { id: 'msg_b', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'b' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    createUserMessage({ content: 'third (no reply yet)' }),
  ]
  check('lastAssistantTimestamp reads the newest assistant row past a trailing user row', lastAssistantTimestamp(log as never) === Date.parse(later))
  check('no assistant clock returns null', lastAssistantTimestamp([createUserMessage({ content: 'x' })] as never) === null && lastAssistantTimestamp([{ type: 'assistant', timestamp: 'not a clock' }] as never) === null)
  setLastApiCompletionTimestamp(null)
  await restoreSessionStateFromLog({ messages: log as never }, () => {})
  check('resume seeds an empty clock from the record', getLastApiCompletionTimestamp() === Date.parse(later), j(getLastApiCompletionTimestamp()))
  setLastApiCompletionTimestamp(123)
  await restoreSessionStateFromLog({ messages: log as never }, () => {})
  check('resume never overwrites a running clock', getLastApiCompletionTimestamp() === 123, j(getLastApiCompletionTimestamp()))
  setLastApiCompletionTimestamp(null)
}
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
