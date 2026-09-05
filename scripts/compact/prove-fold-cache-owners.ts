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
const { foldEffortFor, foldEffortMessageFor, MECHANICAL_FOLD_EFFORT } = await import('../../src/services/compact/compact.ts')
const { servesPerMessageEffort } = await import('../../src/utils/model/capabilities.ts')
const { perMessageEffortRow, insertBeforeLastUserRow } = await import('../../src/services/providers/anthropic/streamCore.ts')
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
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

section("§1 the effort word: the session's on the home wire, the mechanical pin elsewhere")
{
  check("an Anthropic id folds at the session's own effort word", foldEffortFor('claude-opus-4-8', 'xhigh') === 'xhigh' && foldEffortFor('claude-fable-5-1', 'max') === 'max')
  check("an Anthropic id with no session word folds with none (the model's default — never a pin)", foldEffortFor('claude-opus-4-8', undefined) === undefined)
  check(`an OpenAI id folds at the mechanical '${MECHANICAL_FOLD_EFFORT}' (its cache is effort-neutral)`, foldEffortFor('gpt-5.5', 'xhigh') === MECHANICAL_FOLD_EFFORT)
  check(`a Z.AI id folds at the mechanical '${MECHANICAL_FOLD_EFFORT}'`, foldEffortFor('glm-5.2', 'high') === MECHANICAL_FOLD_EFFORT)
  check(`an unrecognised stranger folds at the mechanical '${MECHANICAL_FOLD_EFFORT}' (no wire law of its own)`, foldEffortFor('totally-unknown-model-id', 'high') === MECHANICAL_FOLD_EFFORT)
  check('the per-message effort row is served on Claude Fable 5.1 and Claude Mythos 5.1 only — never Opus 5 (the wire taught: the row costs it the cache)', servesPerMessageEffort('claude-fable-5-1') && servesPerMessageEffort('claude-mythos-5-1') && !servesPerMessageEffort('claude-opus-5') && !servesPerMessageEffort('claude-opus-4-8') && !servesPerMessageEffort('claude-fable-5') && !servesPerMessageEffort('gpt-5.5') && !servesPerMessageEffort('openrouter/anthropic/claude-opus-5'))
  check(`the fold's per-message word is the mechanical '${MECHANICAL_FOLD_EFFORT}' where served, nothing elsewhere`, foldEffortMessageFor('claude-fable-5-1') === MECHANICAL_FOLD_EFFORT && foldEffortMessageFor('claude-opus-5') === undefined && foldEffortMessageFor('claude-opus-4-8') === undefined && foldEffortMessageFor('gpt-5.5') === undefined)
  const { notePerMessageEffortRefused, refusesPerMessageEffortRow, resetPerMessageEffortRefusals } = await import('../../src/utils/model/capabilities.ts')
  check('a 400 naming the beta or output_config reads as the row\'s refusal; a plain 400 does not', refusesPerMessageEffortRow('unexpected value(s) `mid-conversation-output-config-2026-07-01` for the `anthropic-beta` header') && refusesPerMessageEffortRow('output_config: Extra inputs are not permitted') && !refusesPerMessageEffortRow('prompt is too long'))
  notePerMessageEffortRefused('claude-fable-5-1')
  check('a refused model serves no row and folds with no per-message word until the process forgets', !servesPerMessageEffort('claude-fable-5-1') && foldEffortMessageFor('claude-fable-5-1') === undefined)
  resetPerMessageEffortRefusals()
  check('the seam forgets (Fable and its Mythos mirror serve again)', servesPerMessageEffort('claude-fable-5-1') && servesPerMessageEffort('claude-mythos-5-1'))
  const row = perMessageEffortRow('claude-fable-5-1', 'low')
  check("the row is a system row with no content and the effort in output_config", j(row) === j({ role: 'system', content: [], output_config: { effort: 'low' } }), j(row))
  check('no row where the wire does not serve it, or for a numeric word', perMessageEffortRow('claude-opus-4-8', 'low') === null && perMessageEffortRow('claude-fable-5-1', 42) === null && perMessageEffortRow('claude-fable-5-1', undefined) === null)
  const placed = insertBeforeLastUserRow([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }], { role: 'system' })
  check('the row sits before the LAST user row — the turn the effort holds from', j(placed.map(r => r.role)) === j(['user', 'assistant', 'system', 'user']), j(placed))
  check('with no user row the row lands at the end', j(insertBeforeLastUserRow([{ role: 'assistant' }], { role: 'system' }).map(r => r.role)) === j(['assistant', 'system']))
}

section("§2 the fork's marker sits on the parent's last user row")
{
  let seq = 0
  const uuid = (): string => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`
  const assistant = (text: string): unknown => ({
    type: 'assistant',
    uuid: uuid(),
    timestamp: new Date().toISOString(),
    message: { id: `msg_${seq}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  })
  const toolResult = (): unknown => createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] })
  const markedIndexes = (params: unknown[]): number[] =>
    params.flatMap((p, i) => {
      const content = (p as { content: unknown }).content
      const marked = Array.isArray(content) && content.some(b => (b as { cache_control?: unknown }).cache_control !== undefined)
      return marked ? [i] : []
    })
  const forkMessages = [createUserMessage({ content: 'first' }), assistant('a'), toolResult(), assistant('b'), createUserMessage({ content: 'summarise' })]
  const fork = addCacheBreakpoints(forkMessages as never, true, 'compact' as never, false, null, [], true)
  check('a fork over [user, assistant, user(tool_result), assistant] + prompt marks the tool_result row (index 2), never the assistant at length minus two', j(markedIndexes(fork as never)) === j([2]), j(markedIndexes(fork as never)))
  const forkAfterUser = [createUserMessage({ content: 'first' }), assistant('a'), createUserMessage({ content: 'second' }), createUserMessage({ content: 'summarise' })]
  const fork2 = addCacheBreakpoints(forkAfterUser as never, true, 'compact' as never, false, null, [], true)
  check("a parent ending in a user row: the fork marks that row (the parent's own marker position)", j(markedIndexes(fork2 as never)) === j([2]), j(markedIndexes(fork2 as never)))
  const plain = addCacheBreakpoints(forkMessages.slice(0, 4) as never, true, 'repl_main_thread' as never, false, null, [], false)
  check("a plain request marks its last row (the parent's own law is untouched)", j(markedIndexes(plain as never)) === j([3]), j(markedIndexes(plain as never)))
  check('exactly one marker per request in every shape', markedIndexes(fork as never).length === 1 && markedIndexes(fork2 as never).length === 1 && markedIndexes(plain as never).length === 1)
}

section('§3 the cache clock is seeded from the session record on a resume')
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
  check('lastAssistantTimestamp reads the NEWEST assistant row, past a trailing user row', lastAssistantTimestamp(log as never) === Date.parse(later))
  check('…and null when no assistant row carries a clock', lastAssistantTimestamp([createUserMessage({ content: 'x' })] as never) === null && lastAssistantTimestamp([{ type: 'assistant', timestamp: 'not a clock' }] as never) === null)
  setLastApiCompletionTimestamp(null)
  restoreSessionStateFromLog({ messages: log as never }, () => {})
  check("a resume with an empty clock seeds it from the record's last assistant row", getLastApiCompletionTimestamp() === Date.parse(later), j(getLastApiCompletionTimestamp()))
  setLastApiCompletionTimestamp(123)
  restoreSessionStateFromLog({ messages: log as never }, () => {})
  check('a clock already running is never overwritten by a resume (the live completion wins)', getLastApiCompletionTimestamp() === 123, j(getLastApiCompletionTimestamp()))
  setLastApiCompletionTimestamp(null)
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
