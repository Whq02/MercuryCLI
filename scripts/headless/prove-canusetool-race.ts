#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'race-laws-'))
delete process.env.MERCURY_SIMPLE

import { z } from 'zod/v4'

const { StructuredIO } = await import('../../src/cli/structuredIO.ts')
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

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — canUseTool race laws exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()


function makeInput(): {
  iterable: AsyncIterable<string>
  push: (block: string) => void
  end: () => void
} {
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

const SESSION_ID = 'race-probe-agent'

type Harness = {
  io: InstanceType<typeof StructuredIO>
  ctx: Record<string, unknown>
  state: () => Record<string, unknown>
  push: (o: unknown) => void
  end: () => void
  outbound: Array<Record<string, unknown>>
  addHook: (command: string) => void
  waitOutbound: <T>(pick: () => T | undefined) => Promise<T>
}

function makeHarness(opts: { allow?: string[]; deny?: string[] } = {}): Harness {
  const input = makeInput()
  const io = new StructuredIO(input.iterable)
  const outbound: Array<Record<string, unknown>> = []
  void (async () => {
    for await (const m of io.outbound) {
      outbound.push(m as Record<string, unknown>)
    }
  })()
  void (async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of io.structuredInput) {
    }
  })()

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
    io,
    ctx,
    state: () => state,
    push: o => input.push(JSON.stringify(o) + '\n'),
    end: () => input.end(),
    outbound,
    addHook: (command: string) => {
      addSessionHook(
        setAppState as never,
        SESSION_ID,
        'PermissionRequest',
        'RaceProbeTool',
        { type: 'command', command } as never,
      )
    },
    waitOutbound: async <T,>(pick: () => T | undefined): Promise<T> => {
      const deadline = Date.now() + 5_000
      for (;;) {
        const v = pick()
        if (v !== undefined) return v
        if (Date.now() > deadline) throw new Error('waitOutbound timed out')
        await new Promise(r => setTimeout(r, 10))
      }
    },
  }
}

const TOOL = {
  name: 'RaceProbeTool',
  inputSchema: z.object({}).passthrough(),
  checkPermissions: async () => ({ behavior: 'ask', message: 'plain ask' }),
}
const ASSISTANT = { message: { id: 'msg_race' } } as never

type Decision = {
  behavior: string
  message?: string
  updatedInput?: Record<string, unknown>
  decisionReason?: { type?: string; hookName?: string; permissionPromptToolName?: string }
}

function callCanUseTool(h: Harness, input: Record<string, unknown> = { probe: 'original' }): Promise<Decision> {
  const canUseTool = h.io.createCanUseTool()
  return canUseTool(TOOL as never, input, h.ctx as never, ASSISTANT, 'toolu_race') as never
}

const hookJson = (decision: Record<string, unknown>): string =>
  j({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })

const canUseToolFrame = (h: Harness): (Record<string, unknown> & { request_id?: string }) | undefined =>
  h.outbound.find(m => m.type === 'control_request' && j(m).includes('can_use_tool')) as never

const cancelFrame = (h: Harness): Record<string, unknown> | undefined =>
  h.outbound.find(m => m.type === 'control_cancel_request')

console.log('============================================================')
console.log(' createCanUseTool — the hook-vs-SDK race laws')
console.log('============================================================')

section('R1 — an owned-chain allow/deny short-circuits: no SDK frame, hooks never run')
{
  const marker = join(mkdtempSync(join(tmpdir(), 'race-marker-')), 'hook-fired')
  const h = makeHarness({ allow: ['RaceProbeTool'] })
  h.addHook(`touch ${marker}; echo '${hookJson({ behavior: 'deny', message: 'must never run' })}'`)
  const d = await callCanUseTool(h)
  check('the rule-allow returns directly', d.behavior === 'allow', j(d))
  await new Promise(r => setTimeout(r, 150))
  check('NO can_use_tool control_request went out', canUseToolFrame(h) === undefined, j(h.outbound.map(m => m.type)))
  check('the PermissionRequest hook NEVER fired', !existsSync(marker))
  h.end()
}

section('R2 — the hook denies first: hook decision wins, the SDK request is CANCELLED')
{
  const h = makeHarness()
  h.addHook(`echo '${hookJson({ behavior: 'deny', message: 'hook fixture deny' })}'`)
  const d = await callCanUseTool(h)
  check('the decision is the HOOK deny', d.behavior === 'deny' && (d.message ?? '').includes('hook fixture deny'), j(d))
  check("decisionReason is {type:'hook', hookName:'PermissionRequest'}", d.decisionReason?.type === 'hook' && d.decisionReason?.hookName === 'PermissionRequest', j(d.decisionReason))
  check('the SDK prompt DID go out before the hook won', canUseToolFrame(h) !== undefined)
  await h.waitOutbound(() => cancelFrame(h))
  const cancel = cancelFrame(h)
  check('the losing SDK request is cancelled (control_cancel_request)', cancel !== undefined && j(cancel).includes(String(canUseToolFrame(h)?.request_id)), j(h.outbound.map(m => m.type)))
  h.end()
}

section('R3 — the hook allows first: updatedInput carries, the SDK request is cancelled')
{
  const h = makeHarness()
  h.addHook(`echo '${hookJson({ behavior: 'allow', updatedInput: { via: 'hook' } })}'`)
  const d = await callCanUseTool(h)
  check('the decision is the HOOK allow', d.behavior === 'allow', j(d))
  check('the hook updatedInput carries', j(d.updatedInput) === '{"via":"hook"}', j(d.updatedInput))
  check("decisionReason is {type:'hook'}", d.decisionReason?.type === 'hook', j(d.decisionReason))
  await h.waitOutbound(() => cancelFrame(h))
  check('the losing SDK request is cancelled', cancelFrame(h) !== undefined)
  h.end()
}

section('R4 — a no-decision hook defers to the SDK; empty updatedInput falls back to the original')
{
  const h = makeHarness()
  h.addHook(`echo '{}'`)
  const p = callCanUseTool(h, { probe: 'original' })
  const frame = await h.waitOutbound(() => canUseToolFrame(h))
  h.push({
    type: 'control_response',
    response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updatedInput: {} } },
  })
  const d = await p
  check('the SDK allow lands after the hook passed through', d.behavior === 'allow', j(d))
  check('an EMPTY SDK updatedInput falls back to the ORIGINAL input (the mobile-client law)', j(d.updatedInput) === '{"probe":"original"}', j(d.updatedInput))
  check("decisionReason is {type:'permissionPromptTool'}", d.decisionReason?.type === 'permissionPromptTool', j(d.decisionReason))
  h.end()
}

section('R5 — the SDK answers while the hook still runs: the SDK wins, the hook is ignored')
{
  const h = makeHarness()
  h.addHook(`sleep 2; echo '${hookJson({ behavior: 'allow', updatedInput: { via: 'late-hook' } })}'`)
  const started = Date.now()
  const p = callCanUseTool(h)
  const frame = await h.waitOutbound(() => canUseToolFrame(h))
  h.push({
    type: 'control_response',
    response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'deny', message: 'sdk fixture deny' } },
  })
  const d = await p
  check('the SDK deny wins the race', d.behavior === 'deny' && (d.message ?? '').includes('sdk fixture deny'), j(d))
  check('…without waiting out the still-running hook', Date.now() - started < 1_500, `${Date.now() - started}ms`)
  check("decisionReason is {type:'permissionPromptTool'} (not the late hook)", d.decisionReason?.type === 'permissionPromptTool', j(d.decisionReason))
  h.end()
}

section('R6 — an SDK deny with interrupt:true aborts the parent turn controller')
{
  const h = makeHarness()
  h.addHook(`sleep 2; echo '{}'`)
  const p = callCanUseTool(h)
  const frame = await h.waitOutbound(() => canUseToolFrame(h))
  h.push({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: frame.request_id,
      response: { behavior: 'deny', message: 'sdk interrupt deny', interrupt: true },
    },
  })
  const d = await p
  check('the deny lands', d.behavior === 'deny', j(d))
  check('the PARENT abort controller is aborted (deny+interrupt)', (h.ctx.abortController as AbortController).signal.aborted)
  h.end()
}

section('R7 — a parent abort mid-race cancels the SDK request and fails CLOSED')
{
  const h = makeHarness()
  h.addHook(`sleep 2; echo '{}'`)
  const p = callCanUseTool(h)
  await h.waitOutbound(() => canUseToolFrame(h))
  ;(h.ctx.abortController as AbortController).abort()
  const d = await p
  check("the band fails CLOSED: deny 'Tool permission request failed…'", d.behavior === 'deny' && (d.message ?? '').startsWith('Tool permission request failed'), j(d))
  await h.waitOutbound(() => cancelFrame(h))
  check('the pending SDK request is cancelled on the wire', cancelFrame(h) !== undefined, j(h.outbound.map(m => m.type)))
  h.end()
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ CANUSETOOL RACE LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} CANUSETOOL RACE LAW FAILURE(S)`)
process.exit(1)
