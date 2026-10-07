#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'decision-wrapper-'))

import { z } from 'zod/v4'

const { decideToolPermissionWithModes, defaultWrapperPorts } = await import(
  '../../src/utils/permissions/decision/wrapper.ts'
)
const { WRAPPER_STAGE_ORDER } = await import(
  '../../src/utils/permissions/decision/trace.ts'
)
const { hasPermissionsToUseTool } = await import(
  '../../src/utils/permissions/permissions.ts'
)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

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
  console.log('\n❌ TIMEOUT — wrapper proof exceeded 60s (a row reached a live API path?)')
  process.exit(1)
}, 60_000)
guard.unref?.()

function makeTool(over: { name?: string; behavior?: 'passthrough' | 'ask' | 'allow' } = {}): unknown {
  const name = over.name ?? 'FakeTool'
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async (input: unknown) =>
      over.behavior === 'ask'
        ? { behavior: 'ask', message: 'plain ask' }
        : over.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'passthrough', message: 'no opinion' },
  }
}

function makeContext(opts: {
  mode?: string
  avoidPrompts?: boolean
} = {}): unknown {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: (opts.mode ?? 'flow') as never,
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...(opts.avoidPrompts ? { shouldAvoidPermissionPrompts: true } : {}),
  }
  const appState = { toolPermissionContext }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    options: {},
  }
}

const ASSISTANT = { message: { id: 'msg_wrapper' } } as never

type Ports = typeof defaultWrapperPorts
function makePorts(over: Partial<Ports>): Ports {
  return {
    ...defaultWrapperPorts,
    isAllowlistedTool: () => false,
    resolveAcceptEditsVerdict: async () => ({ behavior: 'ask', message: 'still ask' }),
    runHeadlessHooks: async () => null,
    ...over,
  }
}

type Outcome = {
  decision: { behavior: string; message?: string; decisionReason?: { type?: string; reason?: string } }
  engineTrace: { decidedBy: string }
  wrapper: { stages: Array<{ stage: string; outcome: string; note?: string }>; decidedBy: string }
}
const run = (tool: unknown, ctx: unknown, ports: Ports): Promise<Outcome> =>
  decideToolPermissionWithModes(tool as never, {}, ctx as never, ASSISTANT, 'toolu_wrapper', ports) as never

function checkSubsequenceLaw(label: string, wrapper: Outcome['wrapper']): void {
  const order = WRAPPER_STAGE_ORDER as readonly string[]
  let cursor = -1
  let inOrder = true
  for (const s of wrapper.stages) {
    const idx = order.indexOf(s.stage)
    if (idx <= cursor) inOrder = false
    cursor = idx
  }
  const decidedRecords = wrapper.stages.filter(s => s.outcome === 'decided')
  const last = wrapper.stages[wrapper.stages.length - 1]
  const terminalOk =
    wrapper.decidedBy === 'engine'
      ? decidedRecords.length === 0
      : decidedRecords.length === 1 && last?.stage === wrapper.decidedBy && last?.outcome === 'decided'
  check(`${label} — wrapper subsequence law`, inOrder && terminalOk, j(wrapper))
}

console.log('============================================================')
console.log(' Mode-wrapper band — ports, the leftover, trace')
console.log('============================================================')

section('the leftover — an ask no floor and no shortcut settles is the operator\'s')
{
  const FLOW_WALK = ['autoSafetyImmunity', 'autoUserInteraction', 'autoFloors', 'powershellGuard', 'fastPathDangerFilter', 'implementFastPath', 'allowlistFastPath']
  check('no port asks a model for the decision', !('classify' in defaultWrapperPorts) && Object.keys(defaultWrapperPorts).sort().join(',') === 'isAllowlistedTool,resolveAcceptEditsVerdict,runHeadlessHooks', Object.keys(defaultWrapperPorts).join(','))
  check('the stage order carries no verdict stage and no denial ledger stage', !(WRAPPER_STAGE_ORDER as readonly string[]).some(s => /classif|denial/i.test(s)), j(WRAPPER_STAGE_ORDER))

  let r = await run(makeTool({ behavior: 'ask' }), makeContext({ mode: 'flow' }), makePorts({}))
  check("flow leftover → the engine's ask passes through (decidedBy 'engine')", r.decision.behavior === 'ask' && r.wrapper.decidedBy === 'engine' && r.decision.message === 'plain ask' && r.decision.decisionReason === undefined, j(r))
  check('flow leftover → every floor and both shortcuts were consulted and passed', r.wrapper.stages.map(s => s.stage).join(',') === FLOW_WALK.join(',') && r.wrapper.stages.every(s => s.outcome === 'pass'), j(r.wrapper))
  checkSubsequenceLaw('flow leftover', r.wrapper)

  r = await run(makeTool({ behavior: 'ask' }), makeContext({ mode: 'flow', avoidPrompts: true }), makePorts({}))
  check('flow leftover + prompt-less → the headless auto-deny (asyncAgent) after a silent hook band', r.decision.behavior === 'deny' && r.decision.decisionReason?.type === 'asyncAgent' && r.wrapper.decidedBy === 'headlessAutoDeny' && r.wrapper.stages.some(s => s.stage === 'headlessHooks' && s.outcome === 'pass'), j(r))
  checkSubsequenceLaw('flow leftover headless', r.wrapper)
  const asDefault = await run(makeTool({ behavior: 'ask' }), makeContext({ mode: 'default', avoidPrompts: true }), makePorts({}))
  check('…the same decision default mode gives a prompt-less ask', j(r.decision) === j(asDefault.decision), j({ flow: r.decision, byDefault: asDefault.decision }))

  r = await run(
    makeTool({ behavior: 'ask' }),
    makeContext({ mode: 'flow', avoidPrompts: true }),
    makePorts({ runHeadlessHooks: async () => ({ behavior: 'allow', updatedInput: {}, decisionReason: { type: 'hook', hookName: 'PermissionRequest' } }) as never }),
  )
  check('flow leftover + prompt-less + hook allow → decidedBy headlessHooks', r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'headlessHooks', j(r.wrapper))

  r = await run(makeTool({ behavior: 'allow' }), makeContext({ mode: 'flow' }), makePorts({}))
  check("flow engine allow → decidedBy 'engine', no wrapper stage consulted", r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'engine' && r.wrapper.stages.length === 0, j(r.wrapper))
}

section('fast-path ports')
{
  let r = await run(
    makeTool(),
    makeContext({ mode: 'flow' }),
    makePorts({ resolveAcceptEditsVerdict: async () => ({ behavior: 'allow', updatedInput: { via: 'port' } }) }),
  )
  check(
    'implement port allow → mode-flow allow',
    r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'implementFastPath',
    j({ decision: r.decision, decidedBy: r.wrapper.decidedBy }),
  )
  checkSubsequenceLaw('implement fast-path', r.wrapper)

  r = await run(makeTool(), makeContext({ mode: 'flow' }), makePorts({ isAllowlistedTool: () => true }))
  check(
    'allowlist port → mode-flow allow',
    r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'allowlistFastPath',
    j({ decision: r.decision, decidedBy: r.wrapper.decidedBy }),
  )

}

section('the headless hook band')
{
  let r = await run(
    makeTool(),
    makeContext({ mode: 'default', avoidPrompts: true }),
    makePorts({ runHeadlessHooks: async () => ({ behavior: 'allow', updatedInput: {}, decisionReason: { type: 'hook', hookName: 'PermissionRequest' } }) as never }),
  )
  check('hook allow → decidedBy headlessHooks', r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'headlessHooks', j(r.wrapper))

  r = await run(
    makeTool(),
    makeContext({ mode: 'default', avoidPrompts: true }),
    makePorts({ runHeadlessHooks: async () => ({ behavior: 'deny', message: 'hook says no', decisionReason: { type: 'hook', hookName: 'PermissionRequest' } }) as never }),
  )
  check('hook deny → deny', r.decision.behavior === 'deny' && r.decision.message === 'hook says no', j(r.decision))

  r = await run(makeTool(), makeContext({ mode: 'default', avoidPrompts: true }), makePorts({}))
  check(
    'no hook decision → asyncAgent auto-deny',
    r.decision.behavior === 'deny' && r.decision.decisionReason?.type === 'asyncAgent',
    j(r.decision),
  )
  check('auto-deny → decidedBy headlessAutoDeny after a headlessHooks pass', r.wrapper.decidedBy === 'headlessAutoDeny' && r.wrapper.stages.some(s => s.stage === 'headlessHooks' && s.outcome === 'pass'), j(r.wrapper))
  checkSubsequenceLaw('headless auto-deny', r.wrapper)
}

section('pass-through identity + public-entry parity (default ports)')
{
  const r = await run(makeTool(), makeContext({ mode: 'default' }), makePorts({}))
  check("default mode ask → decidedBy 'engine', no wrapper stages consulted", r.wrapper.decidedBy === 'engine' && r.wrapper.stages.length === 0, j(r.wrapper))

  for (const mode of ['default', 'sovereign', 'dontAsk']) {
    const a = await run(makeTool(), makeContext({ mode }), defaultWrapperPorts)
    const b = await (hasPermissionsToUseTool as never as (...x: unknown[]) => Promise<unknown>)(
      makeTool(),
      {},
      makeContext({ mode }),
      ASSISTANT,
      'toolu_wrapper',
    )
    check(`${mode}: hasPermissionsToUseTool === wrapper decision`, j(b) === j(a.decision), j({ a: a.decision, b }))
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ DECISION WRAPPER GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} DECISION WRAPPER FAILURE(S)`)
process.exit(1)
