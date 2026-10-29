#!/usr/bin/env bun
// gate-watch: src/utils/cockpit/crewmateWords.ts src/components/concourse/controlManifest.ts src/components/concourse/ConcourseRoute.tsx
// gate-watch: src/tasks/taskOutcomeEnvelope.ts src/tasks/LocalShellTask/killShellTasks.ts src/tasks/LocalShellTask/LocalShellTask.tsx
// gate-watch: src/utils/sdkEventQueue.ts src/services/switchboard/spawnSwitches.ts src/components/messages/AssistantTextMessage.tsx
// gate-watch: src/components/HelmLanesRail.tsx src/components/concourse/ConcourseStrips.tsx
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
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
const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

console.log('— CRW-08 the crewmate card names where its stop and pause keys fire —')
{
  const words = await import('../../src/utils/cockpit/crewmateWords.ts')
  const live = words.crewmateCardKeys(false)
  const pinned = words.crewmateCardKeys(true)
  check('the card no longer promises a bare x stop · p pause (those keys type into its composer)', !/· x stop · p pause(?! in)/.test(live) && !/· x stop · p pause(?! in)/.test(pinned), `${live} | ${pinned}`)
  check('it names the board where m, x x and p fire — m included, so the card never reads as a bare m while the composer has focus (F34A-20)', live.includes(`in ${words.CREW_VIEW_DOOR}: ${words.CREW_MAIN_CHAT_KEY} · x x stop · p pause`) && pinned.includes(`x x stop · p pause in ${words.CREW_VIEW_DOOR}`) && !/· m main chat ·/.test(live) && !/· m main chat ·/.test(words.crewmateCardKeys(false, false)), live)
  check('esc interrupts and the way back stand as before', live.startsWith('esc interrupts') && live.endsWith(words.BACK_HINT) && pinned.startsWith('esc interrupts'), live)
  check('a landed crewmate’s card keeps its own keys (esc back, the clear key placed on the board)', words.crewmateCardKeys(false, false).includes(`in ${words.CREW_VIEW_DOOR}: ${words.CREW_MAIN_CHAT_KEY} · ${words.CREW_CLEAR_KEY}`) && !words.crewmateCardKeys(false, false).includes('x x stop'))
}

console.log('— CRW-11 the ⌃x ⌃x ladder says a second chord is needed within the window —')
{
  const m = await import('../../src/components/concourse/controlManifest.ts')
  const arm = m.closeChordReceiptOf('arm-delete') ?? ''
  check('the arm receipt says it ARMED and that ⌃x ⌃x AGAIN deletes within the window', arm === 'armed — ⌃x ⌃x again deletes (5 s)', arm)
  const route = src('src/components/concourse/ConcourseRoute.tsx')
  check('the archive receipt names the 5 s window instead of promising a bare "again deletes it", and fits the receipt slot (64 characters)', route.includes("archived — the chat stands parked; ${keyHintLabel('⌃x ⌃x')} again in 5 s deletes it") && 'archived — the chat stands parked; ⌃x ⌃x again in 5 s deletes it'.length <= 64, route.match(/archived — the chat stands parked;[^\n]*/)?.[0] ?? '(absent)')
  check('the pending-leader hint for the arm rung is unchanged (the rung the press takes, then the window)', m.closeChordHintOf('arm-delete') === '⌃x again arms the delete · ⌃x ⌃x in 5 s ends it')
}

console.log('— CRW-12 a shell the helper left behind records why it stopped —')
{
  const { shellOutcomeState } = await import('../../src/tasks/taskOutcomeEnvelope.ts')
  check('a kill the operator asked for stays user-stop', shellOutcomeState({ code: 137, interrupted: true, wasKilled: true, killedBy: 'operator' }).terminationReason === 'user-stop')
  check('a kill without a named source reads user-stop as before', shellOutcomeState({ code: 137, interrupted: true, wasKilled: true }).terminationReason === 'user-stop')
  const agentEnd = shellOutcomeState({ code: 137, interrupted: true, wasKilled: true, killedBy: 'agent-end' })
  check('a shell the harness stopped because the helper that started it ended records agent-ended, state stopped', agentEnd.terminationReason === 'agent-ended' && agentEnd.state === 'stopped', JSON.stringify(agentEnd))
  const kill = src('src/tasks/LocalShellTask/killShellTasks.ts')
  check('the agent-end sweep stamps the kill source on every shell it ends', kill.includes("void killTask(task.id, setAppState, 'agent-end')") && kill.includes('killedBy,'))
  const settle = src('src/tasks/LocalShellTask/LocalShellTask.tsx')
  check('the settlement carries the stamp into the outcome envelope', settle.includes('killedBy = task.killedBy') && settle.includes('...(killedBy !== undefined ? { killedBy } : {}),'))
}

console.log('— CRW-13 the task’s ended row names its output file —')
{
  const state = await import('../../src/bootstrap/state.ts')
  const queue = await import('../../src/utils/sdkEventQueue.ts')
  const { getTaskOutputPath } = await import('../../src/utils/task/diskOutput.ts')
  const was = state.getIsInteractive()
  state.setIsInteractive(false)
  queue.drainRows()
  queue.emitTaskEnded('atah91cr9', 'completed', { toolUseId: 'tu-1', summary: 'count the files' })
  const rows = queue.drainRows() as Array<{ type?: string; state?: string; output_file?: string; task_id?: string }>
  state.setIsInteractive(was)
  const ended = rows.find(r => r.type === 'task' && r.state === 'ended')
  check('an ended row with no file named carries the task’s own output path, never an empty string', ended !== undefined && ended.output_file === getTaskOutputPath('atah91cr9') && ended.output_file !== '', JSON.stringify(ended))
  check('the path is the one the progress rows and the launch receipt name (<tasks dir>/<task id>.output)', (ended?.output_file ?? '').endsWith('/atah91cr9.output'))
}

console.log('— CRW-14 the landed toggle’s row says what the command’s receipt could not —')
{
  const sw = await import('../../src/services/switchboard/spawnSwitches.ts')
  const row = sw.spawnSwitchTransitionLine('subagents', false)
  const receipt = sw.spawnSwitchToggleReceipt('subagents', false, 'applied')
  check('the row says you turned it off and that the tool has left the roster (the landing)', row.startsWith('you turned crewmates off: ') && row.includes('has left the roster'), row)
  check('it is not the command’s receipt word for word', row !== receipt && !row.includes('leaves the roster from the next turn'), row)
  check('the on-road reads back on the roster', sw.spawnSwitchTransitionLine('subagents', true).includes('is back on the roster'))
  check('the row never says the operator (the reader is you)', !/\boperator\b/.test(row) && !row.includes('—'))
}

console.log('— CRW-15 a helper’s closing envelope reads as a close note in its crew view —')
{
  const { crewmateCloseNoteOf } = await import('../../src/components/messages/AssistantTextMessage.tsx')
  const { parseDeclaration } = await import('../../src/services/agentResults/normalize.ts')
  const text = 'I could not ask.\n<mercury-envelope>{"summary":"AskUserQuestion is not available in this session, so the question went unasked.","unresolved":["the colour was never chosen"],"checks":[]}</mercury-envelope>'
  const parsed = parseDeclaration(text)
  check('the prose and the envelope split', parsed.prose === 'I could not ask.' && parsed.declared !== null)
  const note = crewmateCloseNoteOf(parsed.declared!)
  check('the close note reads the summary, the unresolved items and the checks in words — no braces, no quotes', note === 'close note — AskUserQuestion is not available in this session, so the question went unasked. · 1 unresolved: the colour was never chosen · no checks named', note)
  check('an empty declaration still reads as words', crewmateCloseNoteOf({}) === 'close note — nothing declared')
  check('findings and the next action join the note', crewmateCloseNoteOf({ findings: ['a', 'b'], recommendedNextAction: 'rerun the suite', checks: ['typecheck'] }) === 'close note — 2 findings · next: rerun the suite · checks: typecheck')
  const renderer = src('src/components/messages/AssistantTextMessage.tsx')
  check('the fold rides the crewmate transcript alone (the plate context), through the one envelope parser', renderer.includes('crewmatePlate !== null && text.includes(`<${ENVELOPE_TAG}>`) ? parseDeclaration(text) : null'))
}

console.log('— CRW-16 the CREW lane keeps the letters that tell helpers apart —')
{
  const { railRowBudgets, RAIL_ROW_NAME_FLOOR } = await import('../../src/components/HelmLanesRail.tsx')
  const { truncateToWidth } = await import('../../src/components/mercury-ui/glyphs.ts')
  const tight = railRowBudgets(24, 'Helper A sleep 171'.length, '9.3k context'.length, 3)
  check('in a 28-column rail three "Helper <letter> sleep …" rows keep at least twelve columns of name — the letter shows', tight.name >= RAIL_ROW_NAME_FLOOR && truncateToWidth('Helper A sleep 171', tight.name).startsWith('Helper A'), JSON.stringify(tight))
  check('the verb yields the columns the name took', tight.verb === 9 && tight.name + 3 + tight.verb === 24)
  const { fitRailVerb } = await import('../../src/components/HelmLanesRail.tsx')
  check('a token verb that no longer fits sheds its word and keeps its figure — "9.3k context" reads "9.3k" in nine columns, never "9.3k con…"', fitRailVerb('9.3k context', 9) === '9.3k' && fitRailVerb('940 context', 7) === '940' && fitRailVerb('9.3k context', 12) === '9.3k context')
  check('a one-word verb that does not fit is cut with the ellipsis as before', fitRailVerb('landed', 4) === truncateToWidth('landed', 4))
  check('a run verb that no longer fits keeps its AGE, the live reading, and sheds the kind the glyph already tells — "shell 3s" reads "3s" in five columns, "workflow 12m" reads "12m" in seven, "monitor 1.5h" reads "1.5h"; with room the kind returns', fitRailVerb('shell 3s', 5) === '3s' && fitRailVerb('workflow 12m', 7) === '12m' && fitRailVerb('monitor 1.5h', 6) === '1.5h' && fitRailVerb('shell 3s', 8) === 'shell 3s')
  const drive = railRowBudgets(21, 'reef-survey'.length, '940 context'.length, 3)
  check('the crew drive’s rail (21 columns, reef-survey · 940 context) keeps the whole name and the figure', drive.name === 11 && fitRailVerb('940 context', drive.verb) === '940', JSON.stringify(drive))
  const roomy = railRowBudgets(40, 'Helper A sleep 171'.length, '9.3k context'.length, 3)
  check('with room both paint whole, exactly as before', roomy.name >= 18 && roomy.verb === 12)
  const short = railRowBudgets(24, 'atlas'.length, 'landed'.length, 3)
  check('a short name and verb share the row exactly as before', short.name >= 5 && short.verb === 6)
  check('a verb that would get under four columns leaves the row to the name', railRowBudgets(16, 20, 12, 3).verb === 0 && railRowBudgets(16, 20, 12, 3).name === 16)
  check('no verb: the name takes the row', railRowBudgets(24, 30, 0, 3).name === 24)
}

console.log('— CRW-17 the seats cell says what its over mark means —')
{
  const strips = await import('../../src/components/concourse/ConcourseStrips.tsx')
  const over = strips.seatsCellText(5, 5, 2)
  check('the ruled cell stands (5/2· while over) and the words beside it say how far over the reading', over.text === '5/2·' && over.over && over.overWords === '3 over the 2-seat reading', JSON.stringify(over))
  const fits = strips.seatsCellText(2, 2, 5)
  check('within the reading the cell is plain and carries no words', fits.text === '2/5' && !fits.over && fits.overWords === null)
  const rail = src('src/components/concourse/ConcourseStrips.tsx')
  check('the rail paints the words beside the cell in the same warning ink and budgets them', rail.includes('{seatsCell.overWords !== null ? <Text color={t.warning}> · {seatsCell.overWords}</Text> : null}') && rail.includes("${seatsCell.text} seats${seatsCell.overWords !== null ? ` · ${seatsCell.overWords}` : ''}"))
}

console.log(failures === 0 ? '\nprove-helper-rows-words: ALL LAWS HOLD' : `\nprove-helper-rows-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
