#!/usr/bin/env bun
// gate-watch: src/screen/cockpit/crewmateWords.ts src/screen/concourse/controlManifest.ts src/screen/concourse/ConcourseRoute.tsx
// gate-watch: src/engine/tasks/taskOutcomeEnvelope.ts src/engine/tasks/local-shell/killShellTasks.ts src/engine/tasks/local-shell/shellTask.tsx
// gate-watch: src/daemon/runner/sdkEventQueue.ts src/daemon/switchboard/spawnSwitches.ts src/screen/messages/AssistantTextMessage.tsx
// gate-watch: src/screen/fullscreen-layout/HelmLanesRail.tsx src/screen/concourse/ConcourseStrips.tsx
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'helper-rows-words-')))
process.env['MERCURY_CONFIG_DIR'] = join(scratch, 'home')
process.env['MERCURY_CREDENTIAL_STORE'] = 'file'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('— CRW-08 the crewmate card names where its stop and pause keys fire —')
{
  const words = await import('../../src/screen/cockpit/crewmateWords.ts')
  const live = words.crewmateCardKeys(false)
  const pinned = words.crewmateCardKeys(true)
  check('the card no longer promises a bare x stop · p pause (those keys type into its composer)', !/· x stop · p pause(?! in)/.test(live) && !/· x stop · p pause(?! in)/.test(pinned), `${live} | ${pinned} — crewmateCardKeys in src/screen/cockpit/crewmateWords.ts must not print a bare x stop · p pause`)
  check('it names the board where m, x x and p fire — m included, so the card never reads as a bare m while the composer has focus (F34A-20)', live.includes(`in ${words.CREW_VIEW_DOOR}: ${words.CREW_MAIN_CHAT_KEY} · x x stop · p pause`) && pinned.includes(`x x stop · p pause in ${words.CREW_VIEW_DOOR}`) && !/· m main chat ·/.test(live) && !/· m main chat ·/.test(words.crewmateCardKeys(false, false)), live + ' — crewmateCardKeys in src/screen/cockpit/crewmateWords.ts must name the board door before m, x x stop and p pause')
  check('esc interrupts and the way back stand as before', live.startsWith('esc interrupts') && live.endsWith(words.BACK_HINT) && pinned.startsWith('esc interrupts'), live + ' — crewmateCardKeys in src/screen/cockpit/crewmateWords.ts must start with esc interrupts and end with BACK_HINT')
  check('a landed crewmate’s card keeps its own keys (esc back, the clear key placed on the board)', words.crewmateCardKeys(false, false).includes(`in ${words.CREW_VIEW_DOOR}: ${words.CREW_MAIN_CHAT_KEY} · ${words.CREW_CLEAR_KEY}`) && !words.crewmateCardKeys(false, false).includes('x x stop'), words.crewmateCardKeys(false, false) + ' — crewmateCardKeys(false, false) in src/screen/cockpit/crewmateWords.ts must keep esc back and the clear key on the board, with no stop key')
}

console.log('— CRW-11 the ⌃x ⌃x ladder says a second chord is needed within the window —')
{
  const m = await import('../../src/screen/concourse/controlManifest.ts')
  const arm = m.closeChordReceiptOf('arm-delete') ?? ''
  check('the arm receipt says it ARMED and that ⌃x ⌃x AGAIN deletes within the window', arm === 'armed — ⌃x ⌃x again deletes (5 s)', arm + ' — closeChordReceiptOf(\'arm-delete\') in src/screen/concourse/controlManifest.ts must say armed and that ⌃x ⌃x again deletes within the window')
  check('the pending-leader hint for the arm rung is unchanged (the rung the press takes, then the window)', m.closeChordHintOf('arm-delete') === '⌃x again arms the delete · ⌃x ⌃x in 5 s ends it', String(m.closeChordHintOf('arm-delete')) + ' — closeChordHintOf(\'arm-delete\') in src/screen/concourse/controlManifest.ts must keep its words')
}

console.log('— CRW-12 a shell the helper left behind records why it stopped —')
{
  const { shellOutcomeState } = await import('../../src/engine/tasks/taskOutcomeEnvelope.ts')
  check('a kill the operator asked for stays user-stop', shellOutcomeState({ code: 137, interrupted: true, wasKilled: true, killedBy: 'operator' }).terminationReason === 'user-stop', 'shellOutcomeState in src/engine/tasks/taskOutcomeEnvelope.ts must map killedBy operator to user-stop')
  check('a kill without a named source reads user-stop as before', shellOutcomeState({ code: 137, interrupted: true, wasKilled: true }).terminationReason === 'user-stop', 'shellOutcomeState in src/engine/tasks/taskOutcomeEnvelope.ts must map a kill with no killedBy to user-stop')
  const agentEnd = shellOutcomeState({ code: 137, interrupted: true, wasKilled: true, killedBy: 'agent-end' })
  check('a shell the harness stopped because the helper that started it ended records agent-ended, state stopped', agentEnd.terminationReason === 'agent-ended' && agentEnd.state === 'stopped', JSON.stringify(agentEnd) + ' — shellOutcomeState in src/engine/tasks/taskOutcomeEnvelope.ts must map killedBy agent-end to terminationReason agent-ended with state stopped')
}

console.log('— CRW-13 the task’s ended row names its output file —')
{
  const state = await import('../../src/boot/process-state/processState.ts')
  const queue = await import('../../src/daemon/runner/sdkEventQueue.ts')
  const { getTaskOutputPath } = await import('../../src/engine/task-framework/diskOutput.ts')
  const was = state.getIsInteractive()
  state.setIsInteractive(false)
  queue.drainRows()
  queue.emitTaskEnded('atah91cr9', 'completed', { toolUseId: 'tu-1', summary: 'count the files' })
  const rows = queue.drainRows() as Array<{ type?: string; state?: string; output_file?: string; task_id?: string }>
  state.setIsInteractive(was)
  const ended = rows.find(r => r.type === 'task' && r.state === 'ended')
  check('an ended row with no file named carries the task’s own output path, never an empty string', ended !== undefined && ended.output_file === getTaskOutputPath('atah91cr9') && ended.output_file !== '', JSON.stringify(ended) + ' — emitTaskEnded in src/daemon/runner/sdkEventQueue.ts must fill output_file with getTaskOutputPath(taskId) when none is named')
  check('the path is the one the progress rows and the launch receipt name (<tasks dir>/<task id>.output)', (ended?.output_file ?? '').endsWith('/atah91cr9.output'), String(ended?.output_file) + ' — emitTaskEnded in src/daemon/runner/sdkEventQueue.ts must use the <tasks dir>/<task id>.output path')
}

console.log('— CRW-14 the landed toggle’s row says what the command’s receipt could not —')
{
  const sw = await import('../../src/daemon/switchboard/spawnSwitches.ts')
  const row = sw.spawnSwitchTransitionLine('subagents', false)
  const receipt = sw.spawnSwitchToggleReceipt('subagents', false, 'applied')
  check('the row says you turned it off and that the tool has left the roster (the landing)', row.startsWith('you turned crewmates off: ') && row.includes('has left the roster'), row + ' — spawnSwitchTransitionLine in src/daemon/switchboard/spawnSwitches.ts must say you turned crewmates off and that the tool has left the roster')
  check('it is not the command’s receipt word for word', row !== receipt && !row.includes('leaves the roster from the next turn'), row + ' — spawnSwitchTransitionLine in src/daemon/switchboard/spawnSwitches.ts must not reuse the words of spawnSwitchToggleReceipt')
  check('the on-road reads back on the roster', sw.spawnSwitchTransitionLine('subagents', true).includes('is back on the roster'), sw.spawnSwitchTransitionLine('subagents', true) + ' — spawnSwitchTransitionLine(kind, true) in src/daemon/switchboard/spawnSwitches.ts must say the tool is back on the roster')
  check('the row never says the operator (the reader is you)', !/\boperator\b/.test(row) && !row.includes('—'), row + ' — spawnSwitchTransitionLine in src/daemon/switchboard/spawnSwitches.ts must address the reader as you and use no em dash')
}

console.log('— CRW-15 a helper’s closing envelope reads as a close note in its crew view —')
{
  const { crewmateCloseNoteOf } = await import('../../src/screen/messages/AssistantTextMessage.tsx')
  const { parseDeclaration } = await import('../../src/crew/agent-results/normalize.ts')
  const text = 'I could not ask.\n<mercury-envelope>{"summary":"AskUserQuestion is not available in this session, so the question went unasked.","unresolved":["the colour was never chosen"],"checks":[]}</mercury-envelope>'
  const parsed = parseDeclaration(text)
  check('the prose and the envelope split', parsed.prose === 'I could not ask.' && parsed.declared !== null, JSON.stringify(parsed) + ' — parseDeclaration in src/crew/agent-results/normalize.ts must split the prose from the mercury-envelope block')
  const note = crewmateCloseNoteOf(parsed.declared!)
  check('the close note reads the summary, the unresolved items and the checks in words — no braces, no quotes', note === 'close note — AskUserQuestion is not available in this session, so the question went unasked. · 1 unresolved: the colour was never chosen · no checks named', note + ' — crewmateCloseNoteOf in src/screen/messages/AssistantTextMessage.tsx must read the summary, the unresolved items and the checks in words')
  check('an empty declaration still reads as words', crewmateCloseNoteOf({}) === 'close note — nothing declared', crewmateCloseNoteOf({}) + ' — crewmateCloseNoteOf in src/screen/messages/AssistantTextMessage.tsx must read an empty declaration as nothing declared')
  check('findings and the next action join the note', crewmateCloseNoteOf({ findings: ['a', 'b'], recommendedNextAction: 'rerun the suite', checks: ['typecheck'] }) === 'close note — 2 findings · next: rerun the suite · checks: typecheck', crewmateCloseNoteOf({ findings: ['a', 'b'], recommendedNextAction: 'rerun the suite', checks: ['typecheck'] }) + ' — crewmateCloseNoteOf in src/screen/messages/AssistantTextMessage.tsx must join findings, next action and checks')
}

console.log('— CRW-16 the CREW lane keeps the letters that tell helpers apart —')
{
  const { railRowBudgets, RAIL_ROW_NAME_FLOOR } = await import('../../src/screen/fullscreen-layout/HelmLanesRail.tsx')
  const { truncateToWidth } = await import('../../src/screen/theme/glyphs.ts')
  const tight = railRowBudgets(24, 'Helper A sleep 171'.length, '9.3k context'.length, 3)
  check('in a 28-column rail three "Helper <letter> sleep …" rows keep at least twelve columns of name — the letter shows', tight.name >= RAIL_ROW_NAME_FLOOR && truncateToWidth('Helper A sleep 171', tight.name).startsWith('Helper A'), JSON.stringify(tight) + ' — railRowBudgets in src/screen/fullscreen-layout/HelmLanesRail.tsx must give the name at least RAIL_ROW_NAME_FLOOR columns')
  check('the verb yields the columns the name took', tight.verb === 9 && tight.name + 3 + tight.verb === 24, JSON.stringify(tight) + ' — railRowBudgets in src/screen/fullscreen-layout/HelmLanesRail.tsx must give the verb the columns the name did not take')
  const { fitRailVerb } = await import('../../src/screen/fullscreen-layout/HelmLanesRail.tsx')
  check('a token verb that no longer fits sheds its word and keeps its figure — "9.3k context" reads "9.3k" in nine columns, never "9.3k con…"', fitRailVerb('9.3k context', 9) === '9.3k' && fitRailVerb('940 context', 7) === '940' && fitRailVerb('9.3k context', 12) === '9.3k context', [fitRailVerb('9.3k context', 9), fitRailVerb('940 context', 7), fitRailVerb('9.3k context', 12)].join(' | ') + ' — fitRailVerb in src/screen/fullscreen-layout/HelmLanesRail.tsx must shed the word and keep the token figure when the verb does not fit')
  check('a one-word verb that does not fit is cut with the ellipsis as before', fitRailVerb('landed', 4) === truncateToWidth('landed', 4), fitRailVerb('landed', 4) + ' — fitRailVerb in src/screen/fullscreen-layout/HelmLanesRail.tsx must cut a one-word verb with the ellipsis')
  check('a run verb that no longer fits keeps its AGE, the live reading, and sheds the kind the glyph already tells — "shell 3s" reads "3s" in five columns, "workflow 12m" reads "12m" in seven, "monitor 1.5h" reads "1.5h"; with room the kind returns', fitRailVerb('shell 3s', 5) === '3s' && fitRailVerb('workflow 12m', 7) === '12m' && fitRailVerb('monitor 1.5h', 6) === '1.5h' && fitRailVerb('shell 3s', 8) === 'shell 3s', [fitRailVerb('shell 3s', 5), fitRailVerb('workflow 12m', 7), fitRailVerb('monitor 1.5h', 6), fitRailVerb('shell 3s', 8)].join(' | ') + ' — fitRailVerb in src/screen/fullscreen-layout/HelmLanesRail.tsx must keep the age and shed the kind when a run verb does not fit')
  const drive = railRowBudgets(21, 'reef-survey'.length, '940 context'.length, 3)
  check('the crew drive’s rail (21 columns, reef-survey · 940 context) keeps the whole name and the figure', drive.name === 11 && fitRailVerb('940 context', drive.verb) === '940', JSON.stringify(drive) + ' — railRowBudgets and fitRailVerb in src/screen/fullscreen-layout/HelmLanesRail.tsx must keep the whole name and the figure in a 21-column rail')
  const roomy = railRowBudgets(40, 'Helper A sleep 171'.length, '9.3k context'.length, 3)
  check('with room both paint whole, exactly as before', roomy.name >= 18 && roomy.verb === 12, JSON.stringify(roomy) + ' — railRowBudgets in src/screen/fullscreen-layout/HelmLanesRail.tsx must paint name and verb whole when there is room')
  const short = railRowBudgets(24, 'atlas'.length, 'landed'.length, 3)
  check('a short name and verb share the row exactly as before', short.name >= 5 && short.verb === 6, JSON.stringify(short) + ' — railRowBudgets in src/screen/fullscreen-layout/HelmLanesRail.tsx must let a short name and verb share the row')
  check('a verb that would get under four columns leaves the row to the name', railRowBudgets(16, 20, 12, 3).verb === 0 && railRowBudgets(16, 20, 12, 3).name === 16, JSON.stringify(railRowBudgets(16, 20, 12, 3)) + ' — railRowBudgets in src/screen/fullscreen-layout/HelmLanesRail.tsx must drop the verb to 0 when it would get under four columns')
  check('no verb: the name takes the row', railRowBudgets(24, 30, 0, 3).name === 24, JSON.stringify(railRowBudgets(24, 30, 0, 3)) + ' — railRowBudgets in src/screen/fullscreen-layout/HelmLanesRail.tsx must give the name the whole row when there is no verb')
}

console.log('— CRW-17 the seats cell is the in-use/ceiling number alone; over the ceiling it turns the warning ink, no words —')
{
  const strips = await import('../../src/screen/concourse/ConcourseStrips.tsx')
  const over = strips.seatsCellText(5, 5, 2)
  check('over the ceiling the cell reads demand/ceiling and is marked over', over.text === '5/2' && over.over && !('overWords' in over), JSON.stringify(over) + ' — seatsCellText in src/screen/concourse/ConcourseStrips.tsx must read demand/ceiling, set over, and carry no overWords')
  const fits = strips.seatsCellText(2, 2, 5)
  check('within the ceiling the cell is the plain in-use/ceiling number', fits.text === '2/5' && !fits.over, JSON.stringify(fits) + ' — seatsCellText in src/screen/concourse/ConcourseStrips.tsx must read the plain in-use/ceiling number within the ceiling')
}

console.log(failures === 0 ? '\nprove-helper-rows-words: ALL LAWS HOLD' : `\nprove-helper-rows-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
