#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { BUN, REPO, SCRATCH_ROOT, bound, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ask-unanswered-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_BARE

const { StructuredIO } = await import('../../src/cli/structuredIO.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { DeadlineExceededError } = await import('../../src/utils/deadline.ts')
const rejection = await import('../../src/utils/messages/rejectionText.ts')
const { isDenialResultText, unwrapToolUseError } = rejection
const build = (rejection as { UNANSWERED_ASK_REJECT_MESSAGE?: (toolName: string, cause: string) => string }).UNANSWERED_ASK_REJECT_MESSAGE
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)

const tally = makeTally('prove-headless-ask-unanswered')
const j = (v: unknown): string => JSON.stringify(v)
const ABORTED_TEXT = 'Tool permission request failed: Tool permission request was aborted'
const STREAM_CLOSED_LEAD = 'Tool permission request failed: Permission stream closed before response was received for request '
const CHANNEL_CLOSED_CAUSE = 'the permission channel closed while the ask was pending'
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

function makeInput(): { iterable: AsyncIterable<string>; push: (block: string) => void; end: () => void } {
  const queue: string[] = []
  let done = false
  let wake: (() => void) | null = null
  return {
    push: b => {
      queue.push(b)
      wake?.()
    },
    end: () => {
      done = true
      wake?.()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!
          if (done) return
          await new Promise<void>(r => {
            wake = r
          })
          wake = null
        }
      },
    },
  }
}

type Harness = {
  io: InstanceType<typeof StructuredIO>
  ctx: Record<string, unknown>
  push: (o: unknown) => void
  end: () => void
  outbound: Array<Record<string, unknown>>
  waitOutbound: <T>(pick: () => T | undefined) => Promise<T>
}

function makeHarness(): Harness {
  const input = makeInput()
  const io = new StructuredIO(input.iterable)
  const outbound: Array<Record<string, unknown>> = []
  void (async () => {
    for await (const m of io.outbound) outbound.push(m as Record<string, unknown>)
  })()
  void (async () => {
    for await (const _ of io.structuredInput) void _
  })()
  let state: Record<string, unknown> = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    denialTracking: undefined,
    sessionHooks: new Map(),
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  const ctx: Record<string, unknown> = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (f: (p: Record<string, unknown>) => Record<string, unknown>): void => {
      state = f(state)
    },
    messages: [],
    agentId: undefined,
    agentType: undefined,
    options: { tools: [] },
  }
  return {
    io,
    ctx,
    push: o => input.push(JSON.stringify(o) + '\n'),
    end: () => input.end(),
    outbound,
    waitOutbound: async <T,>(pick: () => T | undefined): Promise<T> => {
      const deadline = Date.now() + bound(5_000)
      for (;;) {
        const v = pick()
        if (v !== undefined) return v
        if (Date.now() > deadline) throw new Error('waitOutbound timed out')
        await sleep(10)
      }
    },
  }
}

const TOOL = {
  name: 'UnansweredProbeTool',
  inputSchema: z.object({}).passthrough(),
  checkPermissions: async () => ({ behavior: 'ask', message: 'plain ask' }),
}
const ASSISTANT = { message: { id: 'msg_unanswered' } } as never
type Decision = { behavior: string; message?: string; decisionReason?: { type?: string; permissionPromptToolName?: string } }
const callCanUseTool = (h: Harness, toolUseId: string): Promise<Decision> =>
  h.io.createCanUseTool()(TOOL as never, { probe: 'x' }, h.ctx as never, ASSISTANT, toolUseId) as never
const askFrame = (h: Harness): (Record<string, unknown> & { request_id?: string }) | undefined =>
  h.outbound.find(m => m.type === 'control_request' && j(m).includes('can_use_tool')) as never
const cancelFrameFor = (h: Harness, requestId: string | undefined): Record<string, unknown> | undefined =>
  h.outbound.find(m => m.type === 'control_cancel_request' && m.request_id === requestId)

tally.section('U1 the field road, pure: the turn controller cut by the unattended-turn watchdog while the ask pends settles as the typed denial, never the abort text')
{
  const h = makeHarness()
  const p = callCanUseTool(h, 'toolu_u1')
  const frame = await h.waitOutbound(() => askFrame(h))
  const cutAt = Date.now()
  ;(h.ctx.abortController as AbortController).abort(new DeadlineExceededError('unattended turn', 20 * 60_000, 20 * 60_000 + 40_000, 46796, 'the turn was aborted'))
  const d = await p
  const settledIn = Date.now() - cutAt
  tally.check('red on the base: the decision is a deny whose text is the typed denial, not "Tool permission request was aborted"', d.behavior === 'deny' && isTypedDenial(d.message ?? '', TOOL.name), `base text: ${j(d.message)}`)
  tally.check('...the cause names the wait and the limit read off the cut (20m)', /nobody answered within 20m, the turn's no-progress limit/.test(causeOf(d.message ?? '', TOOL.name)), j(causeOf(d.message ?? '', TOOL.name)))
  tally.check('...the classifier reads it as a denial (the crimson glyph, the stop guidance), not an ordinary failure', isDenialResultText(d.message ?? ''), j(d.message))
  tally.check('...one owner: the words are byte-identical to UNANSWERED_ASK_REJECT_MESSAGE', build !== undefined && d.message === build(TOOL.name, causeOf(d.message ?? '', TOOL.name)), build === undefined ? 'the builder is absent (the base)' : j(d.message))
  tally.check("...decisionReason is the host-answer shape {type:'permissionPromptTool'} the daemon's own expired-ask denial takes", d.decisionReason?.type === 'permissionPromptTool' && d.decisionReason?.permissionPromptToolName === TOOL.name, j(d.decisionReason))
  tally.check('...settled at once (under a second of the cut)', settledIn < bound(1_000), `${settledIn}ms`)
  await h.waitOutbound(() => cancelFrameFor(h, frame.request_id))
  tally.check('...the ask is withdrawn on the wire (control_cancel_request for its request_id) so a daemon retires its needs-you row', cancelFrameFor(h, frame.request_id) !== undefined, j(h.outbound.map(m => m.type)))
  h.end()
}

tally.section('U2 the disconnect road, pure: the input stream ends while the ask pends')
{
  const h = makeHarness()
  const p = callCanUseTool(h, 'toolu_u2')
  const frame = await h.waitOutbound(() => askFrame(h))
  const closedAt = Date.now()
  h.end()
  const d = await p
  const settledIn = Date.now() - closedAt
  tally.check('red on the base: the typed denial, not the untyped "Permission stream closed before response was received" line', d.behavior === 'deny' && isTypedDenial(d.message ?? '', TOOL.name), `base text: ${j(d.message)}`)
  tally.check('...the base line is not a denial by the classifier (amber failure lead, no guidance)', !(d.message ?? '').startsWith(STREAM_CLOSED_LEAD) && isDenialResultText(d.message ?? ''), j(d.message))
  tally.check(`...the cause is the channel's closing: "${CHANNEL_CLOSED_CAUSE}"`, causeOf(d.message ?? '', TOOL.name) === CHANNEL_CLOSED_CAUSE, j(causeOf(d.message ?? '', TOOL.name)))
  tally.check('...settled at once (under a second of the close)', settledIn < bound(1_000), `${settledIn}ms`)
  await sleep(50)
  tally.check('...the ask is withdrawn on the wire (control_cancel_request)', cancelFrameFor(h, frame.request_id) !== undefined, j(h.outbound.map(m => m.type)))
  tally.check('...no pending permission request is left behind', h.io.getPendingPermissionRequests().length === 0 && h.io.pendingControlRequestCount() === 0, `${h.io.getPendingPermissionRequests().length} asks, ${h.io.pendingControlRequestCount()} requests`)
}

tally.section('U3 the abort road stays for a real abort: a bare parent abort (the operator\'s interrupt) still fails closed with the abort text (a law on the base and the tip alike)')
{
  const h = makeHarness()
  const p = callCanUseTool(h, 'toolu_u3')
  const frame = await h.waitOutbound(() => askFrame(h))
  ;(h.ctx.abortController as AbortController).abort()
  const d = await p
  tally.check('the operator\'s abort keeps the fail-closed abort text (the interrupt\'s own receipt paints the row)', d.behavior === 'deny' && d.message === ABORTED_TEXT, j(d.message))
  tally.check('...never the typed denial: nobody-there is not what happened', !isTypedDenial(d.message ?? '', TOOL.name), j(d.message))
  await h.waitOutbound(() => cancelFrameFor(h, frame.request_id))
  tally.check('...the pending request is still cancelled on the wire', cancelFrameFor(h, frame.request_id) !== undefined)
  h.end()
}

tally.section('U4 a typed operator cut (interrupt) is a real abort too; a stalled cut is a no-answer settle')
{
  const h1 = makeHarness()
  const p1 = callCanUseTool(h1, 'toolu_u4a')
  await h1.waitOutbound(() => askFrame(h1))
  ;(h1.ctx.abortController as AbortController).abort('interrupt')
  const d1 = await p1
  tally.check("abort('interrupt') keeps the abort text", d1.message === ABORTED_TEXT, j(d1.message))
  h1.end()
  const h2 = makeHarness()
  const p2 = callCanUseTool(h2, 'toolu_u4b')
  await h2.waitOutbound(() => askFrame(h2))
  ;(h2.ctx.abortController as AbortController).abort('stalled')
  const d2 = await p2
  tally.check("abort('stalled') settles as the typed denial with the no-limit cause", isTypedDenial(d2.message ?? '', TOOL.name) && causeOf(d2.message ?? '', TOOL.name) === "nobody answered before the turn's no-progress timeout", j(d2.message))
  h2.end()
}

tally.section('U5 the door: denyPendingPermissionRequests(cause) settles every parked ask with the caller\'s cause and keeps the turn controller untouched')
{
  const h = makeHarness()
  const p = callCanUseTool(h, 'toolu_u5')
  const frame = await h.waitOutbound(() => askFrame(h))
  const door = (h.io as unknown as { denyPendingPermissionRequests?: (cause: string) => number }).denyPendingPermissionRequests
  const settled = door === undefined ? -1 : door.call(h.io, 'the caller\'s own cause')
  tally.check('red on the base: the door exists and reports one settled ask', settled === 1, door === undefined ? 'no denyPendingPermissionRequests on StructuredIO (the base)' : `settled=${settled}`)
  if (door !== undefined) {
    const d = await p
    tally.check('...the ask settled as the typed denial carrying the caller\'s cause', isTypedDenial(d.message ?? '', TOOL.name) && causeOf(d.message ?? '', TOOL.name) === 'the caller\'s own cause', j(d.message))
    tally.check('...the turn controller is untouched (the turn goes on)', !(h.ctx.abortController as AbortController).signal.aborted)
    await h.waitOutbound(() => cancelFrameFor(h, frame.request_id))
    tally.check('...the ask is withdrawn on the wire', cancelFrameFor(h, frame.request_id) !== undefined)
    tally.check('...nothing pending remains; a second call settles nothing', h.io.getPendingPermissionRequests().length === 0 && door.call(h.io, 'again') === 0)
  }
  h.end()
}

tally.section('U6 the other request kinds keep their road: a hook callback pending when the input ends still answers {} (the door touches can_use_tool only)')
{
  const h = makeHarness()
  const cb = h.io.createHookCallback('cb-unanswered')
  const p = cb.callback({ hook_event_name: 'PreToolUse' } as never, 'toolu_u6', undefined)
  await h.waitOutbound(() => h.outbound.find(m => m.type === 'control_request' && j(m).includes('hook_callback')))
  h.end()
  const out = await p
  tally.check('the hook callback resolved to {} through its own catch (unchanged)', j(out) === '{}', j(out))
}

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
  const argv = ['run', launcher, 'run', '--input=rows', '--format=rows', '--permission-channel', 'stdio', '--model', 'claude-opus-4-8']
  const proc = spawn(BUN, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  proc.stdin.on('error', () => {})
  const run: SeatRun = { frames: [], askAt: 0, goneAt: 0, resultAt: 0, resultText: '', cancelSeen: false, requests: 0, exitCode: null, stderrTail: '' }
  let buffer = ''
  let stderr = ''
  let askUseId = ''
  proc.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
  proc.stdout.on('data', (c: Buffer) => {
    buffer += c.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim() === '') continue
      let frame: Frame
      try {
        frame = JSON.parse(line) as Frame
      } catch {
        continue
      }
      run.frames.push(frame)
      if (frame.type === 'tool_call' && frame.tool === 'AskUserQuestion' && typeof frame.call_id === 'string') askUseId = frame.call_id
      if (frame.type === 'control_request' && (frame.request as { subtype?: string } | undefined)?.subtype === 'can_use_tool' && run.askAt === 0) {
        run.askAt = Date.now()
        if (road === 'disconnect') {
          setTimeout(() => {
            run.goneAt = Date.now()
            proc.stdin.end()
          }, 200)
        }
      }
      if (frame.type === 'control_cancel_request') run.cancelSeen = true
      if (frame.type === 'tool_result' && run.resultAt === 0 && (askUseId === '' || frame.call_id === askUseId)) {
        run.resultAt = Date.now()
        run.resultText = String(frame.output ?? '')
      }
    }
  })
  proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'probe: ask the operator a question' }, uuid: randomUUID(), session_id: '' }) + '\n')
  const exited = new Promise<number | null>(resolve => proc.on('exit', code => resolve(code)))
  const until = Date.now() + bound(60_000)
  while (Date.now() < until) {
    if (run.resultAt !== 0 && (road === 'watchdog' || fixture.requests.length >= 2 || proc.exitCode !== null)) break
    await sleep(50)
  }
  await Promise.race([exited, sleep(bound(8_000))])
  try {
    proc.stdin.end()
  } catch {
  }
  try {
    proc.kill('SIGKILL')
  } catch {
  }
  run.exitCode = await Promise.race([exited, sleep(bound(3_000)).then(() => null)])
  run.requests = fixture.requests.length
  run.stderrTail = stderr.split('\n').filter(l => l.trim() !== '').slice(-3).join(' | ').slice(0, 300)
  await fixture.close()
  return run
}

tally.section('S1 the seat on the source, the field road: nobody answers, the unattended-turn watchdog (squeezed to 3s) is the only clock')
{
  const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'ask-unanswered-seat-')))
  try {
    const run = await runSeat('watchdog', root)
    const text = run.resultText
    tally.check('the seat asked over the channel and a tool_result for the ask came back', run.askAt !== 0 && run.resultAt !== 0, `frames: ${run.frames.map(f => String(f.type)).join(' ')} · stderr: ${run.stderrTail}`)
    tally.check('red on the base: the tool_result is the typed denial, not "Tool permission request failed: Tool permission request was aborted"', isTypedDenial(text, 'AskUserQuestion'), `base text: ${j(text)}`)
    tally.check('...naming the wait and the 3s limit read off the cut', /nobody answered within 3s, the turn's no-progress limit/.test(causeOf(text, 'AskUserQuestion')), j(causeOf(text, 'AskUserQuestion')))
    tally.check('...arriving at the cut (within the 3s limit plus a second of the ask, never later)', run.resultAt - run.askAt < 3_000 + bound(1_000), `${run.resultAt - run.askAt}ms after the ask`)
    tally.check('...the ask withdrawn on the wire (control_cancel_request on stdout)', run.cancelSeen, run.frames.map(f => String(f.type)).join(' '))
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
    tally.check('the seat asked over the channel, the client went away, and a tool_result for the ask came back', run.askAt !== 0 && run.goneAt !== 0 && run.resultAt !== 0, `frames: ${run.frames.map(f => String(f.type)).join(' ')} · stderr: ${run.stderrTail}`)
    tally.check('red on the base: the tool_result is the typed denial, not the untyped "Permission stream closed before response was received" line', isTypedDenial(text, 'AskUserQuestion'), `base text: ${j(text)}`)
    tally.check(`...with the channel's closing as the cause`, causeOf(text, 'AskUserQuestion') === CHANNEL_CLOSED_CAUSE, j(causeOf(text, 'AskUserQuestion')))
    tally.check('...arriving under a second after the disconnect', run.resultAt >= run.goneAt && run.resultAt - run.goneAt < bound(1_000), `${run.resultAt - run.goneAt}ms after the close`)
    tally.check('...the ask withdrawn on the wire (control_cancel_request on stdout)', run.cancelSeen, run.frames.map(f => String(f.type)).join(' '))
    tally.check("...the model's next request was issued (the turn went on; two provider requests)", run.requests >= 2, `${run.requests} provider request(s)`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
tally.finish()
