#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${cond ? '' : ' — change prefixMarkOf, classifyThinkingDrops or describeThinkingDrops in src/models/roads/anthropic/thinkingBinding.ts (the section 1 rows: src/engine/loop/turn/streamModel.ts)'}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


const binding = await import('../../src/models/roads/anthropic/thinkingBinding.ts')
const { classifyThinkingDrops, describeThinkingDrops, prefixMarkOf, resetThinkingDropStates } = binding

type Drop = { type: string; path: string; reason: string }
const DROP: Drop = { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }

console.log('============================================================')
console.log(' the post-idle thinking drop — no independent idle arming; the drop reads as an ordinary preserved-thinking notice')
console.log('============================================================')

section('§1 the writer: no site arms a thinking-clear latch after the idle threshold, and the mark writer passes no such flag')
{

  const t = await import('./turnScenarios.ts')
  const { makeRequest } = await import('../../src/engine/loop/turn/makeRequest.ts')
  const { modelReply } = await import('../../src/engine/loop/turn/modelReply.ts')
  const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
  const f = t.fixtures
  type Row = Record<string, unknown>
  const HOURS_AGO = new Date(Date.now() - 3 * 3_600_000).toISOString()
  const oldThought = (): Row => {
    const reply = f.says('an old answer') as unknown as Row
    Object.assign(reply.message as Row, { model: t.MODEL, content: [{ type: 'thinking', thinking: 'an old thought', signature: 'rig-signature' }, { type: 'text', text: 'an old answer' }] })
    reply.timestamp = HOURS_AGO
    return reply
  }
  const replyWithADrop = (): unknown => {
    const reply = f.says('the answer, with one old thought left out.')
    ;(reply.message as unknown as Row).input_transformations = [DROP]
    return reply
  }
  const noteOf = (events: Array<Row & { kind: string }>): { level?: unknown; content: string } | undefined => {
    const note = events.filter(event => event.kind === 'notice').map(event => event.message as Row).find(message => message.subtype === 'thinking_note')
    return note === undefined ? undefined : { level: note.level, content: String(note.content) }
  }

  resetThinkingDropStates()
  const afterIdle = await t.plantReply({ seed: [f.ask('an old question'), oldThought(), f.ask('hello there rig')], script: [f.yields(replyWithADrop())] })
  afterIdle.close()
  const idleNote = noteOf(afterIdle.events)

  const FILE_BODY = 'a line of the file that was read over and over\n'.repeat(350)
  const readTwelveTimes = (): unknown[] => [
    f.ask('read the notes again and again'),
    ...Array.from({ length: 12 }, (_, i) => [f.calls(`read_${i + 1}`, 'Read', { file_path: '/rig/notes.txt' }), createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `read_${i + 1}`, content: FILE_BODY }] as never })]).flat(),
    oldThought(),
    f.ask('hello there rig'),
  ]
  const onThePruneRung = async (prunes: boolean): Promise<{ level?: unknown; content: string } | undefined> => {
    resetThinkingDropStates()
    const planted = await t.plantRun({ tools: [{ name: 'Read' }], seed: readTwelveTimes(), script: [f.yields(replyWithADrop())] })
    Object.assign(planted.state, { pendingOverflow: { signal: { source: 'estimate', family: 'anthropic', shape: 'prompt-too-long', actualTokens: 60_000, limitTokens: 100 }, rung: 'prune' }, overflowEpisode: { pruned: true, folded: true } })
    if (prunes) planted.run.deps = { ...(planted.run.deps as Row), prune: undefined }
    const request = await t.drain(makeRequest(planted.run as never, planted.state as never, 1))
    const reply = request.decision.kind === 'go_on' ? await t.drain(modelReply(planted.run as never, request.decision.iter as never)) : { events: [] }
    planted.close()
    return noteOf([...request.events, ...reply.events])
  }
  const pruned = await onThePruneRung(true)
  const unpruned = await onThePruneRung(false)
  resetThinkingDropStates()

  check(
    'a drop the API reports after an idle gap is written by the turn machine at WARNING level and names no idle clear (the mark writer arms no thinking-clear flag)',
    idleNote?.level === 'warning' && !idleNote.content.includes('after an hour idle') && !idleNote.content.includes('cleared reasoning'),
    `the note of a reply that dropped a thought written three hours earlier: ${JSON.stringify(idleNote)} — the model call of src/engine/loop/turn/streamModel.ts classifies the drop against a mark that says no thinking was cleared, so it reads as a first unlawful drop`,
  )
  check(
    "…and the mark reads this request's own plan: on a request whose plan pruned superseded results the same drop is the INFO note that names Mercury's prune, and the WARNING where nothing was pruned",
    pruned?.level === 'info' && pruned.content.includes('pruned superseded tool results') && unpruned?.level === 'warning',
    `on the prune rung with two results cleared: ${JSON.stringify(pruned)}; on the same rung with nothing cleared: ${JSON.stringify(unpruned)} — the mark's context in src/engine/loop/turn/streamModel.ts is the request plan of this very request and nothing else`,
  )
}

section('§2 the mark the product builds carries thinkingClearActive=false; the classifier vocabulary is retained (settable by hand, never by the product)')
{
  const rows = [
    { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a-1', message: { id: 'm1', role: 'assistant', content: [], model: 'claude-fable-5-1' } },
  ]
  const productMark = prefixMarkOf(rows as never, 'claude-fable-5-1', { permissionMode: 'default' }, { requestPlan: undefined })
  check('the product mark reads thinkingClearActive === false (nothing arms it)', productMark.thinkingClearActive === false, JSON.stringify(productMark.thinkingClearActive))
  const armedMark = prefixMarkOf(rows as never, 'claude-fable-5-1', { permissionMode: 'default' }, { thinkingClearActive: true })
  check('the mark still accepts an explicit thinkingClearActive (the retained classifier vocabulary)', armedMark.thinkingClearActive === true, JSON.stringify(armedMark.thinkingClearActive))
}

section('§3 the consequence: a post-idle drop now classifies first / warning, where the old idle-armed latch made it lawful / info')
{
  const baseMark = {
    firstRow: 'u-1',
    compactBoundary: null,
    modelTransition: null,
    rosterTransition: null,
    rosterChange: null,
    model: 'claude-fable-5-1',
    settings: 'mode=default',
    contextEditActive: false,
  }
  resetThinkingDropStates()
  const nowOutcome = classifyThinkingDrops('idle-now', [DROP], { ...baseMark, thinkingClearActive: false } as never)
  const nowNote = describeThinkingDrops([DROP], nowOutcome)
  const nowSeverity = nowOutcome.kind === 'lawful' ? 'info' : 'warning'
  check('a post-idle drop is a FIRST unlawful drop today (kind first, lawful null)', nowOutcome.kind === 'first' && nowOutcome.lawful === null, JSON.stringify({ kind: nowOutcome.kind, lawful: nowOutcome.lawful }))
  check('…the receipt the turn machine writes for it is WARNING level', nowSeverity === 'warning', nowSeverity)
  check('…and its notice is never attributed to an idle clear', typeof nowNote === 'string' && !nowNote.includes('after an hour idle') && !nowNote.includes('cleared reasoning'), String(nowNote))

  resetThinkingDropStates()
  const thenOutcome = classifyThinkingDrops('idle-then', [DROP], { ...baseMark, thinkingClearActive: true } as never)
  const thenNote = describeThinkingDrops([DROP], thenOutcome)
  const thenSeverity = thenOutcome.kind === 'lawful' ? 'info' : 'warning'
  check('with the latch armed the SAME drop was a lawful thinking-cleared self-edit', thenOutcome.kind === 'lawful' && thenOutcome.lawful === 'thinking-cleared', JSON.stringify({ kind: thenOutcome.kind, lawful: thenOutcome.lawful }))
  check('…the receipt was INFO level', thenSeverity === 'info', thenSeverity)
  check('…and its notice named the idle clear', typeof thenNote === 'string' && thenNote.includes('after an hour idle'), String(thenNote))

  check('the transition is real: the two classifications and severities differ', nowOutcome.lawful !== thenOutcome.lawful && nowSeverity !== thenSeverity)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} idle-drop-receipt check(s) failed`)
  process.exit(1)
}
console.log(' ALL IDLE-DROP-RECEIPT PROOFS PASS')
