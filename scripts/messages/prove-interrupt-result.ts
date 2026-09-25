#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
  isDenialResultText,
  isTurnCutText,
  turnCutLine,
  turnCutOf,
  turnCutOfText,
  turnCutResultText,
  unwrapToolUseError,
} from '../../src/utils/messages/rejectionText.ts'
import { createUserInterruptionMessage } from '../../src/utils/messages/factories.ts'
import { buildMessageLookups } from '../../src/utils/messages/lookups.ts'
import { normalizeMessages } from '../../src/utils/messages/normalize.ts'
import { isNotEmptyMessage } from '../../src/utils/messages/text.ts'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages.ts'
import type { Message } from '../../src/types/message.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
function section(title: string): void {
  console.log('─'.repeat(76) + '\n' + title)
}

const PARTIAL = /partially executed/
const BACKGROUND = /background task or process .*keeps running/
const ON_PURPOSE = /interrupted by the operator on purpose|operator stopped .* on purpose/
const operator = turnCutOf(undefined)
const result = turnCutResultText(operator)
const named = turnCutResultText(operator, 'Bash')

section('A the operator result names what may have happened')
{
  check("it still opens with today's words", result.startsWith('Interrupted by user'), JSON.stringify(result))
  check('it says the stop was the operator\'s, on purpose', ON_PURPOSE.test(result), JSON.stringify(result))
  check('it says an aborted command may have partially executed', PARTIAL.test(result), JSON.stringify(result))
  check('it says a background task or process the call launched keeps running', BACKGROUND.test(result), JSON.stringify(result))
  check('it asks for a check before re-running', /check before re-running/.test(result), JSON.stringify(result))
  check('it is short: the lead sentence and at most two more', (result.match(/\.(\s|$)/g) ?? []).length <= 3 && result.length < 320, `${result.length} chars`)
  check('the lead sentence stands on its own first line, the facts below it', result.split('\n').length === 2 && /on purpose\.$/.test(result.split('\n')[0] ?? '') && PARTIAL.test(result.split('\n')[1] ?? ''), JSON.stringify(result))
  check('the same text for every operator door', ['interrupt', 'crew-stop', 'user-skip', 'user-retry', 'user-kill', null, { name: 'AbortError' }].every(r => turnCutResultText(turnCutOf(r)) === result))
  check('a named call names its tool', /this Bash call/.test(named) && PARTIAL.test(named) && BACKGROUND.test(named), JSON.stringify(named))
  check('an empty name reads as a tool call', turnCutResultText(operator, '') === result)
}

section('B every other kind keeps its own words; a non-tool interrupt keeps INTERRUPT_MESSAGE')
{
  const idle = turnCutResultText(turnCutOf('stalled'))
  const parent = turnCutResultText(turnCutOf('workflow-abort'))
  const cut = turnCutResultText(turnCutOf('throttled'))
  const bare = turnCutResultText(turnCutOf(new Error('the run was aborted')))
  check('idle-timeout keeps its words', idle === 'Cut off by a no-progress timeout (the provider went quiet)', idle)
  check('parent-stop keeps its words', parent === 'Cut off: the workflow that ran this agent stopped', parent)
  check('a typed cut keeps its words', cut === 'Cut off: the retry budget was spent', cut)
  check('an Error reason keeps its words', bare === 'Cut off: the run was aborted', bare)
  check('no other kind gains the two facts', [idle, parent, cut, bare].every(t => !PARTIAL.test(t) && !BACKGROUND.test(t)))
  check('the operator row without a tool is INTERRUPT_MESSAGE, unchanged', turnCutLine(operator, false) === INTERRUPT_MESSAGE && INTERRUPT_MESSAGE === '[Request interrupted by user]')
  check('the operator row during tool use is INTERRUPT_MESSAGE_FOR_TOOL_USE, unchanged', turnCutLine(operator, true) === INTERRUPT_MESSAGE_FOR_TOOL_USE && INTERRUPT_MESSAGE_FOR_TOOL_USE === '[Request interrupted by user for tool use]')
  const rowText = (m: Message): string => {
    const c = (m as { message: { content: unknown } }).message.content
    return Array.isArray(c) ? String((c[0] as { text?: unknown })?.text ?? '') : String(c)
  }
  check('createUserInterruptionMessage({}) is the bare INTERRUPT_MESSAGE row', rowText(createUserInterruptionMessage({})) === INTERRUPT_MESSAGE)
  check('createUserInterruptionMessage({ toolUse: true }) is the tool-use row', rowText(createUserInterruptionMessage({ toolUse: true })) === INTERRUPT_MESSAGE_FOR_TOOL_USE)
  check('a typed cut row still names its reason', turnCutLine(turnCutOf('stalled'), true) === '[Request cut off during tool use by a no-progress timeout (the provider went quiet)]')
}

section('C the census: every reader that recognised an interrupt result still does')
{
  check('isDenialResultText: the operator result is a stop, not an ordinary failure', isDenialResultText(result))
  check('isDenialResultText: the named result too', isDenialResultText(named))
  check('isDenialResultText: through the tool_use_error wrapper', isDenialResultText(`<tool_use_error>${result}</tool_use_error>`))
  check("isDenialResultText: the bare 'Interrupted by user' a session on disk may carry", isDenialResultText('Interrupted by user'))
  check('isDenialResultText: the typed cut result is still a stop', isDenialResultText(turnCutResultText(turnCutOf('stalled'))))
  check('isDenialResultText: INTERRUPT_MESSAGE inside a shell error is still a stop', isDenialResultText(`Command failed\n${INTERRUPT_MESSAGE}\n`))
  check('isDenialResultText: the tool-use interruption constant is still a stop', isDenialResultText(INTERRUPT_MESSAGE_FOR_TOOL_USE))
  check('isDenialResultText: CANCEL_MESSAGE and REJECT_MESSAGE are still stops', isDenialResultText(CANCEL_MESSAGE) && isDenialResultText(REJECT_MESSAGE))
  check('isDenialResultText: an ordinary failure is still not a stop', !isDenialResultText('Command failed with exit code 1\nInterrupted by user request handler') && !isDenialResultText('Exit code 1'))
  check('unwrapToolUseError leaves the result itself alone', unwrapToolUseError(result) === result)

  check('turnCutOfText: the two interruption rows still read as the operator\'s', turnCutOfText(INTERRUPT_MESSAGE)?.kind === 'operator' && turnCutOfText(INTERRUPT_MESSAGE_FOR_TOOL_USE)?.kind === 'operator')
  check('turnCutOfText: the typed rows still read back', turnCutOfText('[Request cut off by a no-progress timeout (the provider went quiet)]')?.kind === 'idle-timeout' && turnCutOfText('[Request cut off: the workflow that ran this agent stopped]')?.kind === 'parent-stop')
  check('turnCutOfText: a tool result is never a cut row', turnCutOfText(result) === null && turnCutOfText(named) === null && !isTurnCutText(result))
  check('isTurnCutText: the rows are still markers', isTurnCutText(INTERRUPT_MESSAGE) && isTurnCutText(INTERRUPT_MESSAGE_FOR_TOOL_USE) && !isTurnCutText('plain words'))
  check('isNotEmptyMessage: the tool-use interruption row still counts as empty', !isNotEmptyMessage(createUserMessage({ content: [{ type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE }] as never })))

  const asst = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_cut', name: 'Bash', input: { command: 'sleep 30' } }] as never })
  const settled = createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: 'toolu_cut', content: result, is_error: true }] as never,
    toolUseResult: result,
    sourceToolAssistantUUID: asst.uuid as never,
  })
  const plainAsst = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_err', name: 'Bash', input: { command: 'false' } }] as never })
  const plainErr = createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: 'toolu_err', content: 'Exit code 1', is_error: true }] as never,
    toolUseResult: 'Exit code 1',
    sourceToolAssistantUUID: plainAsst.uuid as never,
  })
  const raw = [asst, settled, plainAsst, plainErr] as Message[]
  const lookups = buildMessageLookups(normalizeMessages(raw) as never, raw)
  check('buildMessageLookups: the settled call is resolved and errored', lookups.resolvedToolUseIDs.has('toolu_cut') && lookups.erroredToolUseIDs.has('toolu_cut'))
  check('buildMessageLookups: the settled call wears the stop glyph set, not the warn lead', lookups.deniedToolUseIDs.has('toolu_cut'), [...lookups.deniedToolUseIDs].join(','))
  check('buildMessageLookups: an ordinary failure stays out of the stop set', lookups.erroredToolUseIDs.has('toolu_err') && !lookups.deniedToolUseIDs.has('toolu_err'))
}

section('D the workflow transcript reader')
{
  const { readAgentTranscript } = await import('../../src/tools/WorkflowTool/agentTranscriptReader.ts')
  const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
  const dir = mkdtempSync(join(tmpdir(), 'interrupt-result-'))
  let seq = 0
  const writer = { sessionId: 'interrupt-result-proof' as never, nextOrdinal: () => ordinalOf(++seq), observedAt: '2026-01-01T00:00:00.000Z', source: { channel: 'sdk' } as const }
  const row = (type: 'user' | 'assistant', content: unknown): string =>
    JSON.stringify(entryToRecord({ type, uuid: `00000000-0000-4000-8000-${String(seq + 1).padStart(12, '0')}`, timestamp: new Date(1_700_000_000_000 + (seq + 1) * 1000).toISOString(), message: { role: type, content } } as never, writer as never))
  const rows = [
    row('user', 'run the build'),
    row('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 30' } }]),
    row('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: result, is_error: true }]),
    row('user', [{ type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE }]),
  ]
  const file = join(dir, 'agent.jsonl')
  writeFileSync(file, rows.join('\n') + '\n')
  const view = await readAgentTranscript(file)
  check('the interruption row still ends the transcript as stopped', view?.end.kind === 'stopped' && view.end.words === 'stopped', JSON.stringify(view?.end))
  const call = view?.toolCalls.find(c => c.name === 'Bash')
  check('the settled call is an error whose preview carries the facts', call?.isError === true && PARTIAL.test(call.resultPreview ?? ''), JSON.stringify(call))
  seq = 0
  const cutRows = [
    row('user', 'run the build'),
    row('assistant', [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'sleep 30' } }]),
    row('user', [{ type: 'tool_result', tool_use_id: 'toolu_2', content: turnCutResultText(turnCutOf('stalled')), is_error: true }]),
    row('user', [{ type: 'text', text: turnCutLine(turnCutOf('stalled'), true) }]),
  ]
  const cutFile = join(dir, 'agent-cut.jsonl')
  writeFileSync(cutFile, cutRows.join('\n') + '\n')
  const cutView = await readAgentTranscript(cutFile)
  check('a typed cut row still ends the transcript with its own words', cutView?.end.kind === 'cut' && cutView.end.words === 'cut off by a no-progress timeout (the provider went quiet)', JSON.stringify(cutView?.end))
  rmSync(dir, { recursive: true, force: true })
}

section('E the source census over every recogniser of the interrupt text')
{
  const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const locks: Array<[string, string]> = [
    ['src/components/messages/UserToolResultMessage/UserToolErrorMessage.tsx', 'param.content.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)'],
    ['src/components/messages/UserToolResultMessage/UserToolResultMessage.tsx', 'param.content === INTERRUPT_MESSAGE_FOR_TOOL_USE'],
    ['src/components/messages/AssistantTextMessage.tsx', 'text === INTERRUPT_MESSAGE || text === INTERRUPT_MESSAGE_FOR_TOOL_USE'],
    ['src/components/messages/UserTextMessage.tsx', 'turnCutOfText(param.text)'],
    ['src/components/messageActions.tsx', 'isTurnCutText(first.text)'],
    ['src/components/FallbackToolUseErrorMessage.tsx', 'isDenialResultText(rawText)'],
    ['src/utils/messages/text.ts', 'text !== INTERRUPT_MESSAGE_FOR_TOOL_USE'],
    ['src/utils/messages/lookups.ts', 'isDenialResultText(toolResultText(content.content))'],
    ['src/utils/messages/rejectionText.ts', 'text.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)'],
    ['src/utils/messages/rejectionText.ts', 'isInterruptedResultText(text)'],
    ['src/utils/transcriptSearch.ts', 'return isTurnCutText(text)'],
    ['src/tools/WorkflowTool/agentTranscriptReader.ts', 'turnCutOfText(text)'],
    ['src/tools/SkillTool/SkillTool.ts', 'texts.includes(INTERRUPT_MESSAGE)'],
    ['src/run-core/turn-machine.ts', 'turnCutResultText(turnCutOf(cutReason))'],
  ]
  for (const [rel, needle] of locks) {
    check(`${rel} still recognises through ${needle}`, src(rel).includes(needle))
  }
  const turnCut = src('src/utils/messages/turnCut.ts')
  check('the facts are minted in turnCut.ts and nowhere else', /partially executed/.test(turnCut) && !/partially executed/.test(src('src/run-core/turn-machine.ts')))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
console.log(failures === 0 ? 'INTERRUPT RESULT GREEN' : `${failures} INTERRUPT RESULT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
