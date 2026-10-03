#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { BUN, REPO, SCRATCH_ROOT, bound, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ask-unanswered-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_BARE

const rejection = await import('../../src/utils/messages/rejectionText.ts')
const { isDenialResultText, unwrapToolUseError } = rejection
const build = (rejection as { UNANSWERED_ASK_REJECT_MESSAGE?: (toolName: string, cause: string) => string }).UNANSWERED_ASK_REJECT_MESSAGE
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)

const tally = makeTally('prove-headless-ask-unanswered')
const j = (v: unknown): string => JSON.stringify(v)
const ABORTED_TEXT = 'Tool permission request failed: Tool permission request was aborted'
const STREAM_CLOSED_LEAD = 'Tool permission request failed: Permission stream closed before response was received for request '
const DOOR_CLOSED_CAUSE = 'the host closed the runner door while the ask was pending'
const NO_ANSWER_LIMIT = /nobody answered within \S+, the turn's no-progress limit/
const typedLead = (toolName: string): RegExp => new RegExp(`^Permission to use ${toolName} has been denied: the operator's client was not there to answer \\((.+?)\\), so the action was not run\\. Work that does not depend on this action can continue; the operator can re-issue it from the switchboard once they are back\\. `)
const isTypedDenial = (text: string, toolName: string): boolean => isDenialResultText(text) && typedLead(toolName).test(unwrapToolUseError(text))
const causeOf = (text: string, toolName: string): string => typedLead(toolName).exec(unwrapToolUseError(text))?.[1] ?? ''

const guard = setTimeout(() => {
  console.log('\nTIMEOUT: the unanswered-ask laws exceeded 180s')
  process.exit(1)
}, bound(180_000))
guard.unref?.()

console.log('============================================================')
console.log(' the unanswered permission ask: a deny with a reason, never an abort')
console.log(' the base mints "Tool permission request was aborted" when the turn is cut under a parked ask, and an untyped "Permission stream closed" line when the client disconnects (checks marked red on the base)')
console.log('============================================================')

type Frame = Record<string, unknown>

type SeatRun = { frames: Frame[]; askAt: number; goneAt: number; resultAt: number; resultText: string; cancelSeen: boolean; requests: number; exitCode: number | null; stderrTail: string }

async function runSeat(road: 'watchdog' | 'disconnect', root: string): Promise<SeatRun> {
  const runHome = join(root, `home-${road}`)
  const cwd = join(runHome, 'work')
  seedScratchHome(runHome, cwd)
  const launcher = join(root, `launcher-${road}.ts`)
  writeFileSync(launcher, `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }\ndelete process.env.NODE_ENV\nawait import(${j(join(REPO, 'src', 'entrypoints', 'cli.tsx'))})\n`)
  const fixture = await startScriptedFixture(req => {
    if (req.step === 0) return [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'a', description: 'first' }, { label: 'b', description: 'second' }], multiSelect: false }] } }]
    return [{ type: 'text', text: 'carried on without the answer' }]
  })
  const env = { ...childEnv(runHome, Number(new URL(fixture.base).port)), ...(road === 'watchdog' ? { MERCURY_HEADLESS_IDLE_MINUTES: '0.05' } : {}) }
  const run: SeatRun = { frames: [], askAt: 0, goneAt: 0, resultAt: 0, resultText: '', cancelSeen: false, requests: 0, exitCode: null, stderrTail: '' }
  let askUseId = ''
  let askId = 0
  const host = hostRunner({
    node: BUN,
    dist: launcher,
    argv: ['--model', 'claude-opus-4-8'],
    cwd,
    env: env as Record<string, string | undefined>,
    home: runHome,
    onRow: frame => {
      run.frames.push(frame)
      if (frame.type === 'tool_call' && frame.tool === 'AskUserQuestion' && typeof frame.call_id === 'string') askUseId = frame.call_id
      if (frame.type === 'tool_result' && run.resultAt === 0 && (askUseId === '' || frame.call_id === askUseId)) {
        run.resultAt = Date.now()
        run.resultText = String(frame.output ?? '')
      }
    },
  })
  const proc = host.child
  void host.waitForAsk('the ask', bound(60_000)).then(
    ask => {
      if (run.askAt !== 0) return
      run.askAt = Date.now()
      askId = ask.id
      run.frames.push({ type: 'permission/request', ...ask.params })
      if (road === 'disconnect') {
        setTimeout(() => {
          run.goneAt = Date.now()
          host.end()
        }, 200)
      }
    },
    () => undefined,
  )
  const exited = host.exited
  try {
    await host.initialize({ holds_asks: false }, bound(60_000))
    await host.prompt('probe: ask the operator a question', { id: randomUUID() })
  } catch (error) {
    console.log(`  [door] ${error instanceof Error ? error.message : String(error)}`)
  }
  const until = Date.now() + bound(60_000)
  while (Date.now() < until) {
    if (run.resultAt !== 0 && (road === 'watchdog' || fixture.requests.length >= 2 || proc.exitCode !== null)) break
    await sleep(50)
  }
  await Promise.race([exited, sleep(bound(8_000))])
  host.end()
  try {
    proc.kill('SIGKILL')
  } catch {
  }
  run.exitCode = await Promise.race([exited, sleep(bound(3_000)).then(() => null)])
  host.peer.close('the seat run ended')
  run.cancelSeen = askId !== 0 && host.withdrawn.has(askId)
  run.requests = fixture.requests.length
  run.stderrTail = host.stderr().split('\n').filter(l => l.trim() !== '').slice(-3).join(' | ').slice(0, 300)
  await fixture.close()
  return run
}

tally.section('S1 the seat on the source, the field road: nobody answers, the unattended-turn watchdog (squeezed to 3s) is the only clock')
{
  const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'ask-unanswered-seat-')))
  try {
    const run = await runSeat('watchdog', root)
    const text = run.resultText
    tally.check('the seat asked through the runner door and a tool_result for the ask came back', run.askAt !== 0 && run.resultAt !== 0, `frames: ${run.frames.map(f => String(f.type)).join(' ')} · stderr: ${run.stderrTail}`)
    tally.check('red on the base: the tool_result is the typed denial, not "Tool permission request failed: Tool permission request was aborted"', isTypedDenial(text, 'AskUserQuestion'), `base text: ${j(text)}`)
    tally.check('...naming the wait and the 3s limit read off the cut', /nobody answered within 3s, the turn's no-progress limit/.test(causeOf(text, 'AskUserQuestion')), j(causeOf(text, 'AskUserQuestion')))
    tally.check('...arriving at the cut (within the 3s limit plus a second of the ask, never later)', run.resultAt - run.askAt < 3_000 + bound(1_000), `${run.resultAt - run.askAt}ms after the ask`)
    tally.check('...the ask withdrawn on the wire ($/cancel_request to the host)', run.cancelSeen, run.frames.map(f => String(f.type)).join(' '))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

tally.section('S2 the seat on the source, the disconnect road: the client closes stdin while the ask pends')
{
  const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'ask-unanswered-seat-')))
  try {
    const run = await runSeat('disconnect', root)
    const text = run.resultText
    tally.check('the seat asked through the runner door, the host went away, and a tool_result for the ask came back', run.askAt !== 0 && run.goneAt !== 0 && run.resultAt !== 0, `frames: ${run.frames.map(f => String(f.type)).join(' ')} · stderr: ${run.stderrTail}`)
    tally.check('red on the base: the tool_result is the typed denial, not the untyped "Permission stream closed before response was received" line', isTypedDenial(text, 'AskUserQuestion'), `base text: ${j(text)}`)
    tally.check(`...with the host's closing of the door as the cause`, causeOf(text, 'AskUserQuestion') === DOOR_CLOSED_CAUSE, j(causeOf(text, 'AskUserQuestion')))
    tally.check('...arriving under a second after the disconnect', run.resultAt >= run.goneAt && run.resultAt - run.goneAt < bound(1_000), `${run.resultAt - run.goneAt}ms after the close`)
    tally.check("...the model's next request was issued (the turn went on; two provider requests)", run.requests >= 2, `${run.requests} provider request(s)`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
tally.finish()
