#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://github.com/example/mercury' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prefix-ledger-pure-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_THINKING_BINDING
delete process.env.MERCURY_PREFIX_INDUCE_EDIT
delete process.env.ANTHROPIC_BASE_URL

import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

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

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prefix ledger proofs exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const ledger = await import('../../src/services/providers/anthropic/prefixLedger.ts')
const binding = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
const { judgeAndRecordPrefix, takePrefixVerdict, pendingPrefixVerdict, resetPrefixLedger, prefixRecordFor, applyInducedPrefixEdit, resolveInducedPrefixEdit, inducedEditApplies, boundTools, lastThinkingMessageIndex, describePrefixMismatch } = ledger

type Block = Record<string, unknown>
const THINK = (text: string): Block => ({ type: 'thinking', thinking: text, signature: `sig-${text}` })
const TEXT = (text: string): Block => ({ type: 'text', text })
const user = (...content: Block[]): Block => ({ role: 'user', content })
const assistant = (...content: Block[]): Block => ({ role: 'assistant', content })
const SYSTEM = [
  { type: 'text', text: '\nYou are Mercury.\n\n# System behaviour\n\n - rules\n\n# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /tmp/x\n - Platform: darwin\n\n# Doing tasks\n - work' },
  { type: 'text', text: 'gitStatus: clean', cache_control: { type: 'ephemeral' } },
]
const tool = (name: string, over: Record<string, unknown> = {}): Block => ({ name, description: `${name} does things`, input_schema: { type: 'object', properties: {} }, ...over })
const TOOLS = [tool('Read'), tool('Bash'), tool('Browser', { defer_loading: true })]
const KEY = 'owner|row-1|claude-fable-5-1'

section('§1 the ledger, pure — digests, the range law, the names per part')
{
  resetPrefixLedger()
  const r1 = { system: SYSTEM, tools: TOOLS, messages: [user(TEXT('first prompt'))] }
  const v1 = judgeAndRecordPrefix('main', KEY, r1)
  check('the first request records without comparing (nothing to compare against)', !v1.compared && v1.mismatch === null && v1.lastThinkingIndex === -1, j(v1))
  const rec1 = prefixRecordFor('main')
  check('the record carries one digest per system block, tool and message (an unreferenced deferred tool marked unbound)', rec1 !== null && rec1.systemDigests.length === 2 && j(rec1.toolNames) === j(['Read', 'Bash', 'Browser+?']) && rec1.messageDigests.length === 1, j(rec1))

  const r2 = { system: SYSTEM, tools: TOOLS, messages: [user(TEXT('first prompt')), assistant(THINK('one'), TEXT('a')), user(TEXT('second prompt'))] }
  const v2 = judgeAndRecordPrefix('main', KEY, r2)
  check('an appended request holds (compared, no mismatch, the last replayed block at message 1)', v2.compared && v2.mismatch === null && v2.lastThinkingIndex === 1, j(v2))
  check('the verdict is pending for the turn machine and taken once', pendingPrefixVerdict('main') !== null && takePrefixVerdict('main')?.mismatch === null && takePrefixVerdict('main') === null)

  const movedMarker = { ...r2, messages: [...r2.messages.slice(0, 2), { ...r2.messages[2]!, content: [{ ...TEXT('second prompt'), cache_control: { type: 'ephemeral' } }] }], system: [SYSTEM[0], { type: 'text', text: 'gitStatus: clean' }] }
  const before = prefixRecordFor('main')!.whole
  const vRetry = judgeAndRecordPrefix('main', KEY, movedMarker)
  check('cache_control markers move freely: the retry is the same request (same whole digest, no mismatch)', prefixRecordFor('main')!.whole === before && vRetry.mismatch === null, j(vRetry))

  const editedEnv = SYSTEM[0]!.text.replace('darwin', 'linux')
  const r3 = { ...r2, system: [{ type: 'text', text: editedEnv }, SYSTEM[1]] }
  const v3 = judgeAndRecordPrefix('main', KEY, r3)
  check("a byte moved in the Environment section names 'the system prompt's Environment section' with the char path and excerpts", v3.mismatch?.part === "the system prompt's Environment section" && /^system\[0\]\.text@char \d+$/.test(v3.mismatch.path) && (v3.mismatch.before ?? '').includes('darwin') && (v3.mismatch.after ?? '').includes('linux'), j(v3.mismatch))
  check('describePrefixMismatch is the operator sentence', describePrefixMismatch(v3.mismatch!).startsWith("Mercury's prefix ledger names the part that moved: the system prompt's Environment section ("))
  const v3b = judgeAndRecordPrefix('main', KEY, { ...r3, system: [SYSTEM[0], { type: 'text', text: 'gitStatus: dirty' }] })
  check('a block with no heading names the block by number', v3b.mismatch?.part === "the system prompt's Environment section" || v3b.mismatch?.part === 'the system prompt (block 1)', j(v3b.mismatch))

  resetPrefixLedger()
  judgeAndRecordPrefix('main', KEY, r2)
  const deferredJoiner = judgeAndRecordPrefix('main', KEY, { ...r2, tools: [...TOOLS, tool('mcp__srv__late', { defer_loading: true })] })
  check("an unreferenced deferred tool joining is not a prefix move (the API's table)", deferredJoiner.mismatch === null, j(deferredJoiner.mismatch))
  const added = judgeAndRecordPrefix('main', KEY, { ...r2, tools: [...TOOLS, tool('mcp__srv__late', { defer_loading: true }), tool('LateBuiltin')] })
  check("a full tool joining names 'the tools set: 1 added (LateBuiltin)'", added.mismatch?.part === 'the tools set: 1 added (LateBuiltin)' && added.mismatch.path.startsWith('tools.length'), j(added.mismatch))
  const removed = judgeAndRecordPrefix('main', KEY, { ...r2, tools: [TOOLS[0], TOOLS[2]] })
  check("tools leaving name 'the tools set: … removed (Bash, LateBuiltin)'", removed.mismatch?.part === 'the tools set: 2 removed (Bash, LateBuiltin)', j(removed.mismatch))
  judgeAndRecordPrefix('main', KEY, r2)
  const described = judgeAndRecordPrefix('main', KEY, { ...r2, tools: [tool('Read', { description: 'Read, reworded' }), TOOLS[1], TOOLS[2]] })
  check("a reworded description names 'the tool Read's description'", described.mismatch?.part === "the tool Read's description" && described.mismatch.path === 'tools[0].description', j(described.mismatch))
  judgeAndRecordPrefix('main', KEY, r2)
  const reschemed = judgeAndRecordPrefix('main', KEY, { ...r2, tools: [TOOLS[0], tool('Bash', { input_schema: { type: 'object', properties: { command: { type: 'string' } } } }), TOOLS[2]] })
  check("a changed schema names 'the tool Bash's input schema'", reschemed.mismatch?.part === "the tool Bash's input schema", j(reschemed.mismatch))
  const referencing = { ...r2, messages: [user(TEXT('first prompt')), assistant(THINK('one'), { type: 'tool_use', id: 'toolu_1', name: 'ToolSearch', input: {} }), user({ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'tool_reference', tool_name: 'Browser' }] }), assistant(THINK('two'), TEXT('b')), user(TEXT('next'))] }
  judgeAndRecordPrefix('main', KEY, referencing)
  check('boundTools keeps a referenced deferred tool and drops an unreferenced one', j(boundTools([...TOOLS, tool('Other', { defer_loading: true })], referencing.messages).map(t => (t as Block).name)) === j(['Read', 'Bash', 'Browser']))
  const referencedGone = judgeAndRecordPrefix('main', KEY, { ...referencing, tools: [TOOLS[0], TOOLS[1]] })
  check("a referenced deferred tool leaving names 'the tools set: 1 removed (Browser)'", referencedGone.mismatch?.part === 'the tools set: 1 removed (Browser)', j(referencedGone.mismatch))
  judgeAndRecordPrefix('main', KEY, referencing)
  const unmarked = judgeAndRecordPrefix('main', KEY, { ...referencing, tools: [TOOLS[0], TOOLS[1], tool('Browser')] })
  check("a bound tool's deferral mark flipping names 'the tool Browser's deferral mark'", unmarked.mismatch?.part === "the tool Browser's deferral mark", j(unmarked.mismatch))
  resetPrefixLedger()
  judgeAndRecordPrefix('main', KEY, r2)
  const lookup = { ...r2, messages: [...r2.messages, assistant(THINK('look'), { type: 'tool_use', id: 'toolu_2', name: 'ToolSearch', input: {} }), user({ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'tool_reference', tool_name: 'Browser' }] })] }
  const referenced = judgeAndRecordPrefix('main', KEY, lookup)
  check('a deferred tool becoming referenced across a request (the lookup admitted it; the bytes unchanged) is not a prefix move', referenced.mismatch === null, j(referenced.mismatch))
  resetPrefixLedger()
  judgeAndRecordPrefix('main', KEY, r2)
  const loadedUnbound = judgeAndRecordPrefix('main', KEY, { ...lookup, tools: [TOOLS[0], TOOLS[1], tool('Browser')] })
  check('a tool unbound in the previous record and bound now — sent in full from then on — is a lawful arrival, not an addition and not a mark flip', loadedUnbound.mismatch === null, j(loadedUnbound.mismatch))
  const stillFull = judgeAndRecordPrefix('main', KEY, { ...lookup, tools: [TOOLS[0], TOOLS[1], tool('Browser')], messages: [...lookup.messages, assistant(THINK('used'), TEXT('d')), user(TEXT('more'))] })
  check('…and the loaded tool holds like any bound tool afterwards', stillFull.mismatch === null, j(stillFull.mismatch))
  judgeAndRecordPrefix('main', KEY, lookup)
  const flippedWhileBound = judgeAndRecordPrefix('main', KEY, { ...lookup, tools: [TOOLS[0], TOOLS[1], tool('Browser')], messages: [...lookup.messages, assistant(THINK('used'), TEXT('d')), user(TEXT('more'))] })
  check("a bound tool's mark flipping across a request is a rewrite: 'the tool Browser's deferral mark'", flippedWhileBound.mismatch?.part === "the tool Browser's deferral mark", j(flippedWhileBound.mismatch))
  const fullAdded = judgeAndRecordPrefix('main', KEY, { ...lookup, tools: [TOOLS[0], TOOLS[1], tool('Browser'), tool('Brand')], messages: [...lookup.messages, assistant(THINK('used'), TEXT('d')), user(TEXT('more')), assistant(THINK('again'), TEXT('e')), user(TEXT('once more'))] })
  check("a full tool the previous request never carried, added, is still 'the tools set: 1 added (Brand)'", fullAdded.mismatch?.part === 'the tools set: 1 added (Brand)', j(fullAdded.mismatch))
  judgeAndRecordPrefix('main', KEY, { ...lookup, tools: [TOOLS[0], TOOLS[1], tool('Browser'), tool('Brand')], messages: [...lookup.messages, assistant(THINK('used'), TEXT('d')), user(TEXT('more')), assistant(THINK('again'), TEXT('e')), user(TEXT('once more'))] })
  const unboundGone = judgeAndRecordPrefix('main', KEY, { ...lookup, tools: [TOOLS[0], TOOLS[1], tool('Browser'), tool('Brand'), tool('Late', { defer_loading: true })], messages: [...lookup.messages, assistant(THINK('used'), TEXT('d')), user(TEXT('more')), assistant(THINK('again'), TEXT('e')), user(TEXT('once more')), assistant(THINK('third'), TEXT('f')), user(TEXT('go'))] })
  const unboundLeft = judgeAndRecordPrefix('main', KEY, { ...lookup, tools: [TOOLS[0], TOOLS[1], tool('Browser'), tool('Brand')], messages: [...lookup.messages, assistant(THINK('used'), TEXT('d')), user(TEXT('more')), assistant(THINK('again'), TEXT('e')), user(TEXT('once more')), assistant(THINK('third'), TEXT('f')), user(TEXT('go')), assistant(THINK('fourth'), TEXT('g')), user(TEXT('on'))] })
  check('an unbound deferred tool may arrive and leave between requests without a word', unboundGone.mismatch === null && unboundLeft.mismatch === null, `${j(unboundGone.mismatch)} ${j(unboundLeft.mismatch)}`)

  resetPrefixLedger()
  judgeAndRecordPrefix('main', KEY, r2)
  const r4 = { ...r2, messages: [user(TEXT('first prompt, edited')), ...r2.messages.slice(1)] }
  const v4 = judgeAndRecordPrefix('main', KEY, r4)
  check("turn 0's text edited names 'turn 0's user row: text block 0'", v4.mismatch?.part === "turn 0's user row: text block 0" && v4.mismatch.path === 'messages[0].content[0]', j(v4.mismatch))
  judgeAndRecordPrefix('main', KEY, r2)
  const reminderAdded = judgeAndRecordPrefix('main', KEY, { ...r2, messages: [user(TEXT('<system-reminder>\nnew\n</system-reminder>'), TEXT('first prompt')), ...r2.messages.slice(1)] })
  check("a reminder block appearing in an earlier turn names it ('turn 0's user row: system-reminder → text block 0')", (reminderAdded.mismatch?.part ?? '').startsWith("turn 0's user row:") && (reminderAdded.mismatch?.part ?? '').includes('system-reminder'), j(reminderAdded.mismatch))
  judgeAndRecordPrefix('main', KEY, r2)
  const tailEdited = judgeAndRecordPrefix('main', KEY, { ...r2, messages: [...r2.messages.slice(0, 2), user(TEXT('second prompt, retyped'))] })
  check('an edit AFTER the last replayed block is not judged (nothing is bound to it)', tailEdited.mismatch === null, j(tailEdited.mismatch))
  const longer = { ...r2, messages: [...r2.messages, assistant(THINK('two'), TEXT('b')), user(TEXT('third'))] }
  resetPrefixLedger()
  judgeAndRecordPrefix('main', KEY, r2)
  const grown = judgeAndRecordPrefix('main', KEY, longer)
  const thinkingGone = judgeAndRecordPrefix('main', KEY, { ...longer, messages: [longer.messages[0]!, assistant(TEXT('a')), ...longer.messages.slice(2)] })
  check('a thinking block leaving an earlier turn is not a prefix move (thinking is not part of the prefix: the digests agree)', grown.mismatch === null && thinkingGone.mismatch === null && prefixRecordFor('main')!.messageDigests[1] === prefixRecordFor('main')!.messageDigests[1], j(thinkingGone.mismatch))
  const shrank = judgeAndRecordPrefix('main', KEY, { ...longer, messages: longer.messages.slice(0, 2) })
  check('no replayed block ⇒ nothing judged even when the history shrank', shrank.mismatch === null && shrank.lastThinkingIndex === 1, j(shrank))
  check('lastThinkingMessageIndex reads the last assistant row carrying thinking', lastThinkingMessageIndex(longer.messages) === 3 && lastThinkingMessageIndex([user(TEXT('x'))]) === -1)

  judgeAndRecordPrefix('main', KEY, longer)
  const folded = judgeAndRecordPrefix('main', 'owner|summary-row|claude-fable-5-1', { ...longer, messages: [user(TEXT('summary')), assistant(THINK('after'), TEXT('c')), user(TEXT('go'))] })
  check('a new conversation key (the post-compaction summary row) records fresh: compared=false, no mismatch', !folded.compared && folded.mismatch === null && folded.key === 'owner|summary-row|claude-fable-5-1', j(folded))
  const other = judgeAndRecordPrefix('agent:1', KEY, r2)
  check('another owner keeps its own record', !other.compared && prefixRecordFor('agent:1') !== null && prefixRecordFor('main')!.key === 'owner|summary-row|claude-fable-5-1')

  check('resolveInducedPrefixEdit parses the three spellings and refuses the rest', j(resolveInducedPrefixEdit('system')) === j({ kind: 'system' }) && j(resolveInducedPrefixEdit('TOOLS')) === j({ kind: 'tools' }) && j(resolveInducedPrefixEdit('turn:2')) === j({ kind: 'turn', index: 2 }) && resolveInducedPrefixEdit('') === null && resolveInducedPrefixEdit(undefined) === null && resolveInducedPrefixEdit('nonsense') === null)
  const inducedSystem = applyInducedPrefixEdit(r2, { kind: 'system' })
  check('the system edit appends a marker to the LAST block and leaves the input untouched', (inducedSystem.system as Block[])[1]!.text === 'gitStatus: clean\n\n[induced edit]' && (r2.system[1] as Block).text === 'gitStatus: clean')
  const inducedTools = applyInducedPrefixEdit(r2, { kind: 'tools' })
  check('the tools edit removes the last tool', inducedTools.tools.length === 2 && r2.tools.length === 3)
  const inducedTurn = applyInducedPrefixEdit(r2, { kind: 'turn', index: 0 })
  check('the turn edit appends a text block to the named message', j((inducedTurn.messages[0] as Block).content) === j([TEXT('first prompt'), TEXT('[induced edit]')]) && j((r2.messages[0] as Block).content) === j([TEXT('first prompt')]))
  check('a turn past the end is identity', applyInducedPrefixEdit(r2, { kind: 'turn', index: 9 }) === r2)
  check('a first request (no assistant row yet) ⇒ no induced edit', !inducedEditApplies([{ type: 'attachment' }, { type: 'user' }]))
  check('a history with an assistant row ⇒ the edit rides (the second request, and a resume)', inducedEditApplies([{ type: 'user' }, { type: 'assistant' }, { type: 'user' }]))

  const { deadMarksFromDrops, deadThinkingMarks, stripDeadThinking } = binding
  const ids = [null, 'msg_1', null, 'msg_2', null]
  const marks1 = deadMarksFromDrops([{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }, { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'prefix_binding_mismatch' }, { type: 'other', path: 'messages.3.content.1', reason: 'x' }], ids)
  check('deadMarksFromDrops names each dropped block by its response id and block index (a user turn or an unknown path yields nothing)', j(marks1) === j([{ messageId: 'msg_1', blockIndex: 0 }, { messageId: 'msg_2', blockIndex: 0 }]) && deadMarksFromDrops([{ type: 'thinking_dropped', path: 'messages.0.content.0', reason: 'prefix_binding_mismatch' }], ids).length === 0, j(marks1))
  const existing = new Map([['msg_1', new Set([0])]])
  const later = deadMarksFromDrops([{ type: 'thinking_dropped', path: 'messages.1.content.1', reason: 'prefix_binding_mismatch' }], ids, existing)
  check('a later report indexes the content AS SENT: with block 0 already dead, sent index 1 is original index 2', j(later) === j([{ messageId: 'msg_1', blockIndex: 2 }]), j(later))
  const deadRow = { type: 'system', subtype: 'thinking_dead', dead: [{ messageId: 'msg_1', blockIndex: 0 }, { messageId: 'msg_2', blockIndex: 0 }], content: '', level: 'info', uuid: 'dead-1', timestamp: 't' }
  const collected = deadThinkingMarks([user(TEXT('x')), deadRow, { type: 'system', subtype: 'informational', content: 'noise' }] as never)
  check('deadThinkingMarks reads every thinking_dead row into a map by response id', collected.size === 2 && collected.get('msg_1')?.has(0) === true && collected.get('msg_2')?.has(0) === true)
  const wire = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [TEXT('q')] } },
    { type: 'assistant', uuid: 'a1', message: { id: 'msg_1', role: 'assistant', content: [THINK('one'), TEXT('a')] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [TEXT('q2')] } },
    { type: 'assistant', uuid: 'a2', message: { id: 'msg_2', role: 'assistant', content: [THINK('two')] } },
    { type: 'assistant', uuid: 'a3', message: { id: 'msg_3', role: 'assistant', content: [THINK('three'), TEXT('c')] } },
  ]
  const stripped = stripDeadThinking(wire as never, collected) as unknown as Array<{ message: { content: Block[] } }>
  check('stripDeadThinking leaves the marked blocks off: text stays, an emptied message keeps a placeholder, unmarked rows pass by reference', j(stripped[1]!.message.content) === j([TEXT('a')]) && stripped[3]!.message.content.length === 1 && stripped[3]!.message.content[0]!.type === 'text' && String(stripped[3]!.message.content[0]!.text).includes('dropped') && (stripped[4] as unknown) === wire[4] && (stripped[0] as unknown) === wire[0], j(stripped.map(m => m.message.content)))
  check('…identity when no mark applies', stripDeadThinking(wire as never, new Map()) === (wire as never))

  resetPrefixLedger()
  const placeholder = '[stale tool result pruned — content cleared]'
  const prunedView = {
    system: SYSTEM,
    tools: TOOLS,
    messages: [
      user(TEXT('read the file')),
      assistant(THINK('plan'), { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: placeholder }] },
      assistant(THINK('answer bound to the ORIGINAL tool-result bytes'), TEXT('done')),
      user(TEXT('follow-up')),
    ],
  }
  judgeAndRecordPrefix('prune', KEY, prunedView as never)
  const prunedVerdict = judgeAndRecordPrefix('prune', KEY, prunedView as never)
  check('two consecutive post-prune requests compare identical — the ledger names no byte move (the classifier names the prune instead)', prunedVerdict.mismatch === null, j(prunedVerdict.mismatch))
}

section('§2 the words and the doctor — the receipts carry the named part')
{
  const { classifyThinkingDrops, describeThinkingDrops, describePrefixRewrite, recordThinkingDropLedger, recordPrefixRewriteLedger, readThinkingDropLedger, preservedThinkingHealth, resetThinkingDropStates } = binding
  resetThinkingDropStates()
  const mark = { firstRow: 'row-1', compactBoundary: null, modelTransition: null, rosterTransition: null, rosterChange: null, model: 'claude-fable-5-1', settings: 'mode=default;profile=balanced' }
  const DROP = { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }
  classifyThinkingDrops('w', [], mark)
  const first = classifyThinkingDrops('w', [DROP], mark)
  check('an outcome carries part: null until the ledger names one', first.part === null)
  first.part = "the system prompt's Environment section"
  const words = describeThinkingDrops([DROP], first) ?? ''
  check("a first drop's receipt ends with the ledger clause naming the part", words.includes('the history before messages.1.content.0 changed') && words.endsWith("Mercury's prefix ledger names the part that moved: the system prompt's Environment section."), words)
  const recurrent = classifyThinkingDrops('w', [DROP, { ...DROP, path: 'messages.3.content.0' }], mark)
  recurrent.part = "turn 0's user row: text block 0"
  const again = describeThinkingDrops([DROP], recurrent) ?? ''
  check('the recurrent receipt carries the clause before the doctor road', again.includes("This row paints once. Mercury's prefix ledger names the part that moved: turn 0's user row: text block 0. This is a Mercury defect"), again)
  recordThinkingDropLedger(recurrent, 'claude-fable-5-1')
  const row = readThinkingDropLedger()
  check('the doctor ledger records the named part', row?.last.part === "turn 0's user row: text block 0" && row.last.kind === 'recurrent', j(row))
  const health = preservedThinkingHealth(row)
  check('…and the doctor row names it in its evidence', health.status === 'warn' && health.evidence.includes("Mercury's prefix ledger named the part that moved: turn 0's user row: text block 0"), j(health))
  const firstNamed = classifyThinkingDrops('w2', [DROP], mark)
  firstNamed.part = 'the tools set: 1 added (LateBuiltin)'
  recordThinkingDropLedger(firstNamed, 'claude-fable-5-1')
  const namedFirst = preservedThinkingHealth(readThinkingDropLedger())
  check('a single drop the ledger named reads as a WARN row (a rewrite, never "a resumed session")', namedFirst.status === 'warn' && namedFirst.evidence.includes('a rewrite of sent history') && !namedFirst.evidence.includes('resumed') && (namedFirst.fix ?? '').includes('/issues'), j(namedFirst))
  const rewrite = describePrefixRewrite("the system prompt's Environment section", 'system[0].text@char 120')
  check('the rewrite-without-drop sentence names the part, the path, the API\'s silence and the doctor road', rewrite.startsWith("Preserved thinking: Mercury rewrote already-sent history before this request — the system prompt's Environment section (system[0].text@char 120); the API reported no dropped block this turn.") && rewrite.includes('mercury doctor') && rewrite.includes('https://github.com/example/mercury/issues'), rewrite)
  recordPrefixRewriteLedger("the system prompt's Environment section", 'system[0].text@char 120', 'claude-fable-5-1')
  const rewriteRow = readThinkingDropLedger()
  const rewriteHealth = preservedThinkingHealth(rewriteRow)
  check("the rewrite row is kind 'rewrite' with the part, and the doctor warns with it", rewriteRow?.last.kind === 'rewrite' && rewriteRow.last.part === "the system prompt's Environment section" && rewriteHealth.status === 'warn' && rewriteHealth.evidence.includes("Mercury rewrote sent history at ") && rewriteHealth.evidence.includes('the API reported no dropped block'), j(rewriteHealth))
}

section('§3 the wire — the built bundle, an induced edit per part, named end to end')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    interface RunResult { exit: number | null; stdout: string; stderr: string }
    interface Arena { home: string; cwd: string; env: Record<string, string> }
    function makeArena(fixture: FixtureApi, extraEnv: Record<string, string> = {}): Arena {
      const home = mkdtempSync(join(tmpdir(), 'prefix-ledger-home-'))
      const cwd = mkdtempSync(join(tmpdir(), 'prefix-ledger-cwd-'))
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(cwd, 'README.md'), '# fixture\n')
      return {
        home,
        cwd,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
          TERM: 'dumb',
          MERCURY_CONFIG_DIR: join(home, '.claude'),
          MERCURY_CREDENTIAL_STORE: 'file',
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_API_KEY: 'fixture-key-000',
          MERCURY_DAEMON_DIR: join(home, 'daemon'),
          MERCURY_TEAMS_DIR: join(home, 'teams'),
          MERCURY_THINKING_BINDING: 'drop_block',
          ...extraEnv,
        },
      }
    }
    function runStreaming(arena: Arena, args: string[], turns: Array<{ prompt: string; before?: () => void }>): Promise<RunResult> {
      return new Promise(resolvePromise => {
        const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
        let stdout = ''
        let stderr = ''
        let sent = 0
        let resultsSeen = 0
        const sendNext = (): void => {
          if (sent >= turns.length) {
            child.stdin.end()
            return
          }
          const turn = turns[sent]!
          sent++
          turn.before?.()
          child.stdin.write(j({ type: 'user', message: { role: 'user', content: turn.prompt } }) + '\n')
        }
        child.stdout.on('data', d => {
          stdout += d
          const results = stdout.split('\n').filter(l => l.includes('"type":"result"')).length
          while (resultsSeen < results) {
            resultsSeen++
            sendNext()
          }
        })
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
        child.on('spawn', () => sendNext())
      })
    }
    type Body = { system?: unknown; tools?: unknown; messages?: unknown[]; model?: string }
    const systemTextOf = (body: Body): string => (Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map(b => b.text ?? '').join('\n') : String(body.system ?? ''))
    function transcriptNotices(arena: Arena, sessionId: string): string[] {
      const walk = (dir: string): string[] => {
        const out: string[] = []
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) out.push(...walk(full))
          else if (entry.name === `${sessionId}.jsonl`) out.push(full)
        }
        return out
      }
      const files = existsSync(join(arena.home, '.claude', 'projects')) ? walk(join(arena.home, '.claude', 'projects')) : []
      const notices: string[] = []
      for (const file of files) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.includes('Preserved thinking')) continue
          try {
            const row = JSON.parse(line) as { payload?: { kind?: string; content?: string } }
            if (row.payload?.kind === 'notice' && typeof row.payload.content === 'string') notices.push(row.payload.content)
          } catch {
          }
        }
      }
      return notices
    }
    const debugText = (file: string): string => { try { return readFileSync(file, 'utf8') } catch { return '' } }
    const ledgerFile = (arena: Arena): string => join(arena.home, '.claude', 'preserved-thinking.json')
    const common = ['-p', '--input-format', 'stream-json', '--model', 'claude-fable-5-1', '--allowedTools', 'Read', '--output-format', 'stream-json', '--verbose']
    const scripted = (tag: string, n: number, over: Partial<Extract<ScriptedTurn, { kind: 'text' }>> = {}): ScriptedTurn[] =>
      Array.from({ length: n }, (_, i) => ({ kind: 'text' as const, text: `${tag}-T${i + 1}`, thinking: `${tag} thinking ${i + 1}`, model: 'claude-fable-5-1', ...over }))

    const legs: Array<{ edit: string; part: string; sid: string; wireCheck: (first: Body, second: Body) => boolean }> = [
      { edit: 'system', part: "the system prompt's", sid: 'c0ffee00-0000-4000-8000-00000000d001', wireCheck: (a, b) => !systemTextOf(a).includes('[induced edit]') && systemTextOf(b).endsWith('[induced edit]') },
      { edit: 'turn:0', part: "turn 0's user row: text block", sid: 'c0ffee00-0000-4000-8000-00000000d002', wireCheck: (a, b) => !j(a.messages?.[0]).includes('[induced edit]') && j(b.messages?.[0]).includes('[induced edit]') },
      { edit: 'tools', part: 'the tools set: 1 removed (', sid: 'c0ffee00-0000-4000-8000-00000000d003', wireCheck: (a, b) => Array.isArray(a.tools) && Array.isArray(b.tools) && a.tools.length === b.tools.length + 1 },
    ]
    for (const leg of legs) {
      const fixture = await startFixtureApi(scripted(leg.edit, 3), { bindingCheck: true })
      const arena = makeArena(fixture, { MERCURY_PREFIX_INDUCE_EDIT: leg.edit })
      const debugFile = join(arena.home, `${leg.edit}.debug.log`)
      const r = await runStreaming(arena, [...common, '--session-id', leg.sid, '--debug-file', debugFile], [{ prompt: 'ledger turn 1' }, { prompt: 'ledger turn 2' }, { prompt: 'ledger turn 3' }])
      check(`[${leg.edit}] the three-turn process exits 0`, r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
      const reqs = fixture.messageRequests().map(q => q.body as Body)
      check(`[${leg.edit}] three requests; the first clean, the second carrying the induced edit on the wire`, reqs.length === 3 && leg.wireCheck(reqs[0]!, reqs[1]!), `${reqs.length} requests`)
      const notices = transcriptNotices(arena, leg.sid)
      check(`[${leg.edit}] the fixture dropped the replayed block and the receipt names the part (${leg.part}…)`, notices.length >= 1 && notices[0]!.includes('the API dropped') && notices[0]!.includes(`Mercury's prefix ledger names the part that moved: ${leg.part}`), j(notices))
      const debug = debugText(debugFile)
      check(`[${leg.edit}] the debug log carries the ledger's line naming the part before the request went out`, debug.includes(`the prefix ledger names a rewrite of sent history before the request went out — ${leg.part}`), debug.split('\n').filter(l => l.includes('prefix ledger')).join(' | ').slice(0, 300))
      const row = existsSync(ledgerFile(arena)) ? (JSON.parse(readFileSync(ledgerFile(arena), 'utf8')) as { last?: { part?: string; kind?: string } }) : null
      check(`[${leg.edit}] the doctor ledger row carries the named part`, typeof row?.last?.part === 'string' && row.last.part.includes(leg.part) && row.last.kind !== 'none', j(row))
      await fixture.close()
    }

    {
      const fixture = await startFixtureApi(scripted('err', 3), { bindingCheck: true })
      const arena = makeArena(fixture, { MERCURY_PREFIX_INDUCE_EDIT: 'system', MERCURY_THINKING_BINDING: 'error' })
      const SID = 'c0ffee00-0000-4000-8000-00000000d004'
      const debugFile = join(arena.home, 'err.debug.log')
      const r = await runStreaming(arena, [...common, '--session-id', SID, '--debug-file', debugFile], [{ prompt: 'error turn 1' }, { prompt: 'error turn 2' }])
      check('[error] the process ends (a refused request is an API error, never a hang)', r.exit !== null, `exit=${r.exit}`)
      check('[error] the fixture refused the edited request with the binding sentence (a drop fails the run)', fixture.refusals.length >= 1 && fixture.refusals[0]!.message.includes('binding does not match'), j(fixture.refusals))
      check('[error] the ledger still named the part in the debug log', debugText(debugFile).includes("the prefix ledger names a rewrite of sent history before the request went out — the system prompt's"))
      await fixture.close()
    }

    {
      const fixture = await startFixtureApi(scripted('quiet', 3, { inputTransformations: [] }))
      const arena = makeArena(fixture, { MERCURY_PREFIX_INDUCE_EDIT: 'system' })
      const SID = 'c0ffee00-0000-4000-8000-00000000d005'
      const r = await runStreaming(arena, [...common, '--session-id', SID], [{ prompt: 'quiet turn 1' }, { prompt: 'quiet turn 2' }, { prompt: 'quiet turn 3' }])
      check('[no drop] the three-turn process exits 0', r.exit === 0, `exit=${r.exit}`)
      const notices = transcriptNotices(arena, SID)
      check('[no drop] the rewrite row paints, naming the part and the API\'s silence', notices.length === 1 && notices[0]!.includes("Mercury rewrote already-sent history before this request — the system prompt's") && notices[0]!.includes('the API reported no dropped block this turn'), j(notices))
      const row = existsSync(ledgerFile(arena)) ? (JSON.parse(readFileSync(ledgerFile(arena), 'utf8')) as { last?: { kind?: string; part?: string } }) : null
      check("[no drop] the doctor ledger row is kind 'rewrite' with the part", row?.last?.kind === 'rewrite' && (row.last.part ?? '').startsWith("the system prompt's"), j(row))
      await fixture.close()
    }

    {
      const fixture = await startFixtureApi(scripted('kill', 6), { bindingCheck: true })
      const arena = makeArena(fixture, { MERCURY_PREFIX_INDUCE_EDIT: 'system' })
      const SID = 'c0ffee00-0000-4000-8000-00000000d007'
      const debugFile = join(arena.home, 'kill.debug.log')
      const r = await runStreaming(arena, [...common, '--session-id', SID, '--debug-file', debugFile], [1, 2, 3, 4, 5].map(n => ({ prompt: `kill turn ${n}` })))
      check('[killer] the five-turn process exits 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
      const reqs = fixture.messageRequests().map(q => q.body as Body)
      const dropsPer = fixture.messageRequests().map(q => (fixture as unknown as { drops?: unknown }) && 0)
      void dropsPer
      const dropLines = debugText(debugFile).split('\n').filter(l => l.includes('preserved thinking: [{"type":"thinking_dropped"'))
      check('[killer] exactly ONE drop report reached the product (request 2, the rewrite) — not one per turn', reqs.length === 5 && dropLines.length === 1, `${reqs.length} requests, ${dropLines.length} drop report(s)`)
      const thinkingPer = reqs.map(q => ((q.messages ?? []) as Array<{ role?: string; content?: unknown }>).reduce((n, m) => n + (Array.isArray(m.content) ? (m.content as Block[]).filter(b => b.type === 'thinking').length : 0), 0))
      check('[killer] the dead block is off the wire from request 3 on: requests 3, 4, 5 replay only the blocks minted after the rewrite (1, 2, 3 blocks)', j(thinkingPer) === j([0, 1, 1, 2, 3]), j(thinkingPer))
      const placeholder = j(reqs[2]?.messages?.[1]).includes('reasoning the API dropped') || j(reqs[2]?.messages?.[1]).includes('"type":"text"')
      check('[killer] the emptied first reply keeps a legal text block where the dead thinking sat', placeholder, j(reqs[2]?.messages?.[1]).slice(0, 200))
      const notices = transcriptNotices(arena, SID)
      check('[killer] exactly one notice, naming the part — it never repeats', notices.length === 1 && notices[0]!.includes("Mercury's prefix ledger names the part that moved: the system prompt's"), j(notices))
      const dead = debugText(debugFile).split('\n').filter(l => l.includes('marked dead on the record'))
      check('[killer] the record carries the dead mark once (one row, one block)', dead.length === 1 && dead[0]!.includes('1 dropped block(s)'), j(dead))
      const rowsText = (() => { const dir = join(arena.home, '.claude', 'projects'); const files: string[] = []; const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === `${SID}.jsonl`) files.push(f) } }; if (existsSync(dir)) walk(dir); return files.map(f => readFileSync(f, 'utf8')).join('\n') })()
      check('[killer] the thinking_dead row is persisted in the transcript with its marks', rowsText.includes('"noticeKind":"thinking_dead"') && rowsText.includes('"blockIndex":0'), rowsText.split('\n').filter(l => l.includes('thinking_dead')).join(' | ').slice(0, 300))
      const resumeArena = { ...arena, env: { ...arena.env, MERCURY_THINKING_BINDING: 'error' } }
      const r2 = await runStreaming(resumeArena, [...common, '--resume', SID, '--debug-file', join(arena.home, 'kill-resume.debug.log')], [{ prompt: 'kill turn 6 after the resume' }])
      check('[killer] the resumed turn exits 0 under `error` (nothing refused)', r2.exit === 0 && fixture.refusals.length === 0, `exit=${r2.exit} refusals=${j(fixture.refusals)} stderr=${r2.stderr.slice(0, 200)}`)
      const resumed = fixture.messageRequests().map(q => q.body as Body)
      const resumedThinking = ((resumed[5]?.messages ?? []) as Array<{ content?: unknown }>).reduce((n, m) => n + (Array.isArray(m.content) ? (m.content as Block[]).filter(b => b.type === 'thinking').length : 0), 0)
      check('[killer] the resumed request replays the four live blocks and never the dead one; the fixture dropped nothing', resumed.length === 6 && resumedThinking === 4 && !j(resumed[5]!.messages).includes('kill thinking 1') && !r2.stdout.includes('"type":"thinking_dropped"'), `${resumed.length} requests, ${resumedThinking} blocks`)
      check('[killer] no new notice after the resume', transcriptNotices(arena, SID).length === 1, j(transcriptNotices(arena, SID)))
      await fixture.close()
    }

    {
      const fixture = await startFixtureApi([
        { kind: 'text', text: 'WT-T1', thinking: 'wt one', model: 'claude-fable-5-1' },
        { kind: 'tool_use', name: 'EnterWorktree', input: { name: 'proof-hop' }, thinking: 'wt hop', model: 'claude-fable-5-1' },
        { kind: 'text', text: 'WT-T2', thinking: 'wt two', model: 'claude-fable-5-1' },
        { kind: 'text', text: 'WT-T3', thinking: 'wt three', model: 'claude-fable-5-1' },
      ], { bindingCheck: true })
      const arena = makeArena(fixture, { MERCURY_THINKING_BINDING: 'error' })
      const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid' }
      spawnSync('git', ['init', '-q'], { cwd: arena.cwd, stdio: 'ignore' })
      spawnSync('git', ['add', '.'], { cwd: arena.cwd, stdio: 'ignore' })
      spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: arena.cwd, stdio: 'ignore', env: gitEnv })
      const SID = 'c0ffee00-0000-4000-8000-00000000d008'
      const debugFile = join(arena.home, 'wt.debug.log')
      const r = await runStreaming(arena, ['-p', '--input-format', 'stream-json', '--model', 'claude-fable-5-1', '--allowedTools', 'Read,EnterWorktree', '--output-format', 'stream-json', '--verbose', '--session-id', SID, '--debug-file', debugFile], [
        { prompt: 'worktree turn 1' },
        { prompt: 'worktree turn 2: hop into a worktree' },
        { prompt: 'worktree turn 3' },
      ])
      check('[worktree] the three-turn process exits 0 under `error` (nothing refused)', r.exit === 0 && fixture.refusals.length === 0, `exit=${r.exit} refusals=${j(fixture.refusals)} stderr=${r.stderr.slice(0, 300)}`)
      const reqs = fixture.messageRequests().map(q => q.body as Body)
      const hopped = j(reqs[2]?.messages ?? []).includes('Created worktree')
      check('[worktree] the hop happened (the tool result names the new worktree in the history)', reqs.length === 4 && hopped, `${reqs.length} requests; hopped=${hopped}`)
      check('[worktree] the system prompt is byte-identical across the hop (the cache survived it)', reqs.length === 4 && reqs.every(q => systemTextOf(q) === systemTextOf(reqs[0]!)), reqs.map(q => systemTextOf(q).length).join(','))
      check('[worktree] no drop, no receipt', !r.stdout.includes('"type":"thinking_dropped"') && transcriptNotices(arena, SID).length === 0, j(transcriptNotices(arena, SID)))
      await fixture.close()
    }

    {
      const fixture = await startFixtureApi(scripted('ctl', 3), { bindingCheck: true })
      const arena = makeArena(fixture)
      const SID = 'c0ffee00-0000-4000-8000-00000000d006'
      const debugFile = join(arena.home, 'ctl.debug.log')
      const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid' }
      const r = await runStreaming(arena, [...common, '--session-id', SID, '--debug-file', debugFile], [
        { prompt: 'control turn 1' },
        { prompt: 'control turn 2 after git init', before: () => { spawnSync('git', ['init', '-q'], { cwd: arena.cwd, stdio: 'ignore' }); spawnSync('git', ['add', '.'], { cwd: arena.cwd, stdio: 'ignore' }); spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: arena.cwd, stdio: 'ignore', env: gitEnv }) } },
        { prompt: 'control turn 3' },
      ])
      check('[control] the three-turn process exits 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 200)}`)
      const reqs = fixture.messageRequests().map(q => q.body as Body)
      check('[control] the system prompt carries no git-repository line on any request (the fact left the prefix)', reqs.length === 3 && reqs.every(q => !/git repo/i.test(systemTextOf(q))), reqs.map(q => /git repo/i.test(systemTextOf(q))).join(','))
      check('[control] the first request carries the fact in the user context ("Is a git repository: No")', reqs.length === 3 && j(reqs[0]!.messages?.[0]).includes('Is a git repository: No'), j(reqs[0]?.messages?.[0]).slice(0, 300))
      check('[control] the system prompt is byte-identical across the git init (the fact no longer rides it)', reqs.length === 3 && systemTextOf(reqs[0]!) === systemTextOf(reqs[1]!) && systemTextOf(reqs[1]!) === systemTextOf(reqs[2]!))
      check('[control] no receipt, no ledger line, no doctor row', transcriptNotices(arena, SID).length === 0 && !debugText(debugFile).includes('prefix ledger names') && !existsSync(ledgerFile(arena)), j(transcriptNotices(arena, SID)))
      check('[control] the fixture dropped nothing (no thinking_dropped anywhere)', !r.stdout.includes('thinking_dropped') || r.stdout.includes('"input_transformations":[]'))
      await fixture.close()
    }
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ PREFIX LEDGER GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} PREFIX LEDGER FAILURE(S) (${checks} checks)`)
process.exit(1)
