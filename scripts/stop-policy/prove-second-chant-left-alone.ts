#!/usr/bin/env bun
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, makeTally, SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { call, hosted, mark, noticesOf, oneShot, say, type Asked, type Ran, type WireAnswer } from './leftAlone.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { check, section, finish, failed } = makeTally('prove-second-chant-left-alone')
if (!existsSync(DIST)) {
  check(`the built bundle stands at ${DIST}`, false, 'build first')
  finish()
}
console.log(`build under proof: ${DIST}`)
const world = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'second-chant-')))
const j = (value: unknown): string => (JSON.stringify(value) ?? '').slice(0, 700)

const TASK = 'Say what the configuration file holds.'
const CHANT = 'The configuration file holds the value that was asked for. '.repeat(40)
const HONEST = 'The configuration file holds one key, retries, set to 3.'
const ASKED_TO_CONTINUE = 'asked the model to continue past it (continuation 1 of 1)'
const ENDED_ALONE = 'the reply repeated itself again after the loop notice; the turn is ended (nobody is at this run)'
const STANDS = 'the reply repeated itself again after the loop notice; the reply stands, and the loop guard ends no turn without turns.loopGuard'
const STOP = 'The loop guard ended the turn: the reply repeated the same stretch of text'

const errorOf = (ran: Ran): { message?: string; class?: string } => (ran.outcome?.error as { message?: string; class?: string } | undefined) ?? {}
const said = (ran: Ran): string => j({ code: ran.code, status: ran.outcome?.status, answer: ran.outcome?.answer, error: errorOf(ran), calls: ran.asked.length, marks: ran.marks, notices: noticesOf(ran).map(text => text.slice(-110)), stderr: ran.stderr.slice(-200) })
const chantsTwice = (asked: Asked): WireAnswer => (asked.n <= 2 ? say(asked, CHANT) : say(asked, HONEST))

section('§1 a one-shot run whose reply chants, and chants again after the loop notice: the turn ends typed, not completed')
{
  const ran = await oneShot(world, 'twice', TASK, chantsTwice)
  check('two model calls, never a third', ran.asked.length === 2, said(ran))
  check('the outcome is loop_stopped and the run exits 1', ran.outcome?.status === 'loop_stopped' && ran.code === 1, said(ran))
  check('the error is the loop guard\'s own sentence, class loop_stopped', String(errorOf(ran).message).startsWith(STOP) && errorOf(ran).class === 'loop_stopped', j(errorOf(ran)))
  check('no answer stands in for the chant', ran.outcome !== undefined && !('answer' in ran.outcome), j(ran.outcome?.answer))
  check('the notices say the model was asked once and that the turn is ended because nobody is at this run', noticesOf(ran).some(text => text.endsWith(ASKED_TO_CONTINUE)) && noticesOf(ran).some(text => text.endsWith(ENDED_ALONE)) && !noticesOf(ran).some(text => text.includes('turns.loopGuard')), j(noticesOf(ran)))
}

section('§2 the same after a tool round: the call ran once and the turn ends typed')
{
  const ran = await oneShot(world, 'after-a-round', TASK, asked => (asked.n === 1 ? call(asked, 'Bash', mark('read')) : asked.n <= 3 ? say(asked, CHANT) : say(asked, HONEST)))
  check('three model calls and the call ran once', ran.asked.length === 3 && j(ran.marks) === j(['read']), said(ran))
  check('the outcome is loop_stopped and the run exits 1', ran.outcome?.status === 'loop_stopped' && ran.code === 1, said(ran))
}

section('§3 what does not move: one chant is answered once and the turn completes on the model\'s next words')
{
  const ran = await oneShot(world, 'once', TASK, asked => (asked.n === 1 ? say(asked, CHANT) : say(asked, HONEST)))
  check('two model calls, completed, exit 0, the answer the model\'s own', ran.asked.length === 2 && ran.outcome?.status === 'completed' && ran.code === 0 && ran.outcome?.answer === HONEST, said(ran))
  check('one notice, the ask to continue past the chant', noticesOf(ran).length === 1 && noticesOf(ran)[0]!.endsWith(ASKED_TO_CONTINUE), j(noticesOf(ran)))
}

section('§4 a runner session no screen belongs to ends typed; one a screen belongs to keeps the reply, as before')
{
  const headless = await hosted(world, 'runner-headless', TASK, chantsTwice)
  check('headless runner: two model calls and a loop_stopped outcome with the guard\'s sentence', headless.asked.length === 2 && headless.outcome?.status === 'loop_stopped' && String(errorOf(headless).message).startsWith(STOP), said(headless))
  check('headless runner: the notices say nobody is at this run', noticesOf(headless).some(text => text.endsWith(ENDED_ALONE)), j(noticesOf(headless)))
  const screen = await hosted(world, 'runner-screen', TASK, chantsTwice, { MERCURY_SESSION_KIND: 'oculus' })
  check('a session a screen belongs to: two model calls and a completed outcome, the reply standing', screen.asked.length === 2 && screen.outcome?.status === 'completed', said(screen))
  check('a session a screen belongs to: the notices say the reply stands and name the key, as before', noticesOf(screen).some(text => text.endsWith(STANDS)) && !noticesOf(screen).some(text => text.includes('nobody is at this run')), j(noticesOf(screen)))
}

if (failed() === 0) rmSync(world, { recursive: true, force: true })
else console.log(`\nworld kept: ${world}`)
finish()
