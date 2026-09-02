#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-call-reference.ts — the
//  per-call FROZEN capability/tool reference on model_call_started
//  (run-core/call-reference.ts; the Codex step-scoped-router law —
//  "execution must retain the finalized tool plan for that specific step").
//
//    §A the builder's pure laws — determinism, wire-order sensitivity,
//       membership/model/effort/override sensitivity, deep freeze,
//       sha256 digest form (the changeSetPlan planDigest precedent)
//    §B the REAL turn machine (runEventCore + injected fake model):
//       every model_call_started carries a frozen reference; the reference
//       names EXACTLY the tools the model call received; the catalogue
//       refresh lands at the turn boundary — the NEXT call's reference
//       changes, the in-flight call's never; digests reproduce from the
//       recorded inputs.
//
//  Seam: runEventCore driven directly (raw RunEvents observable — the
//  legacy projection is silent for model_call_started by design), fake
//  model via the query/deps.ts seam, real tool-orchestration path.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

// ── hermetic env (BEFORE any src import; ambient-state law) ─────────────────
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-callref-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'ctm-callref-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'ctm-callref-teams-'))
for (const k of [
  'MERCURY_SIMPLE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { runEventCore } = await import('../../src/run-core/turn-machine.ts')
const { buildModelCallReference } = await import('../../src/run-core/call-reference.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')

const MODEL = 'claude-opus-4-8'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — call-reference prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

section('§A builder laws — deterministic, order-sensitive, frozen')
{
  const tools = [{ name: 'Alpha' }, { name: 'Beta' }]
  const a = buildModelCallReference({ model: MODEL, effort: 'high', maxOutputTokensOverride: undefined, tools })
  const b = buildModelCallReference({ model: MODEL, effort: 'high', maxOutputTokensOverride: undefined, tools })
  check('identical inputs → identical digests', a.digest === b.digest && a.toolPlanDigest === b.toolPlanDigest)
  check('digest form: sha256 hex ×2', /^[0-9a-f]{64}$/.test(a.digest) && /^[0-9a-f]{64}$/.test(a.toolPlanDigest))
  const reversed = buildModelCallReference({ model: MODEL, effort: 'high', maxOutputTokensOverride: undefined, tools: [...tools].reverse() })
  check('tool ORDER is identity (wire order = cache identity)', reversed.toolPlanDigest !== a.toolPlanDigest && reversed.digest !== a.digest)
  const dropped = buildModelCallReference({ model: MODEL, effort: 'high', maxOutputTokensOverride: undefined, tools: tools.slice(0, 1) })
  check('tool MEMBERSHIP is identity', dropped.toolPlanDigest !== a.toolPlanDigest)
  const otherModel = buildModelCallReference({ model: 'gpt-5.2', effort: 'high', maxOutputTokensOverride: undefined, tools })
  check('model changes digest, not toolPlanDigest', otherModel.digest !== a.digest && otherModel.toolPlanDigest === a.toolPlanDigest)
  const otherEffort = buildModelCallReference({ model: MODEL, effort: 'max', maxOutputTokensOverride: undefined, tools })
  const numericEffort = buildModelCallReference({ model: MODEL, effort: 3, maxOutputTokensOverride: undefined, tools })
  check('effort (string or numeric intent) changes digest', otherEffort.digest !== a.digest && numericEffort.digest !== a.digest)
  const withOverride = buildModelCallReference({ model: MODEL, effort: 'high', maxOutputTokensOverride: 9000, tools })
  check('output-token override changes digest', withOverride.digest !== a.digest)
  check('reference deep-frozen (object + toolNames)', Object.isFrozen(a) && Object.isFrozen(a.toolNames))
  check('toolCount/toolNames coherent', a.toolCount === 2 && a.toolNames.join(',') === 'Alpha,Beta')
}

// ── §B rig: the real machine, fake model, tool-plan boundary refresh ────────

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'other', reason: 'rig' },
  }) as never

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ text: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    call: async (input: Record<string, unknown>) => ({ data: `echo:${(input?.text as string) ?? ''}` }),
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}

type CallRecord = { model: unknown; effort: unknown; override: unknown; toolNames: string[] }
type ModelStep = { kind: 'yield'; value: unknown }
const y = (value: unknown): ModelStep => ({ kind: 'yield', value })

function makeModel(script: ModelStep[][]): {
  calls: CallRecord[]
  callModel: (req: never) => AsyncGenerator<never, void>
} {
  const calls: CallRecord[] = []
  async function* callModel(req: {
    messages: unknown[]
    tools: Array<{ name: string }>
    options: Record<string, unknown>
  }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({
      model: req.options.model,
      effort: req.options.effortValue,
      override: req.options.maxOutputTokensOverride,
      toolNames: (req.tools ?? []).map(t => t.name),
    })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s.value as never
  }
  return { calls, callModel: callModel as never }
}

const asstText = (text: string): unknown => createAssistantMessage({ content: text })
function asstToolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input }] as never,
  })
}

section('§B the real machine — frozen per attempt, refresh lands at the boundary')
{
  const turn1Tools = [makeTool('EchoTool'), makeTool('DeltaTool')]
  const turn2Tools = [makeTool('EchoTool'), makeTool('DeltaTool'), makeTool('GammaTool')]
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const ctx: Record<string, unknown> = {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: turn1Tools,
      mainLoopModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      // The turn-boundary catalogue refresh (turn-machine close-of-turn):
      // hands the NEXT turn a bigger plan; the in-flight call keeps its own.
      refreshTools: () => turn2Tools,
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never) => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  const { calls, callModel } = makeModel([
    [y(asstToolUse('t1', 'EchoTool', { text: 'step one' }))],
    [y(asstText('done.'))],
  ])
  const gen = runEventCore(
    {
      messages: [createUserMessage({ content: 'drive the reference law' })],
      systemPrompt: ['rig system prompt'],
      userContext: {},
      systemContext: {},
      canUseTool: allowAll,
      toolUseContext: ctx,
      querySource: 'sdk',
      deps: {
        callModel: callModel as never,
        autocompact: (async () => ({ wasCompacted: false })) as never,
        microcompact: (async (messages: unknown[]) => ({ messages })) as never,
        uuid: (() => {
          let n = 0
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
        })(),
      },
    } as never,
    [],
  )
  const started: Array<Record<string, unknown>> = []
  let r = await gen.next()
  while (!r.done) {
    const e = r.value as Record<string, unknown>
    if (e.kind === 'model_call_started') started.push(e)
    r = await gen.next()
  }

  check('two turns → two model_call_started events', started.length === 2, String(started.length))
  const [c1, c2] = started as Array<{
    model: string
    effort: unknown
    maxOutputTokensOverride: number | undefined
    reference: {
      v: number
      model: string
      effortRequested: string | undefined
      maxOutputTokensOverride: number | undefined
      toolCount: number
      toolNames: readonly string[]
      toolPlanDigest: string
      digest: string
    }
  }>
  check('every attempt carries a reference', Boolean(c1?.reference) && Boolean(c2?.reference))
  if (c1?.reference && c2?.reference) {
    check(
      'references are frozen objects',
      Object.isFrozen(c1.reference) && Object.isFrozen(c1.reference.toolNames) && Object.isFrozen(c2.reference),
    )
    check(
      'call 1 reference names EXACTLY the tools the model received',
      c1.reference.toolNames.join(',') === calls[0]!.toolNames.join(','),
      `ref=[${c1.reference.toolNames.join(',')}] call=[${calls[0]!.toolNames.join(',')}]`,
    )
    check(
      'call 2 reference names EXACTLY the tools the model received',
      c2.reference.toolNames.join(',') === calls[1]!.toolNames.join(','),
      `ref=[${c2.reference.toolNames.join(',')}] call=[${calls[1]!.toolNames.join(',')}]`,
    )
    check(
      'the boundary refresh reaches the NEXT call only',
      c1.reference.toolNames.join(',') === 'EchoTool,DeltaTool' &&
        c2.reference.toolNames.join(',') === 'EchoTool,DeltaTool,GammaTool',
      `c1=[${c1.reference.toolNames.join(',')}] c2=[${c2.reference.toolNames.join(',')}]`,
    )
    check('plans differ → digests differ', c1.reference.toolPlanDigest !== c2.reference.toolPlanDigest)
    check(
      'reference agrees with the event envelope (model · effort intent)',
      c1.reference.model === c1.model &&
        (c1.effort === undefined
          ? c1.reference.effortRequested === undefined
          : c1.reference.effortRequested === String(c1.effort)),
    )
    const replay1 = buildModelCallReference({
      model: c1.model,
      effort: c1.effort as never,
      maxOutputTokensOverride: c1.maxOutputTokensOverride,
      tools: calls[0]!.toolNames.map(name => ({ name })),
    })
    check(
      'the digest reproduces from the recorded inputs (replay-stable)',
      replay1.digest === c1.reference.digest && replay1.toolPlanDigest === c1.reference.toolPlanDigest,
      `replay=${replay1.digest.slice(0, 12)} live=${c1.reference.digest.slice(0, 12)}`,
    )
  }
}

console.log(failures === 0 ? '\n ✅ PER-CALL FROZEN REFERENCE LAW HOLDS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
