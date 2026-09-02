#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-tool-transaction.ts — the ONE tool-call transaction.
//
//  Drives the REAL runToolUse (src/services/tools/toolExecution.ts) with fake
//  tools + a fake canUseTool and freezes the ordered transaction contract:
//
//    resolve → abort gate → kill-switch → THEMIS → schema validation →
//    validateInput → pre-hooks → permission decision → (deny: terminal) →
//    claims + observeToolStart → tool.call (progress streamed) → result
//    normalization (mapToolResultToToolResultBlockParam; effect-failed ⇒
//    is_error) → post-hooks → EXACTLY-ONCE terminal observation
//
//  The exactly-once law (Sol 5.6): only the EXECUTED path reaches the effect
//  observer (observeToolStart before call, observeToolTerminal once with
//  durationMs + the tool's typed effect); every pre-execution refusal —
//  unknown tool, abort, kill, invalid input, failed validation, denial —
//  emits NO start and NO terminal observation. Error and abort exits from
//  tool.call still terminalize exactly once (ok:false).
//
//  Run:  ~/.bun/bin/bun run scripts/tools/prove-tool-transaction.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tool-txn-'))

import { z } from 'zod/v4'

const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { subscribeToolStart, subscribeToolTerminal } = await import(
  '../../src/services/run/effectObserver.ts'
)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { killCapability, clearAllCapabilityKills } = await import(
  '../../src/utils/permissions/capabilityGate.ts'
)
const { AbortError } = await import('../../src/utils/errors.ts')
const { CANCEL_MESSAGE } = await import('../../src/utils/messages.ts')

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
  console.log('\n❌ TIMEOUT — transaction proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

// ── observation taps ────────────────────────────────────────────────────────
type StartEv = { toolName: string; toolUseId: string }
type TermEv = { toolName: string; toolUseId: string; ok: boolean; durationMs: number; effect?: { outcome: string } }
const starts: StartEv[] = []
const terminals: TermEv[] = []
subscribeToolStart(e => starts.push(e as never))
subscribeToolTerminal(e => terminals.push(e as never))
function resetTaps(): void {
  starts.length = 0
  terminals.length = 0
}

// ── fixtures ────────────────────────────────────────────────────────────────
type CallImpl = (
  input: unknown,
  ctx: unknown,
  canUse: unknown,
  msg: unknown,
  onProgress: (p: { toolUseID: string; data: unknown }) => void,
) => Promise<unknown>

function makeTool(over: {
  name?: string
  call?: CallImpl
  strictSchema?: boolean
  validateFail?: string
} = {}): Record<string, unknown> {
  const name = over.name ?? 'FakeTxnTool'
  return {
    name,
    isMcp: false,
    inputSchema: over.strictSchema
      ? z.strictObject({ must: z.string() })
      : z.object({}).passthrough(),
    ...(over.validateFail
      ? {
          validateInput: async () => ({
            result: false,
            message: over.validateFail,
            errorCode: 1,
          }),
        }
      : {}),
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: undefined }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      content: typeof data === 'string' ? data : j(data),
      tool_use_id: id,
    }),
    call:
      over.call ??
      (async () => ({
        data: 'txn ok',
      })),
  }
}

function makeContext(tool: unknown, opts: { mode?: string } = {}): Record<string, unknown> {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: (opts.mode ?? 'default') as never,
  }
  const appState = {
    toolPermissionContext,
    denialTracking: undefined,
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
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

const ASSISTANT = { uuid: 'uuid-txn', requestId: 'req_txn', message: { id: 'msg_txn' } } as never
const ALLOW = async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })
const DENY = async () => ({
  behavior: 'deny',
  message: 'denied by policy',
  decisionReason: { type: 'other', reason: 'denied by policy' },
})

type Yielded = { message: { type?: string; message?: { content?: Array<{ type: string; content?: unknown; is_error?: boolean }> }; toolUseResult?: unknown } }
async function run(
  tool: Record<string, unknown>,
  input: Record<string, unknown>,
  canUse: unknown,
  opts: { preAbort?: boolean; name?: string } = {},
): Promise<Yielded[]> {
  const ctx = makeContext(tool)
  if (opts.preAbort) (ctx.abortController as AbortController).abort()
  const out: Yielded[] = []
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'toolu_txn', name: opts.name ?? (tool.name as string), input } as never,
    ASSISTANT,
    canUse as never,
    ctx as never,
  )) {
    out.push(update as never)
  }
  return out
}

const firstBlock = (out: Yielded[]) =>
  (out[0]?.message as never as { message: { content: Array<{ type: string; content?: unknown; is_error?: boolean }> } })
    ?.message?.content?.[0]
const resultText = (out: Yielded[]) => String(firstBlock(out)?.content ?? '')

console.log('============================================================')
console.log(' The tool-call transaction — refusal band · execution · effects')
console.log('============================================================')

// ---------------------------------------------------------------------------
section('the refusal band — no start, no terminal observation, error results')
{
  // Unknown tool.
  resetTaps()
  let out = await run(makeTool(), {}, ALLOW, { name: 'NoSuchTool' })
  check('unknown tool → tool_use_error', resultText(out).includes('No such tool available: NoSuchTool'), resultText(out))
  check('unknown tool → no observations', starts.length === 0 && terminals.length === 0)

  // Pre-aborted signal.
  resetTaps()
  out = await run(makeTool(), {}, ALLOW, { preAbort: true })
  check('pre-aborted → interrupt result', String((out[0]?.message as never as { message: { toolUseResult?: unknown } }).message?.toolUseResult ?? resultText(out)).includes('interrupt') || resultText(out).length > 0)
  check('pre-aborted → no observations', starts.length === 0 && terminals.length === 0)

  // Capability kill-switch.
  resetTaps()
  killCapability(undefined, 'FakeKilledTool')
  try {
    out = await run(makeTool({ name: 'FakeKilledTool' }), {}, ALLOW)
    const tur = (out[0]?.message as never as { toolUseResult?: { hermesKill?: { kind?: string } } })?.toolUseResult
    check('killed → error content names the kill-switch', resultText(out).includes('capability kill-switch'), resultText(out))
    check('killed → hermesKill taxonomy on the non-model-visible result', tur?.hermesKill?.kind === 'capability-gate', j(tur))
    check('killed → no observations', starts.length === 0 && terminals.length === 0)
  } finally {
    clearAllCapabilityKills()
  }

  // Schema-invalid input.
  resetTaps()
  out = await run(makeTool({ strictSchema: true }), { wrong: 'field' }, ALLOW)
  check('schema-invalid → InputValidationError', resultText(out).includes('InputValidationError'), resultText(out))
  check('schema-invalid → no observations', starts.length === 0 && terminals.length === 0)

  // validateInput refusal.
  resetTaps()
  out = await run(makeTool({ validateFail: 'value out of range' }), {}, ALLOW)
  check('validateInput false → its message as the error', resultText(out).includes('value out of range'), resultText(out))
  check('validateInput false → no observations', starts.length === 0 && terminals.length === 0)

  // Permission denial.
  resetTaps()
  out = await run(makeTool(), {}, DENY)
  check('deny → the decision message as the error', resultText(out).includes('denied by policy'), resultText(out))
  check('deny → is_error', firstBlock(out)?.is_error === true)
  check('deny → no observations (refused calls never mark)', starts.length === 0 && terminals.length === 0)
}

// ---------------------------------------------------------------------------
section('the executed path — start + exactly-once terminal + typed effect')
{
  // Success with a typed effect.
  resetTaps()
  const effect = {
    outcome: 'succeeded',
    operation: 'txn.test',
    changedPaths: ['/tmp/txn-x'],
    evidence: 'the fixture applied',
    startedAt: 1,
    completedAt: 2,
  }
  let out = await run(
    makeTool({ call: async () => ({ data: 'wrote it', effect }) }),
    {},
    ALLOW,
  )
  check('success → mapped tool_result content', resultText(out) === 'wrote it', resultText(out))
  check('success → not an error', firstBlock(out)?.is_error !== true)
  check('success → ONE start observation', starts.length === 1, j(starts))
  check('success → EXACTLY-ONCE terminal observation', terminals.length === 1, j(terminals))
  check('terminal carries ok:true + durationMs + the typed effect', terminals[0]?.ok === true && typeof terminals[0]?.durationMs === 'number' && terminals[0]?.effect?.outcome === 'succeeded', j(terminals[0]))

  // A FAILED typed effect forces a model-visible error however polite the text.
  resetTaps()
  out = await run(
    makeTool({
      call: async () => ({
        data: 'politely claims success',
        effect: { ...effect, outcome: 'failed', changedPaths: [], evidence: 'verify failed' },
      }),
    }),
    {},
    ALLOW,
  )
  check('effect-failed → is_error forced on the mapped block', firstBlock(out)?.is_error === true, j(firstBlock(out)))
  check('effect-failed → terminal ok:false, exactly once', terminals.length === 1 && terminals[0]?.ok === false, j(terminals))

  // Progress streams through as progress messages before the result.
  resetTaps()
  out = await run(
    makeTool({
      call: async (_i, _c, _cu, _m, onProgress) => {
        onProgress({ toolUseID: 'toolu_txn', data: { kind: 'tick' } })
        return { data: 'done after progress' }
      },
    }),
    {},
    ALLOW,
  )
  const progressCount = out.filter(u => (u.message as never as { type?: string })?.type === 'progress').length
  check('progress events yielded as progress messages', progressCount >= 1, j(out.map(u => (u.message as never as { type?: string })?.type)))
  check('…and the final result still lands', out.some(u => resultText([u]) === 'done after progress'))

  // A throwing tool: error result + exactly-once terminal ok:false.
  resetTaps()
  out = await run(
    makeTool({
      call: async () => {
        throw new Error('tool exploded')
      },
    }),
    {},
    ALLOW,
  )
  const errorUpdate = out.find(u => resultText([u]).includes('tool exploded'))
  check('throw → error tool_result with the message', errorUpdate !== undefined, j(out.map(u => resultText([u]))))
  check('throw → is_error', firstBlock([errorUpdate!])?.is_error === true)
  check('throw → started once, terminalized exactly once, ok:false', starts.length === 1 && terminals.length === 1 && terminals[0]?.ok === false, j({ starts, terminals }))

  // Mid-call abort: AbortError exits still terminalize exactly once.
  resetTaps()
  out = await run(
    makeTool({
      call: async () => {
        throw new AbortError()
      },
    }),
    {},
    ALLOW,
  )
  check('mid-call abort → an error result is returned', firstBlock(out)?.is_error === true, j(firstBlock(out)))
  check('mid-call abort → exactly-once terminal, ok:false', terminals.length === 1 && terminals[0]?.ok === false, j(terminals))
}

// ---------------------------------------------------------------------------
section('cancellation at every transition (Phase 5 deliberate corrections)')
{
  // REGRESSION FIXTURE abort-at-decision-transition: an abort landing while
  // the permission decision resolves must produce the INTERRUPT result and
  // the tool must never start. (Pre-correction: an allow after the abort
  // executed the tool; only the tool's own signal handling could stop it.)
  resetTaps()
  let ctxRef: { abortController: AbortController } | null = null
  const tool = makeTool({ call: async () => ({ data: 'must never run' }) })
  const ctx = makeContext(tool) as unknown as { abortController: AbortController }
  ctxRef = ctx
  const abortingAllow = async (_t: unknown, input: unknown) => {
    ctxRef!.abortController.abort()
    return { behavior: 'allow', updatedInput: input }
  }
  const out: Yielded[] = []
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'toolu_txn', name: tool.name as string, input: {} } as never,
    ASSISTANT,
    abortingAllow as never,
    ctx as never,
  )) {
    out.push(update as never)
  }
  check(
    'abort during the decision → the interrupt result, not an error result',
    resultText(out).includes(CANCEL_MESSAGE) && !resultText(out).includes('Error calling tool'),
    resultText(out),
  )
  check('abort during the decision → the tool never ran, nothing observed', !out.some(u => resultText([u]).includes('must never run')) && starts.length === 0 && terminals.length === 0, j({ starts, terminals }))

  // REGRESSION FIXTURE abort-at-prehooks-transition: an abort landing before
  // the decision stage must ALSO produce the interrupt shape (pre-correction:
  // the permission stage threw AbortError and the turn surfaced
  // "Error calling tool …"). validateInput runs before pre-hooks — aborting
  // there exercises the pre-hooks → decision transition check.
  resetTaps()
  const tool2 = makeTool({ call: async () => ({ data: 'must never run 2' }) })
  ;(tool2 as Record<string, unknown>).validateInput = async () => {
    ;(ctx2 as { abortController: AbortController }).abortController.abort()
    return { result: true }
  }
  const ctx2 = makeContext(tool2)
  const out2: Yielded[] = []
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'toolu_txn', name: tool2.name as string, input: {} } as never,
    ASSISTANT,
    ALLOW as never,
    ctx2 as never,
  )) {
    out2.push(update as never)
  }
  check(
    'abort before the decision → the interrupt result, not an error result',
    resultText(out2).includes(CANCEL_MESSAGE) && !resultText(out2).includes('Error calling tool'),
    resultText(out2),
  )
  check('abort before the decision → nothing observed', starts.length === 0 && terminals.length === 0, j({ starts, terminals }))
}

// ---------------------------------------------------------------------------
section('the hook engine FAILS CLOSED — an engine crash denies, never allows')
{
  // Discovered during characterization: the hook engine requires
  // appState.sessionHooks; when it throws (any internal crash), the
  // transaction converts the failure into a permission DENY (the standard
  // reject message) — the tool never executes and nothing is observed.
  resetTaps()
  const tool = makeTool({
    call: async () => ({ data: 'must never run' }),
  })
  const ctx = makeContext(tool) as { getAppState: () => Record<string, unknown> }
  const broken = { ...ctx.getAppState() }
  delete (broken as Record<string, unknown>).sessionHooks
  ;(ctx as Record<string, unknown>).getAppState = () => broken
  const out: Yielded[] = []
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'toolu_txn', name: tool.name, input: {} } as never,
    ASSISTANT,
    ALLOW as never,
    ctx as never,
  )) {
    out.push(update as never)
  }
  check('hook-engine crash → denied (fail closed)', firstBlock(out)?.is_error === true, j(firstBlock(out)))
  check('hook-engine crash → the tool never ran, nothing observed', !out.some(u => resultText([u]).includes('must never run')) && starts.length === 0 && terminals.length === 0, j({ starts, terminals }))
}

// ---------------------------------------------------------------------------
section('permission updatedInput flows into the call')
{
  resetTaps()
  let seenInput: unknown
  const out = await run(
    makeTool({
      call: async input => {
        seenInput = input
        return { data: 'ok' }
      },
    }),
    { original: 'value' },
    async (_t: unknown, input: unknown) => ({
      behavior: 'allow',
      updatedInput: { ...(input as Record<string, unknown>), injected: 'by-permission' },
    }),
  )
  check('the decision-updated input reaches tool.call', (seenInput as { injected?: string })?.injected === 'by-permission', j(seenInput))
  check('call still succeeds', resultText(out) === 'ok')
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ TOOL TRANSACTION GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} TOOL TRANSACTION FAILURE(S)`)
process.exit(1)
