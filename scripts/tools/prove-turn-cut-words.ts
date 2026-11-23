#!/usr/bin/env bun
import { resolve } from 'node:path'
const ROOT = resolve(import.meta.dir, '..', '..')
const cut = await import('../../src/engine/message-shapes/turnCut.ts')
const { DeadlineExceededError } = await import('../../src/platform/async/deadline.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
check("the operator's doors stay the operator's", ['interrupt', 'crew-stop', 'user-skip', 'user-retry'].every(r => cut.turnCutOf(r).kind === 'operator'), 'a reason in the operator list no longer maps to kind operator: see OPERATOR_CUT_REASONS and turnCutOf in src/engine/message-shapes/turnCut.ts')
const deadline = new DeadlineExceededError('crewmate fixture (a0)', 3_000, 9_000, 2)
check("a watchdog's deadline is the timeout, with the deadline's own sentence", cut.turnCutOf(deadline).kind === 'idle-timeout' && cut.turnCutWhy(cut.turnCutOf(deadline)) === `a no-progress timeout (the provider went quiet): ${deadline.message}`, `${JSON.stringify(cut.turnCutOf(deadline))} — a DeadlineExceededError must map to idle-timeout and read through turnCutWhy in src/engine/message-shapes/turnCut.ts`)
check("a stored line of a parent's stop still reads as the parent's stop, in the words it was stored with", cut.turnCutOfText('[Request cut off: the workflow that ran this crewmate stopped]')?.kind === 'parent-stop' && cut.turnCutResultText(cut.turnCutOfText('[Request cut off: the workflow that ran this crewmate stopped]')!) === 'Cut off: the workflow that ran this crewmate stopped', 'a stored parent-stop line must parse back to kind parent-stop and render the same words: see turnCutOfText, turnCutResultText and PARENT_STOP_WORDS in src/engine/message-shapes/turnCut.ts')
check('an unknown string still names itself (a foreign abort reason is not silenced)', cut.turnCutOf('something-else').detail === 'something-else', 'an unknown string reason must come back as kind cut with the string as detail: see turnCutOf in src/engine/message-shapes/turnCut.ts')
const STORED_WORDS: Array<[string, string]> = [['throttled', 'the retry budget was spent'], ['terminal-400', 'the provider refused the request outright'], ['workflow-permission-timeout', 'the permission ask timed out']]
for (const [wrote, words] of STORED_WORDS) {
  const c = cut.turnCutOfText(`[Request cut off: ${words}]`)
  check(`a stored row that '${wrote}' wrote reads back with its words, never the id`, c?.kind === 'cut' && c.detail === words && cut.turnCutLine(c, false) === `[Request cut off: ${words}]` && !cut.turnCutLine(c, false).includes(wrote), `${JSON.stringify(c)} — turnCutOfText and turnCutLine in src/engine/message-shapes/turnCut.ts must round-trip the stored words`)
}


{
  const timedOut = cut.turnCutWhy(cut.turnCutOfText('[Request cut off: the permission ask timed out]')!)
  check("the permission ask's timeout, read from a stored row, keeps its words", timedOut === 'the permission ask timed out', `${String(timedOut)} — turnCutWhy in src/engine/message-shapes/turnCut.ts must return the stored detail for a cut`)
  check("…while the operator's own stop keeps the runtime's message (no words to paint)", cut.turnCutWhy(cut.turnCutOf('interrupt')) === null, 'turnCutWhy in src/engine/message-shapes/turnCut.ts must return null for an operator cut')
}

console.log(failures === 0 ? '\nprove-turn-cut-words: all green' : `\nprove-turn-cut-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
