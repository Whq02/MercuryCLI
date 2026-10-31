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

function makeTool(over: { name?: string; behavior?: 'passthrough' | 'ask' | 'allow'; askRule?: boolean; path?: string } = {}): unknown {
  const name = over.name ?? 'FakeTool'
  const reason = over.askRule ? { decisionReason: { type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: name } } } } : {}
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => false,
    ...(over.path === undefined ? {} : { getPath: () => over.path }),
    checkPermissions: async (input: unknown) =>
      over.behavior === 'ask'
        ? { behavior: 'ask', message: 'plain ask', ...reason }
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

section('the Flow band — the kept floors, the five, then allow')
{
  const FLOW_WALK = ['flowFloors', 'flowLaw', 'flowAllow']
  check('no port asks a model for the decision; the only port left is the headless hook band', !('classify' in defaultWrapperPorts) && Object.keys(defaultWrapperPorts).sort().join(',') === 'runHeadlessHooks', Object.keys(defaultWrapperPorts).join(','))
  check('the stage order carries no verdict stage, no denial ledger stage and no shortcut stage', !(WRAPPER_STAGE_ORDER as readonly string[]).some(s => /classif|denial|FastPath|Guard|Immunity/i.test(s)), j(WRAPPER_STAGE_ORDER))

  let r = await run(makeTool({ behavior: 'ask' }), makeContext({ mode: 'flow' }), makePorts({}))
  check("flow: a plain ask none of the five name → allow, decided by flowAllow with the mode as its reason", r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'flowAllow' && r.decision.decisionReason?.type === 'mode', j(r))
  check('flow: the two floors were consulted and passed before the allow', r.wrapper.stages.map(s => s.stage).join(',') === FLOW_WALK.join(',') && r.wrapper.stages.slice(0, 2).every(s => s.outcome === 'pass'), j(r.wrapper))
  checkSubsequenceLaw('flow allow', r.wrapper)

  r = await run(makeTool({ behavior: 'ask', askRule: true }), makeContext({ mode: 'flow' }), makePorts({}))
  check("flow: the operator's ask rule is a kept floor → the engine's ask stands, decided by flowFloors", r.decision.behavior === 'ask' && r.wrapper.decidedBy === 'flowFloors' && r.decision.decisionReason?.type === 'rule', j(r))
  checkSubsequenceLaw('flow floor', r.wrapper)

  r = await run(makeTool({ behavior: 'ask', path: '/etc/hosts' }), makeContext({ mode: 'flow' }), makePorts({}))
  check('flow: a write outside the project is item 4 → ask in one sentence, decided by flowLaw', r.decision.behavior === 'ask' && r.wrapper.decidedBy === 'flowLaw' && r.decision.message === 'Flow asks before writing /etc/hosts: it is outside the project.' && r.decision.decisionReason?.type === 'other', j(r))
  check('flow: the floors passed before the law decided', r.wrapper.stages.map(s => `${s.stage}:${s.outcome}`).join(',') === 'flowFloors:pass,flowLaw:decided', j(r.wrapper))
  checkSubsequenceLaw('flow law', r.wrapper)

  r = await run(makeTool({ behavior: 'ask', path: '/etc/hosts' }), makeContext({ mode: 'flow', avoidPrompts: true }), makePorts({}))
  check('flow + prompt-less: the five\'s ask becomes the headless auto-deny, the sentence first, after a silent hook band', r.decision.behavior === 'deny' && r.decision.decisionReason?.type === 'asyncAgent' && r.wrapper.decidedBy === 'headlessAutoDeny' && (r.decision.message ?? '').startsWith('Flow asks before writing /etc/hosts: it is outside the project.') && r.wrapper.stages.some(s => s.stage === 'headlessHooks' && s.outcome === 'pass'), j(r))
  checkSubsequenceLaw('flow law headless', r.wrapper)

  r = await run(makeTool({ behavior: 'ask' }), makeContext({ mode: 'flow', avoidPrompts: true }), makePorts({}))
  check('flow + prompt-less: a plain ask still runs (none of the five)', r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'flowAllow', j(r))

  r = await run(
    makeTool({ behavior: 'ask', path: '/etc/hosts' }),
    makeContext({ mode: 'flow', avoidPrompts: true }),
    makePorts({ runHeadlessHooks: async () => ({ behavior: 'allow', updatedInput: {}, decisionReason: { type: 'hook', hookName: 'PermissionRequest' } }) as never }),
  )
  check('flow + prompt-less + hook allow on one of the five → decidedBy headlessHooks', r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'headlessHooks', j(r.wrapper))

  r = await run(makeTool({ behavior: 'allow' }), makeContext({ mode: 'flow' }), makePorts({}))
  check("flow engine allow → decidedBy 'engine', no wrapper stage consulted", r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'engine' && r.wrapper.stages.length === 0, j(r.wrapper))

  r = await run(makeTool({ behavior: 'passthrough' }), makeContext({ mode: 'flow' }), makePorts({}))
  check('flow: a tool with no opinion runs (the engine\'s ask is none of the five)', r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'flowAllow', j(r))
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
