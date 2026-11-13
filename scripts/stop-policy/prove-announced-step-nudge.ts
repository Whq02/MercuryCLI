#!/usr/bin/env bun
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, makeTally, SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { call, hosted, mark, noticesOf, oneShot, recoveriesOf, say, sse, type Asked, type Ran, type WireAnswer } from './leftAlone.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { check, section, finish, failed } = makeTally('prove-announced-step-nudge')
if (!existsSync(DIST)) {
  check(`the built bundle stands at ${DIST}`, false, 'build first')
  finish()
}
console.log(`build under proof: ${DIST}`)
const world = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'announced-step-')))
const j = (value: unknown): string => (JSON.stringify(value) ?? '').slice(0, 700)

const TASK = 'Add a subtract function to calc.py and run the tests.'
const NUDGE = 'You ended your turn right after announcing a next step, with no tool call: if the task still needs that step, do it now; if the task is already done, give your final answer.'
const ASKED_ONCE = 'The reply announced a next step and ended the turn with no tool call — asked the model once to take it or to give its final answer'
const ASKED_ALREADY = 'The reply announced a next step again and ended the turn with no tool call — the model was already asked once; the turn ends here'
const DONE = 'The subtract function is in calc.py and the tests pass.'

const completed = (ran: Ran): boolean => ran.code === 0 && ran.outcome?.status === 'completed'
const said = (ran: Ran): string => j({ code: ran.code, status: ran.outcome?.status, answer: ran.outcome?.answer, asked: ran.asked.map(asked => asked.tail.slice(0, 60)), marks: ran.marks, recoveries: ran.outcome?.recoveries, notices: noticesOf(ran), stderr: ran.stderr.slice(-200) })

section('§1 the test reads the last sentence of a reply: the model\'s own next action, never a question, an offer or a wait')
{
  const evaluator = (await import('../../src/services/run/completionEvaluator.ts')) as { announcesNextStep?: (reply: string) => boolean }
  const announces = evaluator.announcesNextStep ?? (() => false)
  const steps = [
    'I looked at the files. Next I will run the tests.',
    'Let me now update the file.',
    'The first step ran. Now I will run the',
    "I'll start by reading the config:",
    "Let's look at the test file.",
    "I'm going to run the build now.",
    'Okay, now let me check the logs.',
    'I looked at the file. Next I will',
    'The function is in place.\n\nNow let me run the tests to confirm.',
    'I’ll now apply the fix.',
    'I will need to read the config first.',
    '**Next, I will add the subtract function.**',
    'Great. Let me go ahead and run the suite.',
    'I am going to edit calc.py.',
    'Fixed. I will now summarize the changes.',
  ]
  const ends = [
    'calc.py already has a subtract function, and the tests pass: nothing to change.',
    'Which test runner should I use, pytest or unittest?',
    'Let me know if anything else is needed.',
    'Let me know if you want changes.',
    "I'll wait for the review.",
    'I will not change the tests.',
    "I'll stop here.",
    "I'll leave it there.",
    "I'll be here if needed.",
    'The tests pass.',
    'Done. Next steps: run the migration yourself.',
    'I can also add tests if that would help.',
    'If needed, I will rerun the tests.',
    'Let me summarize what changed:\n- added subtract\n- ran the tests',
    "In summary, I'll note that all tests pass.",
    "All done — I'll push when asked.",
    "I'll need the API key to continue.",
    "I'll have to stop here.",
    "I'll run the tests for you now.",
    'Should I go ahead? I will wait.',
    '',
    '   \n  ',
    'Done.',
    'The subtract function was added and all 4 tests pass.',
    "I won't touch the other files.",
    "I'll follow up once CI finishes.",
    'Let us know how it goes.',
    'I will report back when done.',
    'Next: nothing, the task is complete.',
    'I’ll await further instructions.',
  ]
  check('the stop evaluator carries the test', evaluator.announcesNextStep !== undefined)
  check(`each of ${steps.length} endings that state a next action is read as one`, steps.every(announces), j(steps.filter(text => !announces(text))))
  check(`none of ${ends.length} endings that answer, ask, offer, wait or stop is read as one`, !ends.some(announces), j(ends.filter(announces)))
}

section('§2 a one-shot run: the reply announces a step after a tool round and ends the turn — asked once, the step is taken')
{
  const ran = await oneShot(world, 'after-a-round', TASK, asked => (asked.n === 1 ? call(asked, 'Bash', { command: 'ls', description: 'look around' }) : asked.n === 2 ? say(asked, 'I looked at the files. Next I will run the tests.') : asked.n === 3 ? call(asked, 'Bash', mark('tests')) : say(asked, DONE)))
  check('the run completed and exited 0', completed(ran), said(ran))
  check('four model calls: the look, the announcement, the step, the answer', ran.asked.length === 4, said(ran))
  check('the request after the announcement ends on the one-line ask, word for word', ran.asked[2]?.tail === NUDGE, j(ran.asked[2]?.tail))
  check('the announced step ran, once', j(ran.marks) === j(['tests']), j(ran.marks))
  check('the answer is the model\'s own last words', ran.outcome?.answer === DONE, j(ran.outcome?.answer))
  check('the outcome counts the ask: recoveries holds one announced_step', j(recoveriesOf(ran)) === j(['announced_step']), j(ran.outcome?.recoveries))
  check('the notices say what was done', noticesOf(ran).includes(ASKED_ONCE) && !noticesOf(ran).includes(ASKED_ALREADY), j(noticesOf(ran)))
}

section('§3 a one-shot run: the FIRST reply announces a step — asked once, the step is taken')
{
  const ran = await oneShot(world, 'first-reply', TASK, asked => (asked.n === 1 ? say(asked, 'Let me now update the file.') : asked.n === 2 ? call(asked, 'Bash', mark('edit')) : say(asked, DONE)))
  check('the run completed with the model\'s answer', completed(ran) && ran.outcome?.answer === DONE, said(ran))
  check('the second request ends on the ask and the step ran once', ran.asked[1]?.tail === NUDGE && j(ran.marks) === j(['edit']), said(ran))
  check('recoveries holds one announced_step', j(recoveriesOf(ran)) === j(['announced_step']), j(ran.outcome?.recoveries))
}

section('§4 the model answers the ask with its final answer: the turn ends on that answer')
{
  const ran = await oneShot(world, 'already-done', TASK, asked => (asked.n === 1 ? say(asked, 'The function is in place. Next I will run the tests.') : say(asked, DONE)))
  check('two model calls and a completed run whose answer is the final answer', completed(ran) && ran.asked.length === 2 && ran.outcome?.answer === DONE, said(ran))
  check('one ask is counted and nothing says "again"', j(recoveriesOf(ran)) === j(['announced_step']) && !noticesOf(ran).includes(ASKED_ALREADY), said(ran))
}

section('§5 the model announces again after the ask: no second ask, the turn ends as it ended before, and the row says so')
{
  const ran = await oneShot(world, 'again', TASK, asked => (asked.n === 1 ? say(asked, 'Let me now update the file.') : say(asked, 'Now I will run the tests.')))
  check('exactly two model calls: the model is asked once, never twice', ran.asked.length === 2 && ran.asked[1]?.tail === NUDGE, said(ran))
  check('the turn ends completed with the reply as its answer, as it did before', completed(ran) && ran.outcome?.answer === 'Now I will run the tests.', said(ran))
  check('recoveries holds the one ask', j(recoveriesOf(ran)) === j(['announced_step']), j(ran.outcome?.recoveries))
  check('the notices say the model announced a step again without taking it', noticesOf(ran).includes(ASKED_ONCE) && noticesOf(ran).includes(ASKED_ALREADY), j(noticesOf(ran)))
}

section('§6 one ask a turn: a second announcement later in the same turn is not asked about')
{
  const ran = await oneShot(world, 'once-a-turn', TASK, asked => (asked.n === 1 ? say(asked, 'Let me now update the file.') : asked.n === 2 ? call(asked, 'Bash', mark('edit')) : say(asked, 'Next I will run the linter.')))
  check('three model calls: the ask was spent on the first announcement', ran.asked.length === 3 && ran.asked[1]?.tail === NUDGE && ran.asked[2]?.tail === '', said(ran))
  check('the step taken after the ask ran once and the turn ends completed on the later announcement', completed(ran) && j(ran.marks) === j(['edit']) && ran.outcome?.answer === 'Next I will run the linter.', said(ran))
  check('one entry in recoveries, and the notices name the second announcement', j(recoveriesOf(ran)) === j(['announced_step']) && noticesOf(ran).includes(ASKED_ALREADY), said(ran))
}

section('§7 what does not move: an answer, a question, an offer and a finished tool round are never asked about')
{
  const plain: Array<[string, string]> = [
    ['an-answer', 'calc.py already has a subtract function, and the tests pass: nothing to change.'],
    ['a-question', 'Which test runner should I use, pytest or unittest?'],
    ['an-offer', 'The function is added. Let me know if you want changes.'],
  ]
  for (const [name, reply] of plain) {
    const ran = await oneShot(world, name, TASK, asked => say(asked, reply))
    check(`${name}: one model call, completed, the reply as the answer`, completed(ran) && ran.asked.length === 1 && ran.outcome?.answer === reply, said(ran))
    check(`${name}: no recoveries key and no notice`, ran.outcome !== undefined && !('recoveries' in ran.outcome) && noticesOf(ran).length === 0, said(ran))
  }
  const worked = await oneShot(world, 'worked', TASK, asked => (asked.n === 1 ? call(asked, 'Bash', mark('tests')) : say(asked, DONE)))
  check('a tool round and a final answer: two model calls, completed, no recoveries key', completed(worked) && worked.asked.length === 2 && worked.outcome !== undefined && !('recoveries' in worked.outcome) && j(worked.marks) === j(['tests']), said(worked))
}

section('§8 a stream that closes after a whole text block with no end event, its words announcing a step: the same ask takes it')
{
  const cut = (asked: Asked): WireAnswer => ({ steps: [{ write: sse.start(asked.n) + sse.text(0, 'The first step ran. Now I will run the') }, { wait: 100 }, { end: true }] })
  const ran = await oneShot(world, 'closed-stream', TASK, asked => (asked.n === 1 ? call(asked, 'Bash', mark('first')) : asked.n === 2 ? cut(asked) : asked.n === 3 ? call(asked, 'Bash', mark('second')) : say(asked, DONE)))
  check('the run completed on the model\'s answer', completed(ran) && ran.outcome?.answer === DONE, said(ran))
  check('the request after the cut reply ends on the ask, and each step ran once', ran.asked[2]?.tail === NUDGE && j(ran.marks) === j(['first', 'second']), said(ran))
  check('the notices carry the stream\'s own receipt and the ask', noticesOf(ran).some(text => text.includes('closed without its end event')) && noticesOf(ran).includes(ASKED_ONCE), j(noticesOf(ran)))
}

section('§9 a runner session no screen belongs to is asked; one a screen belongs to is not')
{
  const script = (asked: Asked): WireAnswer => (asked.n === 1 ? say(asked, 'Let me now update the file.') : asked.n === 2 ? call(asked, 'Bash', mark('edit')) : say(asked, DONE))
  const headless = await hosted(world, 'runner-headless', TASK, script)
  check('headless runner: the second request ends on the ask, the step ran, the answer is the model\'s', headless.outcome?.status === 'completed' && headless.asked[1]?.tail === NUDGE && j(headless.marks) === j(['edit']) && headless.outcome?.answer === DONE, said(headless))
  check('headless runner: recoveries holds one announced_step', j(recoveriesOf(headless)) === j(['announced_step']), j(headless.outcome?.recoveries))
  const screen = await hosted(world, 'runner-screen', TASK, script, { MERCURY_SESSION_KIND: 'oculus' })
  check('a session a screen belongs to: one model call, the turn ends on the announcement as before', screen.outcome?.status === 'completed' && screen.asked.length === 1 && screen.outcome?.answer === 'Let me now update the file.', said(screen))
  check('a session a screen belongs to: no recoveries key, no notice, nothing ran', screen.outcome !== undefined && !('recoveries' in screen.outcome) && noticesOf(screen).length === 0 && screen.marks.length === 0, said(screen))
}

section('§10 a crewmate that announces a step and ends its turn is asked once too')
{
  const CREW_TASK = 'CREW-TASK-7Q: run the tests in this folder and report the result.'
  let crewAsks = 0
  const crewTails: string[] = []
  const ran = await oneShot(world, 'crewmate', 'Have a crewmate run the tests, then report.', asked => {
    if (asked.opening.includes('CREW-TASK-7Q')) {
      crewAsks++
      crewTails.push(asked.tail)
      return crewAsks === 1 ? say(asked, 'Let me now run the tests.') : crewAsks === 2 ? call(asked, 'Bash', mark('crew')) : say(asked, 'The tests pass.')
    }
    return JSON.stringify(asked.body.messages ?? []).includes('tool_result') ? say(asked, 'The crewmate ran the tests and they pass.') : call(asked, 'Crewmate', { description: 'Run the tests', prompt: CREW_TASK, run_in_background: false })
  })
  check('the lead\'s run completed on its own answer', completed(ran) && ran.outcome?.answer === 'The crewmate ran the tests and they pass.', said(ran))
  check('the crewmate made three model calls and its second ends on the ask', crewAsks === 3 && crewTails[1] === NUDGE, j({ crewAsks, crewTails: crewTails.map(tail => tail.slice(0, 60)) }))
  check('the crewmate took the step it had announced, once', j(ran.marks) === j(['crew']), j(ran.marks))
  check('the lead\'s outcome row counts the lead\'s own asks only: no recoveries key', ran.outcome !== undefined && !('recoveries' in ran.outcome), j(ran.outcome?.recoveries))
}

if (failed() === 0) rmSync(world, { recursive: true, force: true })
else console.log(`\nworld kept: ${world}`)
finish()
