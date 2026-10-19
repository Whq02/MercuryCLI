#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, childEnv, DIST, isOutcome, SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

let failures = 0
let count = 0
function check(label: string, cond: boolean, detail = ''): void {
  count++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`)
}
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'queued-words-never-abort-')))
console.log(`world: ${scratch}`)
const SLOW_ASK = 'think slowly about the first thing'
const QUEUED_ASK = 'a second thing, typed while the first runs'
const NOW_ASK = 'drop everything and answer this now'
const j = (v: unknown): string => JSON.stringify(v)

const home = join(scratch, 'home')
const cwd = join(scratch, 'work')
seedScratchHome(home, cwd)
const fixture = await startScriptedFixture(
  req => {
    if (req.ask.trim() === SLOW_ASK) return [{ type: 'text', text: 'FIRST-DONE' }]
    if (req.ask.trim() === QUEUED_ASK) return [{ type: 'text', text: 'SECOND-DONE' }]
    if (req.ask.trim() === NOW_ASK) return [{ type: 'text', text: 'NOW-DONE' }]
    return [{ type: 'text', text: 'ok' }]
  },
  { answerDelayMs: req => (req.ask.trim() === SLOW_ASK ? 2_500 : 0) },
)
const port = Number(new URL(fixture.base).port)
const runner = bootRunner({ cwd, env: childEnv(home, port) })
const textOf = (frame: Record<string, unknown>): string => (typeof frame.text === 'string' ? frame.text : '')
const framesSince = (from: number): Array<Record<string, unknown>> => runner.frames.slice(from) as Array<Record<string, unknown>>

try {
  section('§1 a prompt queued while a request is in flight never aborts it (the field row M39-08)')
  {
    const from = runner.frames.length
    void runner.prompt(SLOW_ASK, randomUUID())
    const opened = await runner.waitFor('the first turn opened', f => f.type === 'turn' && f.state === 'started', bound(30_000), from)
    check('the first turn is running', opened !== null, runner.stderr().slice(-300))
    await new Promise(r => setTimeout(r, 600))
    await runner.prompt(QUEUED_ASK, randomUUID())
    const firstOutcome = await runner.waitFor('the first outcome', isOutcome, bound(60_000), from)
    const firstText = framesSince(from).filter(f => f.type === 'text').map(textOf)
    check('the first request finished with its own answer — nothing aborted it', firstOutcome !== null && firstOutcome.status === 'completed' && firstText.some(t => t.includes('FIRST-DONE')), j({ outcome: firstOutcome?.status, texts: firstText }))
    check('no interrupted outcome was written for a queued prompt', !framesSince(from).some(f => isOutcome(f) && f.status === 'interrupted'), j(framesSince(from).filter(isOutcome).map(f => f.status)))
    const secondOutcome = await runner.waitFor('the second outcome', f => isOutcome(f) && framesSince(from).filter(isOutcome).length >= 2, bound(60_000), from)
    const texts = framesSince(from).filter(f => f.type === 'text').map(textOf)
    check('the queued prompt ran after the first turn ended, in its own turn', secondOutcome !== null && texts.some(t => t.includes('SECOND-DONE')), j(texts))
  }

  section('§3 a state command queued while a request is in flight runs at the next boundary; the request is never aborted (the field row 2D-21)')
  {
    const from = runner.frames.length
    void runner.prompt(SLOW_ASK, randomUUID())
    const opened = await runner.waitFor('the slow turn opened', f => f.type === 'turn' && f.state === 'started', bound(30_000), from)
    check('the slow turn is running', opened !== null)
    await new Promise(r => setTimeout(r, 600))
    const accepted = await runner.host.prompt('/advise on', { id: randomUUID() })
    check('the command is queued without a priority word, as a typed slash command reaches the worker', (accepted as { accepted?: boolean }).accepted === true, j(accepted))
    const firstOutcome = await runner.waitFor('the slow outcome', isOutcome, bound(60_000), from)
    const texts = framesSince(from).filter(f => f.type === 'text').map(textOf)
    check('the request in flight finished with its own answer — the queued command aborted nothing', firstOutcome !== null && firstOutcome.status === 'completed' && texts.some(t => t.includes('FIRST-DONE')), j({ outcome: firstOutcome?.status, texts }))
    check('no interrupted outcome was written', !framesSince(from).some(f => isOutcome(f) && f.status === 'interrupted'), j(framesSince(from).filter(isOutcome).map(f => f.status)))
    const output = await runner.waitFor('the command ran at the boundary', f => f.type === 'command_output' && String((f as { text?: unknown }).text ?? '').toLowerCase().includes('advis'), bound(30_000), from)
    check('the command ran after the turn ended and answered in its own row', output !== null, j(framesSince(from).map(f => f.type)))
    await runner.waitFor("the command's own turn settled", f => isOutcome(f) && framesSince(from).filter(isOutcome).length >= 2, bound(30_000), from)
  }

  section('§2 an explicit priority "now" prompt is the one road that interrupts, and the row says so in the operator\'s words')
  {
    const from = runner.frames.length
    void runner.prompt(SLOW_ASK, randomUUID())
    const opened = await runner.waitFor('the slow turn opened', f => f.type === 'turn' && f.state === 'started', bound(30_000), from)
    check('the slow turn is running', opened !== null)
    await new Promise(r => setTimeout(r, 600))
    await runner.host.prompt(NOW_ASK, { id: randomUUID(), priority: 'now' })
    const outcome = await runner.waitFor('an outcome after the now prompt', f => isOutcome(f) && framesSince(from).filter(f2 => f2.type === 'text').some(f2 => textOf(f2).includes('NOW-DONE')), bound(60_000), from)
    const outcomes = framesSince(from).filter(isOutcome)
    const texts = framesSince(from).filter(f => f.type === 'text').map(textOf)
    check('the now prompt interrupted the slow request: its outcome reads interrupted, its answer never came, and the now prompt was answered', outcome !== null && outcomes[0]?.status === 'interrupted' && !texts.some(t => t.includes('FIRST-DONE')) && texts.some(t => t.includes('NOW-DONE')), j({ outcomes: outcomes.map(o => o.status), texts }))
  }
} finally {
  await fixture.close()
  await runner.stop(bound(5_000))
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`world kept: ${scratch}`)
if (failures > 0) {
  console.log('QUEUED WORDS NEVER ABORT RED')
  process.exit(1)
}
console.log('QUEUED WORDS NEVER ABORT GREEN')
