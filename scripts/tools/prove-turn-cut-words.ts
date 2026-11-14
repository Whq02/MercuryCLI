#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const ROOT = resolve(import.meta.dir, '..', '..')
const cut = await import('../../src/utils/messages/turnCut.ts')
const { DeadlineExceededError } = await import('../../src/utils/deadline.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

check("the operator's doors stay the operator's", ['interrupt', 'crew-stop', 'user-skip', 'user-retry'].every(r => cut.turnCutOf(r).kind === 'operator'))
const deadline = new DeadlineExceededError('crewmate fixture (a0)', 3_000, 9_000, 2)
check("a watchdog's deadline is the timeout, with the deadline's own sentence", cut.turnCutOf(deadline).kind === 'idle-timeout' && cut.turnCutWhy(cut.turnCutOf(deadline)) === `a no-progress timeout (the provider went quiet): ${deadline.message}`, JSON.stringify(cut.turnCutOf(deadline)))
check("a stored line of a parent's stop still reads as the parent's stop, in the words it was stored with", cut.turnCutOfText('[Request cut off: the workflow that ran this crewmate stopped]')?.kind === 'parent-stop' && cut.turnCutResultText(cut.turnCutOfText('[Request cut off: the workflow that ran this crewmate stopped]')!) === 'Cut off: the workflow that ran this crewmate stopped')
check('an unknown string still names itself (a foreign abort reason is not silenced)', cut.turnCutOf('something-else').detail === 'something-else')
const STORED_WORDS: Array<[string, string]> = [['throttled', 'the retry budget was spent'], ['terminal-400', 'the provider refused the request outright'], ['workflow-permission-timeout', 'the permission ask timed out']]
for (const [wrote, words] of STORED_WORDS) {
  const c = cut.turnCutOfText(`[Request cut off: ${words}]`)
  check(`a stored row that '${wrote}' wrote reads back with its words, never the id`, c?.kind === 'cut' && c.detail === words && cut.turnCutLine(c, false) === `[Request cut off: ${words}]` && !cut.turnCutLine(c, false).includes(wrote), JSON.stringify(c))
}


{
  const stopHooks = readFileSync(join(ROOT, 'src/query/stopHooks.ts'), 'utf8')
  check(
    "the turn.answer interruption row carries the abort signal's own reason",
    /createUserInterruptionMessage\(\{\s*toolUse: false,\s*reason: signal\.reason,?\s*\}\)/.test(stopHooks),
  )
  const timedOut = cut.turnCutWhy(cut.turnCutOfText('[Request cut off: the permission ask timed out]')!)
  check("the permission ask's timeout, read from a stored row, keeps its words", timedOut === 'the permission ask timed out', String(timedOut))
  check("…while the operator's own stop keeps the runtime's message (no words to paint)", cut.turnCutWhy(cut.turnCutOf('interrupt')) === null)
}

console.log(failures === 0 ? '\nprove-turn-cut-words: all green' : `\nprove-turn-cut-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
