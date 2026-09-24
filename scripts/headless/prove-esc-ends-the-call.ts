#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isResult, makeTally, sleep, user } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script, type ScriptedRequest } from '../lib/scriptedTurn.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'esc-ends-the-call-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const tally = makeTally('prove-esc-ends-the-call')
type Frame = Record<string, unknown>
type Block = { type?: string; name?: string; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; input?: { op?: string } }
const blocksOf = (f: Frame): Block[] => {
  const content = (f.message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Block[]) : []
}
const textOfContent = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ text?: string }>).map(b => b.text ?? '').join('') : ''
const GRACE_BOUND_MS = 2_500

console.log('============================================================')
console.log(' esc ends the call, never the runner')
console.log(' the base: the executor awaits tool.call with no race against the abort; a call that never answers holds the turn open (checks marked red on the base)')
console.log('============================================================')

tally.section('§1 the executor race, pure: a call that ignores the abort is abandoned within the grace and the interrupt result lands once')
{
  const { z } = await import('zod/v4')
  const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
  const { subscribeToolStart, subscribeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { CANCEL_MESSAGE } = await import('../../src/utils/messages.ts')
  const starts: unknown[] = []
  const terminals: Array<{ ok: boolean }> = []
  subscribeToolStart(e => starts.push(e))
  subscribeToolTerminal(e => terminals.push(e as never))
  const makeTool = (name: string, call: (...args: unknown[]) => Promise<unknown>): Record<string, unknown> => ({
    name,
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: undefined }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', content: typeof data === 'string' ? data : JSON.stringify(data), tool_use_id: id }),
    call,
  })
  const makeContext = (tool: unknown): { abortController: AbortController } & Record<string, unknown> => {
    const appState = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, denialTracking: undefined, sessionHooks: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} } }
    return {
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: () => {},
      messages: [],
      agentType: undefined,
      agentId: undefined,
      toolDecisions: new Map(),
      readFileState: new Map(),
      options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
    }
  }
  const ASSISTANT = { uuid: 'uuid-esc', requestId: 'req_esc', message: { id: 'msg_esc' } } as never
  const ALLOW = (async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
  type Yielded = { message?: { message?: { content?: Block[] } } }
  const resultTextOf = (updates: Yielded[]): string[] =>
    updates.flatMap(u => (u.message?.message?.content ?? []).filter(b => b.type === 'tool_result').map(b => textOfContent(b.content)))
  const drive = async (tool: Record<string, unknown>, ctx: ReturnType<typeof makeContext>, capMs: number): Promise<{ updates: Yielded[]; ended: boolean }> => {
    const updates: Yielded[] = []
    let ended = false
    const run = (async () => {
      for await (const update of runToolUse({ type: 'tool_use', id: `toolu_${tool.name as string}`, name: tool.name as string, input: {} } as never, ASSISTANT, ALLOW, ctx as never)) {
        updates.push(update as Yielded)
      }
      ended = true
    })()
    await Promise.race([run, sleep(capMs)])
    return { updates, ended }
  }

  {
    starts.length = 0
    terminals.length = 0
    let started = false
    let settleLate: (value: unknown) => void = () => {}
    const hung = new Promise<unknown>(resolve => {
      settleLate = resolve
    })
    const tool = makeTool('HangsOnAbort', () => {
      started = true
      return hung
    })
    const ctx = makeContext(tool)
    const drivePromise = drive(tool, ctx, 8_000)
    const startedBy = Date.now() + 5_000
    while (!started && Date.now() < startedBy) await sleep(10)
    tally.check('the fixture call started (the transaction reached tool.call)', started)
    const abortedAt = Date.now()
    ctx.abortController.abort()
    const { updates, ended } = await drivePromise
    const landedAt = Date.now()
    const texts = resultTextOf(updates)
    tally.check('red on the base: the call that ignores the abort is abandoned — the transaction ends without its answer', ended, `ended=${ended} after ${landedAt - abortedAt}ms`)
    tally.check('…with the interrupt result, in the interrupt\'s own words (never an error result, never a second shape)', texts.length === 1 && texts[0] === CANCEL_MESSAGE, JSON.stringify(texts).slice(0, 240))
    tally.check(`…within the grace (under ${GRACE_BOUND_MS} ms of the abort), not the tool's own time`, ended && landedAt - abortedAt <= GRACE_BOUND_MS, `${landedAt - abortedAt}ms`)
    tally.check('the call was observed once as started and once as terminal, ok:false', starts.length === 1 && terminals.length === 1 && terminals[0]!.ok === false, JSON.stringify({ starts: starts.length, terminals }))
    settleLate('the late answer nobody asked for')
    await sleep(50)
    tally.check('a late settle is dropped: no second result, no second terminal observation', resultTextOf(updates).length === 1 && terminals.length === 1, JSON.stringify({ texts: resultTextOf(updates).length, terminals: terminals.length }))
  }

  {
    starts.length = 0
    terminals.length = 0
    const tool = makeTool('AnswersTheAbort', (...args: unknown[]) => {
      const callContext = args[1] as { abortController: AbortController }
      return new Promise(resolve => {
        callContext.abortController.signal.addEventListener('abort', () => setTimeout(() => resolve({ data: 'answered the abort in time' }), 40), { once: true })
      })
    })
    const ctx = makeContext(tool)
    const drivePromise = drive(tool, ctx, 8_000)
    await sleep(60)
    ctx.abortController.abort()
    const { updates, ended } = await drivePromise
    const texts = resultTextOf(updates)
    tally.check('the grace is a grace: a call that answers the abort in time keeps its own answer', ended && texts.length === 1 && texts[0] === 'answered the abort in time', JSON.stringify(texts).slice(0, 200))
    tally.check('…observed once as terminal', terminals.length === 1, String(terminals.length))
  }

  {
    starts.length = 0
    terminals.length = 0
    const tool = makeTool('SettlesPlainly', async () => ({ data: 'txn ok' }))
    const ctx = makeContext(tool)
    const { updates, ended } = await drive(tool, ctx, 8_000)
    const texts = resultTextOf(updates)
    tally.check('a call nobody interrupts is byte-identical: its own result, once', ended && texts.length === 1 && texts[0] === 'txn ok' && terminals.length === 1 && terminals[0]!.ok === true, JSON.stringify(texts))
  }
}

tally.section('§2 the seat, on the built product: the Browser close that cannot answer (its Chrome frozen) ends on the first interrupt, the runner answers the next message')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist; §1 above still ran`)
} else if (process.platform === 'win32') {
  console.log('  [SKIP] SIGSTOP/SIGCONT are POSIX — the frozen-browser leg has nothing to drive on win32; §1 above still ran')
} else {
  const { resolveBrowser } = await import('../../src/services/browser/browserResolver.ts')
  const resolution = resolveBrowser()
  if (resolution.state !== 'ok') {
    console.log(`  [SKIP] no drivable browser on this machine — ${resolution.note}; §1 above still ran`)
  } else {
    console.log(`build under proof: ${DIST}`)
    const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'esc-ends-the-call-')))
    const runHome = join(root, 'home')
    const cwd = join(root, 'work')
    seedScratchHome(runHome, cwd)
    const page = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>the interrupt probe page</title><h1>probe</h1>')
    })
    await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve))
    const pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}/`
    const PROBE = 'interrupt probe: open the page, then close the browser'
    const FOLLOW_UP = 'interrupt probe: are you still there'
    const isFollowUp = (req: ScriptedRequest): boolean => req.ask.includes(FOLLOW_UP)
    const script: Script = req => {
      if (isFollowUp(req)) return [{ type: 'text', text: 'still here' }]
      if (!req.ask.includes(PROBE)) return [{ type: 'text', text: 'noted' }]
      if (req.step === 0) return [{ type: 'tool_use', name: 'Browser', input: { op: 'open', url: pageUrl } }]
      if (req.step === 1) return [{ type: 'tool_use', name: 'Browser', input: { op: 'close' } }]
      return [{ type: 'text', text: 'closed and done' }]
    }
    const CLOSE_STEP_DELAY_MS = 2_500
    const fixture = await startScriptedFixture(script, { answerDelayMs: req => (req.ask.includes(PROBE) && req.step === 1 ? CLOSE_STEP_DELAY_MS : 0) })
    const runner = bootRunner({ cwd, env: childEnv(runHome, Number(new URL(fixture.base).port)) })
    runner.proc.stdin?.on('error', () => {})
    const frozen: number[] = []
    const thaw = (): void => {
      for (const pid of frozen.splice(0)) {
        try {
          process.kill(pid, 'SIGCONT')
        } catch {
        }
      }
    }
    const childrenOf = (pid: number): number[] => {
      try {
        return execFileSync('pgrep', ['-P', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .split('\n')
          .map(line => Number(line.trim()))
          .filter(n => Number.isFinite(n) && n > 0)
      } catch {
        return []
      }
    }
    try {
      runner.send(user(PROBE, randomUUID()))
      const opened = await runner.waitFor("the open op's result", f => f.type === 'user' && blocksOf(f).some(b => b.type === 'tool_result' && textOfContent(b.content).startsWith('open: ')), bound(90_000))
      tally.check('the seat opened the probe page in a real browser', opened !== null, runner.frames.map(f => `${String(f.type)}${f.subtype ? ':' + String(f.subtype) : ''}`).join(' · ').slice(0, 300))
      const runnerPid = runner.proc.pid ?? 0
      const chrome = childrenOf(runnerPid)
      for (const pid of chrome) {
        try {
          process.kill(pid, 'SIGSTOP')
          frozen.push(pid)
        } catch {
        }
      }
      tally.check("the browser child was found under the runner and frozen (its close can never answer — the owner's hang, made deterministic)", frozen.length > 0, `runner ${runnerPid} children ${JSON.stringify(chrome)}`)
      const closeCall = await runner.waitFor('the close op', f => f.type === 'assistant' && blocksOf(f).some(b => b.type === 'tool_use' && b.name === 'Browser' && b.input?.op === 'close'), bound(CLOSE_STEP_DELAY_MS + 30_000))
      tally.check('the model called close on the frozen browser', closeCall !== null)
      const closeUseId = closeCall === null ? '' : String(blocksOf(closeCall).find(b => b.type === 'tool_use' && b.input?.op === 'close')?.id ?? '')
      await sleep(1_000)
      const framesBefore = runner.frames.length
      const interruptedAt = Date.now()
      runner.send({ type: 'control_request', request_id: `concourse-interrupt-${randomUUID().slice(0, 8)}`, request: { subtype: 'interrupt' } })
      const closeResult = await runner.waitFor("the close call's result", f => f.type === 'user' && blocksOf(f).some(b => b.type === 'tool_result' && b.tool_use_id === closeUseId), bound(8_000), framesBefore)
      const settledIn = Date.now() - interruptedAt
      const closeText = closeResult === null ? '' : textOfContent(blocksOf(closeResult).find(b => b.type === 'tool_result' && b.tool_use_id === closeUseId)?.content)
      tally.check(`red on the base: the interrupt ends the hung close within the grace (a result for its tool-use id within ${GRACE_BOUND_MS} ms)`, closeResult !== null && settledIn <= GRACE_BOUND_MS, closeResult === null ? 'no result within 8 s — the turn stayed open on the hung call' : `${settledIn}ms`)
      tally.check("…in the interrupt's words", /operator stopped this action|interrupted/i.test(closeText), closeText.slice(0, 160))
      const turnResult = await runner.waitFor("the interrupted turn's result frame", isResult, bound(8_000), framesBefore)
      tally.check('the turn closes on the interrupt (a result frame follows; the seat is not cut)', turnResult !== null && runner.proc.exitCode === null, `result ${turnResult === null ? 'none' : String(turnResult.subtype)} · exit ${String(runner.proc.exitCode)}`)
      thaw()
      await sleep(500)
      const duplicates = runner.frames.filter(f => f.type === 'user' && blocksOf(f).some(b => b.type === 'tool_result' && b.tool_use_id === closeUseId)).length
      tally.check('the late settle of the thawed close is never pushed as a second result', duplicates === 1, `${duplicates} result(s) for ${closeUseId}`)
      const before = runner.frames.length
      runner.send(user(FOLLOW_UP, randomUUID()))
      const follow = await runner.waitFor('the follow-up result', f => isResult(f) && fixture.requests.some(isFollowUp), bound(60_000), before)
      tally.check('the runner lives and answers the next message', follow !== null && follow.subtype === 'success' && fixture.requests.some(isFollowUp), String(follow?.subtype))
      await runner.stop(bound(15_000))
      const code = await runner.exited
      tally.check('stdin close ends the seat with exit 0 — nothing was cut', code === 0, `exit ${String(code)}`)
    } finally {
      thaw()
      runner.kill()
      await fixture.close()
      await new Promise<void>(resolve => page.close(() => resolve()))
      const stderr = runner.stderr().trim()
      if (stderr !== '') console.log(`  stderr tail: ${stderr.split('\n').slice(-2).join(' | ').slice(0, 240)}`)
      rmSync(root, { recursive: true, force: true })
    }
  }
}
rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
tally.finish()
