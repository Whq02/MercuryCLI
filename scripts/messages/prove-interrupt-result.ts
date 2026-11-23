#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  turnCutWhy,
  unwrapToolUseError,
} from '../../src/engine/message-shapes/rejectionText.ts'
import { createUserInterruptionMessage } from '../../src/engine/message-shapes/factories.ts'
import { buildMessageLookups } from '../../src/engine/messages/lookups.ts'
import { normalizeMessages } from '../../src/engine/message-shapes/normalize.ts'
import { isNotEmptyMessage } from '../../src/engine/message-shapes/text.ts'
import { createAssistantMessage, createUserMessage } from '../../src/engine/messages/messages.ts'
import type { Message } from '../../src/engine/message-shapes/message.ts'

const IDLE = turnCutOf({ code: 'DEADLINE_EXCEEDED' })
const STORED_PARENT_STOP = '[Request cut off: the workflow that ran this crewmate stopped]'

let checks = 0
let failures = 0
const INTERRUPT_FIX_HINT_BY_SECTION: Record<string, string> = {
  A: 'change turnCutResultText for the operator cut in src/engine/message-shapes/turnCut.ts',
  B: 'change turnCutResultText, turnCutLine or turnCutOfText in src/engine/message-shapes/turnCut.ts, or createUserInterruptionMessage in src/engine/message-shapes/factories.ts',
  C: 'change isDenialResultText or unwrapToolUseError in src/engine/message-shapes/rejectionText.ts, turnCutOfText or isTurnCutText in src/engine/message-shapes/turnCut.ts, isNotEmptyMessage in src/engine/message-shapes/text.ts, or buildMessageLookups in src/engine/messages/lookups.ts',
  D: 'change readAgentTranscript in src/crew/crewmates/agentTranscriptReader.ts, or the cut-line functions in src/engine/message-shapes/turnCut.ts',
  E: '',
}
let interruptFixHint = ''
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  const hint = ok ? '' : interruptFixHint
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${[detail, hint].filter(part => part !== '').join(' — ')}`.replace(/ — $/, '')}`)
  if (!ok) failures++
}
function section(title: string): void {
  interruptFixHint = INTERRUPT_FIX_HINT_BY_SECTION[title.charAt(0)] ?? ''
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
  const idle = turnCutResultText(IDLE)
  const parent = turnCutResultText(turnCutOfText(STORED_PARENT_STOP)!)
  const cut = turnCutResultText(turnCutOfText('[Request cut off: the retry budget was spent]')!)
  const bare = turnCutResultText(turnCutOf(new Error('the run was aborted')))
  check('idle-timeout keeps its words', idle === 'Cut off by a no-progress timeout (the provider went quiet)', idle)
  check('parent-stop, read back from a stored row, keeps its words', parent === 'Cut off: the workflow that ran this crewmate stopped', parent)
  check('a typed cut, read back from a stored row, keeps its words', cut === 'Cut off: the retry budget was spent', cut)
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
  check('a cut row still names its reason', turnCutLine(IDLE, true) === '[Request cut off during tool use by a no-progress timeout (the provider went quiet)]')
}

section('C the census: every reader that recognised an interrupt result still does')
{
  check('isDenialResultText: the operator result is a stop, not an ordinary failure', isDenialResultText(result))
  check('isDenialResultText: the named result too', isDenialResultText(named))
  check('isDenialResultText: through the tool_use_error wrapper', isDenialResultText(`<tool_use_error>${result}</tool_use_error>`))
  check("isDenialResultText: the bare 'Interrupted by user' a session on disk may carry", isDenialResultText('Interrupted by user'))
  check('isDenialResultText: the cut result is still a stop', isDenialResultText(turnCutResultText(IDLE)))
  check('isDenialResultText: INTERRUPT_MESSAGE inside a shell error is still a stop', isDenialResultText(`Command failed\n${INTERRUPT_MESSAGE}\n`))
  check('isDenialResultText: the tool-use interruption constant is still a stop', isDenialResultText(INTERRUPT_MESSAGE_FOR_TOOL_USE))
  check('isDenialResultText: CANCEL_MESSAGE and REJECT_MESSAGE are still stops', isDenialResultText(CANCEL_MESSAGE) && isDenialResultText(REJECT_MESSAGE))
  check('isDenialResultText: an ordinary failure is still not a stop', !isDenialResultText('Command failed with exit code 1\nInterrupted by user request handler') && !isDenialResultText('Exit code 1'))
  check('isDenialResultText: a failure that only quotes the interruption inside a line is not a stop', !isDenialResultText(`open '/tmp/notes on ${INTERRUPT_MESSAGE} rows.md': no such file`) && !isDenialResultText(`cat: '${INTERRUPT_MESSAGE_FOR_TOOL_USE}.txt': No such file or directory`))
  check('unwrapToolUseError leaves the result itself alone', unwrapToolUseError(result) === result)

  check('turnCutOfText: the two interruption rows still read as the operator\'s', turnCutOfText(INTERRUPT_MESSAGE)?.kind === 'operator' && turnCutOfText(INTERRUPT_MESSAGE_FOR_TOOL_USE)?.kind === 'operator')
  check('turnCutOfText: the typed rows still read back', turnCutOfText('[Request cut off by a no-progress timeout (the provider went quiet)]')?.kind === 'idle-timeout' && turnCutOfText('[Request cut off: the workflow that ran this crewmate stopped]')?.kind === 'parent-stop')
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

section('D the crewmate transcript reader, and the cut lines a stored transcript may hold')
{
  const { readAgentTranscript } = await import('../../src/crew/crewmates/agentTranscriptReader.ts')
  const { entryToRecord } = await import('../../src/sessions/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/sessions/fabric/ordinal.ts')
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
    row('user', [{ type: 'tool_result', tool_use_id: 'toolu_2', content: turnCutResultText(IDLE), is_error: true }]),
    row('user', [{ type: 'text', text: turnCutLine(IDLE, true) }]),
  ]
  const cutFile = join(dir, 'agent-cut.jsonl')
  writeFileSync(cutFile, cutRows.join('\n') + '\n')
  const cutView = await readAgentTranscript(cutFile)
  check('a cut row still ends the transcript with its own words', cutView?.end.kind === 'cut' && cutView.end.words === 'cut off by a no-progress timeout (the provider went quiet)', JSON.stringify(cutView?.end))
  const STORED: Array<{ wrote: string; line: string; lineToolUse: string; result: string; kind: string; why: string }> = [
    { wrote: 'stalled', line: '[Request cut off by a no-progress timeout (the provider went quiet)]', lineToolUse: '[Request cut off during tool use by a no-progress timeout (the provider went quiet)]', result: 'Cut off by a no-progress timeout (the provider went quiet)', kind: 'idle-timeout', why: 'a no-progress timeout (the provider went quiet)' },
    { wrote: 'workflow-abort', line: '[Request cut off: the workflow that ran this crewmate stopped]', lineToolUse: '[Request cut off during tool use: the workflow that ran this crewmate stopped]', result: 'Cut off: the workflow that ran this crewmate stopped', kind: 'parent-stop', why: 'the workflow that ran this crewmate stopped' },
    { wrote: 'throttled', line: '[Request cut off: the retry budget was spent]', lineToolUse: '[Request cut off during tool use: the retry budget was spent]', result: 'Cut off: the retry budget was spent', kind: 'cut', why: 'the retry budget was spent' },
    { wrote: 'terminal-400', line: '[Request cut off: the provider refused the request outright]', lineToolUse: '[Request cut off during tool use: the provider refused the request outright]', result: 'Cut off: the provider refused the request outright', kind: 'cut', why: 'the provider refused the request outright' },
    { wrote: 'workflow-permission-timeout', line: '[Request cut off: the permission ask timed out]', lineToolUse: '[Request cut off during tool use: the permission ask timed out]', result: 'Cut off: the permission ask timed out', kind: 'cut', why: 'the permission ask timed out' },
  ]
  for (const stored of STORED) {
    seq = 0
    const storedFile = join(dir, `agent-${stored.wrote}.jsonl`)
    writeFileSync(storedFile, [
      row('user', 'run the build'),
      row('assistant', [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'sleep 30' } }]),
      row('user', [{ type: 'tool_result', tool_use_id: 'toolu_3', content: stored.result, is_error: true }]),
      row('user', [{ type: 'text', text: stored.lineToolUse }]),
    ].join('\n') + '\n')
    const storedView = await readAgentTranscript(storedFile)
    const read = turnCutOfText(stored.line)
    const readToolUse = turnCutOfText(stored.lineToolUse)
    check(`a transcript an older build ended on '${stored.wrote}' still ends as cut, in the words it was stored with`, storedView?.end.kind === 'cut' && storedView.end.words === stored.result.replace(/^Cut off/, 'cut off'), JSON.stringify(storedView?.end))
    check(`…its row reads as the same kind and paints the same reason (${stored.why})`, read?.kind === stored.kind && readToolUse?.kind === stored.kind && turnCutWhy(read!) === stored.why, JSON.stringify(read))
    check('…and the stored bytes are what the row and the result write back', turnCutLine(read!, false) === stored.line && turnCutLine(readToolUse!, true) === stored.lineToolUse && turnCutResultText(read!) === stored.result && isTurnCutText(stored.line) && isTurnCutText(stored.lineToolUse) && isDenialResultText(stored.result))
  }
  rmSync(dir, { recursive: true, force: true })
}

section('E the runtime check over every recogniser of the interrupt text')
{
  const t = await import('../core-runtime/turnScenarios.ts')
  const settledTextsOf = (events: Array<{ kind: string; message?: unknown }>): string[] =>
    events.filter(event => event.kind === 'tool_settled').map(event => String((event.message as { message: { content: Array<{ content?: unknown }> } }).message.content[0]?.content))
  const CUTS: unknown[] = [undefined, 'interrupt', { code: 'DEADLINE_EXCEEDED' }, new Error('the run was aborted')]
  const cutMidStream = []
  for (const reason of CUTS) {
    cutMidStream.push(await t.runScripted({ tools: [{ name: 'Bash' }], script: [[...t.fixtures.yields(t.fixtures.calls('toolu_cut', 'Bash', { command: 'sleep 30' })), { kind: 'do', fn: env => env.rig.abortController.abort(reason) }]] }))
  }
  const wrote = cutMidStream.map(run => settledTextsOf(run.events).join(' | '))
  const owed = CUTS.map(reason => turnCutResultText(turnCutOf(reason)))
  check(
    'the turn machine still settles a call cut mid-stream through turnCutResultText(turnCutOf(reason)), in words every recogniser reads as a stop',
    wrote.join(' / ') === owed.join(' / ') && wrote[0] === result && wrote.every(isDenialResultText),
    `modelReply (src/engine/loop/turn/modelReply.ts) must settle a tool call the abort cut with turnCutResultText(turnCutOf(the abort's reason)); for no reason, a steer, a deadline and an Error it wrote ${JSON.stringify(wrote)}, and the owner says ${JSON.stringify(owed)}`,
  )
  const cutMidTool = await t.runScripted({
    tools: [{ name: 'SlowTool', result: 'finished during the abort', onCall: rig => rig.abortController.abort() }],
    script: [t.fixtures.yields(t.fixtures.calls('toolu_running', 'SlowTool', {}))],
  })
  const said: string[] = []
  const gather = (value: unknown, seen: Set<unknown>): void => {
    if (typeof value === 'string') said.push(value)
    else if (typeof value === 'object' && value !== null && !seen.has(value)) {
      seen.add(value)
      for (const inner of Object.values(value)) gather(inner, seen)
    }
  }
  for (const run of [cutMidStream[0]!, cutMidTool]) gather(run.events, new Set())
  const minted = said.filter(text => PARTIAL.test(text))
  check(
    'the facts come from turnCutResultText and nowhere else',
    PARTIAL.test(result) && cutMidTool.terminal.reason === 'aborted_tools' && minted.length > 0 && minted.every(text => text === result),
    `a run the operator cuts, in the stream or in the tools, must say what may have happened only in the owner's result text, word for word: the steps under src/engine/loop/turn/ write no such sentence of their own; of ${said.length} strings in the two runs' events these name the facts and are not the owner's text: ${JSON.stringify(minted.filter(text => text !== result))}${minted.length === 0 ? ' (and none names them at all)' : ''}`,
  )
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
console.log(failures === 0 ? 'INTERRUPT RESULT GREEN' : `${failures} INTERRUPT RESULT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
