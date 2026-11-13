#!/usr/bin/env bun
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, makeTally, SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { call, hosted, mark, noticesOf, oneShot, recoveriesOf, say, sse, type Asked, type Ran, type WireAnswer } from './leftAlone.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { check, section, finish, failed } = makeTally('prove-silence-asked-once')
if (!existsSync(DIST)) {
  check(`the built bundle stands at ${DIST}`, false, 'build first')
  finish()
}
console.log(`build under proof: ${DIST}`)
const world = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'silence-once-')))
const j = (value: unknown): string => (JSON.stringify(value) ?? '').slice(0, 700)
const { EMPTY_REPLY_RECOVERY_NUDGE } = await import('../../src/services/api/errors.ts')

const TASK = 'Say what calc.py holds.'
const ANSWER = 'calc.py holds one function, add.'
const ASKED = 'The provider returned an empty reply — asked the model for its answer (retry 1 of 1)'

const noBlock = (asked: Asked): WireAnswer => ({ steps: [{ write: sse.start(asked.n) + sse.end('end_turn') }, { end: true }] })
const emptyText = (asked: Asked): WireAnswer => ({ steps: [{ write: sse.start(asked.n) + sse.text(0, '') + sse.end('end_turn') }, { end: true }] })
const said = (ran: Ran): string => j({ code: ran.code, status: ran.outcome?.status, answer: ran.outcome?.answer, calls: ran.asked.length, tails: ran.asked.map(asked => asked.tail.slice(0, 50)), marks: ran.marks, recoveries: ran.outcome?.recoveries, notices: noticesOf(ran), stderr: ran.stderr.slice(-200) })
const completed = (ran: Ran): boolean => ran.code === 0 && ran.outcome?.status === 'completed'

section('§1 a one-shot run whose first reply is a completed response with no block at all: asked once, and the model answers')
{
  const ran = await oneShot(world, 'no-block', TASK, asked => (asked.n === 1 ? noBlock(asked) : say(asked, ANSWER)))
  check('two model calls: the silence, then the ask', ran.asked.length === 2, said(ran))
  check('the second request ends on the existing empty-reply line, word for word', ran.asked[1]?.tail.endsWith(EMPTY_REPLY_RECOVERY_NUDGE) === true, j(ran.asked[1]?.tail))
  check('the run completed on the model\'s answer', completed(ran) && ran.outcome?.answer === ANSWER, said(ran))
  check('the outcome counts the ask: recoveries holds one empty_reply', j(recoveriesOf(ran)) === j(['empty_reply']), j(ran.outcome?.recoveries))
  check('the notices say the model was asked for its answer', noticesOf(ran).includes(ASKED), j(noticesOf(ran)))
}

section('§2 a tool round, then a completed response whose only block is an empty text: asked once, and the model answers')
{
  const ran = await oneShot(world, 'empty-text', TASK, asked => (asked.n === 1 ? call(asked, 'Bash', mark('read')) : asked.n === 2 ? emptyText(asked) : say(asked, ANSWER)))
  check('three model calls and the call ran once', ran.asked.length === 3 && j(ran.marks) === j(['read']), said(ran))
  check('the third request ends on the empty-reply line and the run completed on the answer', ran.asked[2]?.tail.endsWith(EMPTY_REPLY_RECOVERY_NUDGE) === true && completed(ran) && ran.outcome?.answer === ANSWER, said(ran))
  check('recoveries holds one empty_reply', j(recoveriesOf(ran)) === j(['empty_reply']), j(ran.outcome?.recoveries))
}

section('§3 silent again after the ask: no second ask, and the turn ends as silence ended before')
{
  const ran = await oneShot(world, 'twice', TASK, noBlock)
  check('exactly two model calls: asked once, never twice', ran.asked.length === 2 && ran.asked[1]?.tail.endsWith(EMPTY_REPLY_RECOVERY_NUDGE) === true, said(ran))
  check('the outcome is completed with no words for an answer, exit 0, as before', completed(ran) && (ran.outcome?.answer ?? '') === '', said(ran))
  check('recoveries holds the one ask and no line says the turn failed', j(recoveriesOf(ran)) === j(['empty_reply']) && noticesOf(ran).every(text => text === ASKED), said(ran))
}

section('§4 a runner session no screen belongs to is asked; one a screen belongs to is not, as before')
{
  const script = (asked: Asked): WireAnswer => (asked.n === 1 ? noBlock(asked) : say(asked, ANSWER))
  const headless = await hosted(world, 'runner-headless', TASK, script)
  check('headless runner: the second request ends on the empty-reply line and the answer is the model\'s', headless.asked[1]?.tail.endsWith(EMPTY_REPLY_RECOVERY_NUDGE) === true && headless.outcome?.status === 'completed' && headless.outcome?.answer === ANSWER, said(headless))
  check('headless runner: recoveries holds one empty_reply', j(recoveriesOf(headless)) === j(['empty_reply']), j(headless.outcome?.recoveries))
  const screen = await hosted(world, 'runner-screen', TASK, script, { MERCURY_SESSION_KIND: 'oculus' })
  check('a session a screen belongs to: one model call and a completed outcome with no words', screen.asked.length === 1 && screen.outcome?.status === 'completed' && (screen.outcome?.answer ?? '') === '', said(screen))
  check('a session a screen belongs to: no recoveries key and no notice', screen.outcome !== undefined && !('recoveries' in screen.outcome) && noticesOf(screen).length === 0, said(screen))
}

section('§5 what does not move: a reply with words is never asked about')
{
  const ran = await oneShot(world, 'words', TASK, asked => say(asked, ANSWER))
  check('one model call, completed, no recoveries key, no notice', ran.asked.length === 1 && completed(ran) && ran.outcome?.answer === ANSWER && ran.outcome !== undefined && !('recoveries' in ran.outcome) && noticesOf(ran).length === 0, said(ran))
}

if (failed() === 0) rmSync(world, { recursive: true, force: true })
else console.log(`\nworld kept: ${world}`)
finish()
