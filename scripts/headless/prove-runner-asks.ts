#!/usr/bin/env bun
// gate-watch: src/cli/headless/runnerAsks.ts src/cli/structuredIO.ts src/runner/wire/*
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'runner-asks-'))
delete process.env.MERCURY_BARE

import { z } from 'zod/v4'

const { createRunnerAsks, unansweredAskCause, DOOR_CLOSED_CAUSE, SANDBOX_NETWORK_ACCESS_TOOL_NAME } = await import('../../src/cli/headless/runnerAsks.ts')
const { DeadlineExceededError } = await import('../../src/utils/deadline.ts')
const { UNANSWERED_ASK_REJECT_MESSAGE, isDenialResultText, turnCutOf } = await import('../../src/utils/messages/rejectionText.ts')
const { createPeer } = await import('../../src/runner/wire/peer.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { addSessionHook } = await import('../../src/utils/hooks/sessionHooks.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — runner asks exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const SESSION_ID = 'asks-probe-agent'

type Ask = { id: number; params: Record<string, unknown> }
type Harness = {
  asks: ReturnType<typeof createRunnerAsks>
  ctx: Record<string, unknown>
  hostSaw: Ask[]
  cancels: Array<{ request_id: number; reason?: string }>
  withdrawn: Set<number>
  answer: (id: number, answer: Record<string, unknown>) => void
  hold: () => void
  capabilities: { holds_asks: boolean; elicitation: boolean; partial_rows: boolean }
  addHook: (command: string) => void
  waitAsk: () => Promise<Ask>
  closeHost: () => void
  runnerClosed: () => boolean
}

function makeHarness(opts: { allow?: string[]; deny?: string[]; elicitation?: boolean } = {}): Harness {
  const toHost = new PassThrough()
  const toRunner = new PassThrough()
  const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log: () => {} })
  const host = createPeer({ input: toHost, output: toRunner, side: 'host', log: () => {} })
  const capabilities = { holds_asks: true, elicitation: opts.elicitation ?? false, partial_rows: false }
  const asks = createRunnerAsks(runner, () => capabilities)
  const hostSaw: Ask[] = []
  const cancels: Array<{ request_id: number; reason?: string }> = []
  const withdrawn = new Set<number>()
  const pending = new Map<number, (answer: Record<string, unknown>) => void>()
  const askWaiters: Array<(ask: Ask) => void> = []
  let holding = false
  host.onRequest('permission/request', (params, ctx) => {
    const ask = { id: ctx.id, params: params as Record<string, unknown> }
    hostSaw.push(ask)
    ctx.signal.addEventListener('abort', () => withdrawn.add(ctx.id), { once: true })
    for (const waiter of askWaiters.splice(0)) waiter(ask)
    return new Promise(resolve => {
      pending.set(ctx.id, resolve as (answer: Record<string, unknown>) => void)
    }) as never
  })
  host.onRequest('elicitation/request', (params, ctx) => {
    const ask = { id: ctx.id, params: params as Record<string, unknown> }
    hostSaw.push(ask)
    for (const waiter of askWaiters.splice(0)) waiter(ask)
    return new Promise(resolve => {
      pending.set(ctx.id, resolve as (answer: Record<string, unknown>) => void)
    }) as never
  })
  host.onNotification('$/cancel_request', params => {
    cancels.push(params)
  })
  runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: 'sid' }))
  void host.request('initialize', { protocol: 1, host: { name: 'proof', version: '0' }, capabilities })
  let state: Record<string, unknown> = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: 'default' as const,
      alwaysAllowRules: opts.allow ? { userSettings: opts.allow } : {},
      alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    },
    denialTracking: undefined,
    sessionHooks: new Map(),
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  const setAppState = (f: (p: Record<string, unknown>) => Record<string, unknown>): void => {
    state = f(state)
  }
  const ctx: Record<string, unknown> = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState,
    messages: [],
    agentId: SESSION_ID,
    agentType: undefined,
    options: { tools: [] },
  }
  return {
    asks,
    ctx,
    hostSaw,
    cancels,
    withdrawn,
    capabilities,
    answer: (id, answer) => {
      pending.get(id)?.(answer)
      pending.delete(id)
    },
    hold: () => {
      holding = true
    },
    addHook: command => addSessionHook(setAppState as never, SESSION_ID, 'PermissionRequest', 'AskProbeTool', { type: 'command', command } as never),
    waitAsk: () => new Promise<Ask>(resolve => (hostSaw.length > 0 && !holding ? resolve(hostSaw[hostSaw.length - 1]!) : askWaiters.push(resolve))),
    closeHost: () => {
      host.end('the host left')
      toHost.end()
      toRunner.end()
    },
    runnerClosed: () => runner.closed,
  }
}

const TOOL = {
  name: 'AskProbeTool',
  inputSchema: z.object({}).passthrough(),
  checkPermissions: async () => ({ behavior: 'ask', message: 'plain ask' }),
}
const ASSISTANT = { message: { id: 'msg_asks' } } as never
type Decision = { behavior: string; message?: string; updatedInput?: Record<string, unknown>; decisionReason?: { type?: string; hookName?: string; permissionPromptToolName?: string } }
const callCanUseTool = (h: Harness, input: Record<string, unknown> = { probe: 'original' }): Promise<Decision> =>
  h.asks.createCanUseTool()(TOOL as never, input, h.ctx as never, ASSISTANT, 'toolu_asks') as never
const hookJson = (decision: Record<string, unknown>): string => j({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })

section('R1 — an owned-chain allow/deny short-circuits: no permission/request leaves, hooks never run')
{
  const marker = join(mkdtempSync(join(tmpdir(), 'asks-marker-')), 'hook-fired')
  const h = makeHarness({ allow: ['AskProbeTool'] })
  h.addHook(`touch ${marker}; echo '${hookJson({ behavior: 'deny', message: 'must never run' })}'`)
  const d = await callCanUseTool(h)
  check('the rule-allow returns directly', d.behavior === 'allow', j(d))
  await settle(150)
  check('NO permission/request went out', h.hostSaw.length === 0, j(h.hostSaw))
  check('the PermissionRequest hook NEVER fired', !existsSync(marker))
  h.closeHost()
}

section('R2 — the hook denies first: the hook wins, the pending permission/request is withdrawn with $/cancel_request')
{
  const h = makeHarness()
  h.addHook(`echo '${hookJson({ behavior: 'deny', message: 'hook fixture deny' })}'`)
  const d = await callCanUseTool(h)
  check('the decision is the HOOK deny', d.behavior === 'deny' && (d.message ?? '').includes('hook fixture deny'), j(d))
  check("decisionReason is {type:'hook', hookName:'PermissionRequest'}", d.decisionReason?.type === 'hook' && d.decisionReason?.hookName === 'PermissionRequest', j(d.decisionReason))
  await settle(50)
  check('the ask DID reach the host before the hook won, as permission/request kind tool', h.hostSaw.length === 1 && h.hostSaw[0]!.params.kind === 'tool' && h.hostSaw[0]!.params.tool_name === 'AskProbeTool', j(h.hostSaw))
  check("the losing ask is withdrawn: the host's handler is cancelled ($/cancel_request names its id)", h.withdrawn.has(h.hostSaw[0]!.id), j([...h.withdrawn]))
  check('no ask stays parked', h.asks.parkedAsks() === 0)
  h.closeHost()
}

section('R3 — the hook allows first: updatedInput carries, the ask is withdrawn')
{
  const h = makeHarness()
  h.addHook(`echo '${hookJson({ behavior: 'allow', updatedInput: { via: 'hook' } })}'`)
  const d = await callCanUseTool(h)
  check('the decision is the HOOK allow', d.behavior === 'allow', j(d))
  check('the hook updatedInput carries', j(d.updatedInput) === '{"via":"hook"}', j(d.updatedInput))
  await settle(50)
  check('the losing ask is withdrawn', h.withdrawn.size === 1, j([...h.withdrawn]))
  h.closeHost()
}

section("R4 — a no-decision hook defers to the host; an allow with no input runs the original, an explicit input runs as given, a malformed answer denies")
{
  const h = makeHarness()
  h.addHook(`echo '{}'`)
  const p = callCanUseTool(h, { probe: 'original' })
  const ask = await h.waitAsk()
  check('the ask carries the tool, the call id and the input', ask.params.tool_name === 'AskProbeTool' && ask.params.tool_use_id === 'toolu_asks' && j(ask.params.input) === '{"probe":"original"}' && ask.params.agent_id === SESSION_ID, j(ask.params))
  h.answer(ask.id, { outcome: 'allow' })
  const d = await p
  check('the host allow lands after the hook passed through', d.behavior === 'allow', j(d))
  check('an allow with NO input runs the ORIGINAL input', j(d.updatedInput) === '{"probe":"original"}', j(d.updatedInput))
  check("decisionReason is {type:'permissionPromptTool'}", d.decisionReason?.type === 'permissionPromptTool', j(d.decisionReason))
  h.hold()
  const p2 = callCanUseTool(h, { probe: 'second' })
  const ask2 = await h.waitAsk()
  h.answer(ask2.id, { outcome: 'allow', input: {} })
  const d2 = await p2
  check('an allow with an EXPLICIT empty input runs exactly that input (never the original)', d2.behavior === 'allow' && j(d2.updatedInput) === '{}', j(d2))
  const p3 = callCanUseTool(h, { probe: 'third' })
  const ask3 = await h.waitAsk()
  h.answer(ask3.id, { outcome: 'allow', input: [] })
  const d3 = await p3
  check('a malformed answer (input is a list) is a DENY — the wrong shape never runs the original', d3.behavior === 'deny', j(d3))
  check('nothing stays parked and nothing was withdrawn', h.asks.parkedAsks() === 0 && h.withdrawn.size === 0, j([...h.withdrawn]))
  h.closeHost()
}

section('R5 — the host answers while the hook still runs: the host wins, the late hook is ignored')
{
  const h = makeHarness()
  h.addHook(`sleep 2; echo '${hookJson({ behavior: 'allow', updatedInput: { via: 'late-hook' } })}'`)
  const started = Date.now()
  const p = callCanUseTool(h)
  const ask = await h.waitAsk()
  h.answer(ask.id, { outcome: 'deny', message: 'host fixture deny' })
  const d = await p
  check('the host deny wins the race', d.behavior === 'deny' && (d.message ?? '').includes('host fixture deny'), j(d))
  check('…without waiting out the still-running hook', Date.now() - started < 1_500, `${Date.now() - started}ms`)
  check("decisionReason is {type:'permissionPromptTool'} (not the late hook)", d.decisionReason?.type === 'permissionPromptTool', j(d.decisionReason))
  h.closeHost()
}

section('R6 — a host deny with stop aborts the parent turn controller')
{
  const h = makeHarness()
  h.addHook(`sleep 2; echo '{}'`)
  const p = callCanUseTool(h)
  const ask = await h.waitAsk()
  h.answer(ask.id, { outcome: 'deny', message: 'host stop deny', stop: true })
  const d = await p
  check('the deny lands', d.behavior === 'deny', j(d))
  check('the PARENT abort controller is aborted (deny with stop)', (h.ctx.abortController as AbortController).signal.aborted)
  h.closeHost()
}

section('R7 — parent cuts preserve the typed cause and withdraw the ask')
for (const [name, reason, cause] of [
  ['deadline', new DeadlineExceededError('unattended turn', 20 * 60_000, 20 * 60_000 + 40_000, 46796), "nobody answered within 20m, the turn's no-progress limit"],
  ['stalled', 'stalled', "nobody answered before the turn's no-progress timeout"],
  ['interrupt', 'interrupt', undefined],
  ['bare abort', undefined, undefined],
] as const) {
  const h = makeHarness()
  h.addHook(`sleep 2; echo '{}'`)
  const p = callCanUseTool(h)
  const ask = await h.waitAsk()
  const cutAt = Date.now()
  const parent = h.ctx.abortController as AbortController
  parent.abort(reason)
  const d = await p
  check(`${name}: the ask settles immediately after the cut`, Date.now() - cutAt < 1000)
  check(`${name}: the cause preserves idle versus operator cuts`, unansweredAskCause(parent.signal.reason) === cause && turnCutOf(parent.signal.reason).kind === (cause ? 'idle-timeout' : 'operator'))
  if (cause !== undefined) {
    check(`${name}: the exact denial comes from its one builder`, d.behavior === 'deny' && d.message === UNANSWERED_ASK_REJECT_MESSAGE(TOOL.name, cause), j(d))
    check(`${name}: the denial classifier recognizes the result`, isDenialResultText(d.message ?? ''))
    check(`${name}: the host-answer decision reason carries the tool identity`, d.decisionReason?.type === 'permissionPromptTool' && d.decisionReason.permissionPromptToolName === TOOL.name, j(d))
  } else {
    check(`${name}: the operator cut keeps its exact fail-closed answer`, d.behavior === 'deny' && d.message === 'Tool permission request failed: aborted', j(d))
    check(`${name}: an operator cut is not described as an unanswered ask`, !isDenialResultText(d.message ?? '') && d.decisionReason?.type === 'other', j(d))
  }
  await settle(50)
  check(`${name}: the pending ask is withdrawn on the wire`, h.withdrawn.has(ask.id), j([...h.withdrawn]))
  check(`${name}: no ask or request stays pending`, h.asks.parkedAsks() === 0 && h.asks.pendingControlRequestCount() === 0)
  h.closeHost()
}

section('R8 — settling held asks preserves the parent controller and is idempotent')
{
  const h = makeHarness()
  h.addHook(`sleep 2; echo '{}'`)
  const p = callCanUseTool(h)
  const ask = await h.waitAsk()
  const parent = h.ctx.abortController as AbortController
  const reason = parent.signal.reason
  check('one ask is parked', h.asks.parkedAsks() === 1)
  const cause = 'the caller chose to settle the unanswered ask'
  const settled = h.asks.denyPendingPermissionRequests(cause)
  const d = await p
  check('the settle count is one and the exact denial carries the caller cause', settled === 1 && d.behavior === 'deny' && d.message === UNANSWERED_ASK_REJECT_MESSAGE(TOOL.name, cause), j(d))
  check('the result is classified as a denial with the host-answer reason', isDenialResultText(d.message ?? '') && d.decisionReason?.type === 'permissionPromptTool' && d.decisionReason.permissionPromptToolName === TOOL.name)
  check('the parent controller and its reason are untouched', !parent.signal.aborted && parent.signal.reason === reason)
  check('a second settlement returns zero with nothing pending', h.asks.denyPendingPermissionRequests('again') === 0 && h.asks.parkedAsks() === 0 && h.asks.pendingControlRequestCount() === 0)
  await settle(50)
  check('the host sees the settled ask withdrawn ($/cancel_request)', h.withdrawn.has(ask.id), j([...h.withdrawn]))
  h.answer(ask.id, { outcome: 'allow', input: { late: true } })
  await settle(20)
  check('a late allow cannot change the denial or the parent', d.behavior === 'deny' && !parent.signal.aborted && h.asks.denyPendingPermissionRequests('late') === 0)
  h.closeHost()
}

section('R9 — the host closes the door while an ask is parked: the ask settles as a deny naming the closed door')
{
  const h = makeHarness()
  h.addHook(`sleep 2; echo '{}'`)
  const p = callCanUseTool(h)
  await h.waitAsk()
  h.closeHost()
  const d = await p
  check('the parked ask is denied with the exact door-closed cause, in the words of the host and the runner door', d.behavior === 'deny' && d.message === UNANSWERED_ASK_REJECT_MESSAGE(TOOL.name, DOOR_CLOSED_CAUSE) && DOOR_CLOSED_CAUSE === 'the host closed the runner door while the ask was pending', j(d))
  check('the closed door is a classified denial with the host-answer reason', isDenialResultText(d.message ?? '') && d.decisionReason?.type === 'permissionPromptTool' && d.decisionReason.permissionPromptToolName === TOOL.name)
  check('the runner peer is closed and nothing stays pending', h.runnerClosed() && h.asks.parkedAsks() === 0 && h.asks.pendingControlRequestCount() === 0)
}

section('N1 — the network ask rides permission/request {kind: network, host}; allow → true, deny → false, a closed door → false')
{
  const h = makeHarness()
  const sandboxAsk = h.asks.createSandboxAskCallback()
  const p1 = sandboxAsk({ host: 'example.com', port: 443 })
  const ask1 = await h.waitAsk()
  check('the ask is kind network carrying the host and never the port', ask1.params.kind === 'network' && ask1.params.host === 'example.com' && !('port' in ask1.params), j(ask1.params))
  h.answer(ask1.id, { outcome: 'allow' })
  check('allow → true', (await p1) === true)
  const p2 = sandboxAsk({ host: 'denied.example' })
  const ask2 = await new Promise<Ask>(resolve => {
    const poll = setInterval(() => {
      const next = h.hostSaw.find(a => a.params.host === 'denied.example')
      if (next) {
        clearInterval(poll)
        resolve(next)
      }
    }, 10)
  })
  h.answer(ask2.id, { outcome: 'deny', message: 'no network' })
  check('deny → false', (await p2) === false)
  check('the network ask parks like a tool ask while open and clears after the answer', h.asks.parkedAsks() === 0)
  h.closeHost()
  await settle(20)
  check('a closed door → false (fail closed)', (await sandboxAsk({ host: 'late.example' })) === false)
  check('network permission receipts identify SandboxNetworkAccess', SANDBOX_NETWORK_ACCESS_TOOL_NAME === 'SandboxNetworkAccess')
}

section('E1 — elicitation: answered cancel at once when the host declared none; forwarded as elicitation/request when it did')
{
  const silent = makeHarness({ elicitation: false })
  const t0 = Date.now()
  const answer = await silent.asks.handleElicitation('fixture-server', 'Which one?', { type: 'object' }, undefined, 'form')
  check('without the capability the answer is cancel, at once, and nothing reaches the host', answer.action === 'cancel' && Date.now() - t0 < 200 && silent.hostSaw.length === 0, j(answer))
  silent.closeHost()
  const spoken = makeHarness({ elicitation: true })
  const p = spoken.asks.handleElicitation('fixture-server', 'Which one?', { type: 'object', properties: { a: { type: 'string' } } }, undefined, 'form')
  const ask = await spoken.waitAsk()
  check('with the capability the question rides elicitation/request with the server, the message, the mode and the schema', ask.params.server === 'fixture-server' && ask.params.message === 'Which one?' && ask.params.mode === 'form' && typeof ask.params.schema === 'object', j(ask.params))
  spoken.answer(ask.id, { action: 'accept', content: { a: 'yes' } })
  const answered = await p
  check("the host's answer comes back as the MCP result", answered.action === 'accept' && j((answered as { content?: unknown }).content) === '{"a":"yes"}', j(answered))
  spoken.closeHost()
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ RUNNER ASKS LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} RUNNER ASKS LAW FAILURE(S)`)
process.exit(1)
