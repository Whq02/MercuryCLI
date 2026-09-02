#!/usr/bin/env bun
// ============================================================================
//  scripts/stop-policy/prove-supervisor-gate.ts
//  PROOF: the run-completion supervisor — gate law, armed/disarmed behavior,
//  and the failure posture.
//
//  §1 the gate: OFF by default; /supervisor persists the toggle; the
//     MERCURY_SUPERVISOR env pin wins in BOTH directions and is read live.
//  §2 disarmed: the stop hook is a pure pass-through (true, instantly),
//     before any evaluator machinery runs.
//  §3 armed posture (supervisedStopVerdict — injectable evaluator/deadline,
//     the REAL production code path):
//       allow      → true
//       continue   → the re-prompt string (voice + next action + the typed
//                    blocker escape), with evaluator fields BOUNDED
//       error      → throws the supervisor-named error (fail-open + visible:
//                    the hook executor turns a throw into a visible notice
//                    and the stop stands)
//       hang       → the supervisor's own deadline throws the same class
//                    BEFORE the harness's silent 'cancelled' could swallow it
//  §4 the surrounding harness, pinned: executeFunctionHook maps a THROW to
//     non_blocking_error WITH a visible attachment (never a block), a string
//     to a blocking error carrying the silent flag, and an expired hook
//     timeout to a silent 'cancelled' — the class the supervisor's tighter
//     deadline exists to preempt (deadline < hook timeout, pinned).
//
//  Run: ~/.bun/bin/bun run scripts/stop-policy/prove-supervisor-gate.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'supervisor-gate-'))
delete process.env.MERCURY_SUPERVISOR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures = 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' supervisor gate — default off, env pin, failure posture')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const gate = await import('../../src/utils/hooks/supervisorGate.ts')
const hook = await import('../../src/utils/hooks/runStopHook.ts')
const adapter = await import('../../src/utils/hooks/runStopAdapter.ts')

// ─────────────────────────────────────────────────────────────────────────
section('§1 the gate law — default off · persisted toggle · live env pin')
// ─────────────────────────────────────────────────────────────────────────
{
  check('fresh config home: the supervisor is OFF', gate.supervisorEnabled() === false)

  gate.setSupervisorEnabled(true)
  check('/supervisor on persists and reads back', gate.supervisorEnabled() === true)

  process.env.MERCURY_SUPERVISOR = '0'
  check('env pin OFF beats the saved ON toggle', gate.supervisorEnabled() === false)

  process.env.MERCURY_SUPERVISOR = '1'
  gate.setSupervisorEnabled(false)
  check('env pin ON beats the saved OFF toggle', gate.supervisorEnabled() === true)

  delete process.env.MERCURY_SUPERVISOR
  check('pin removed: the persisted toggle decides again (off)', gate.supervisorEnabled() === false)
}

// ─────────────────────────────────────────────────────────────────────────
section('§2 disarmed — the registered hook is a pure pass-through')
// ─────────────────────────────────────────────────────────────────────────
{
  hook._resetRunStopHookForTesting()
  // Capture the registered FunctionHook through a recording setAppState.
  type Registered = { hooks: Array<{ hook: { callback: (m: never[], s?: AbortSignal) => Promise<boolean | string>; timeout?: number; silent?: boolean; id?: string } }> }
  const state: Record<string, unknown> = {
    sessionHooks: new Map<string, unknown>(),
  }
  const setAppState = (update: unknown): void => {
    if (typeof update === 'function') {
      const next = (update as (prev: Record<string, unknown>) => Record<string, unknown>)(state)
      Object.assign(state, next)
    }
  }
  const id = hook.registerRunStopHook(setAppState as never, 'proof-session')
  check('registration returns the stable hook id', id === hook.RUN_STOP_HOOK_ID)

  // Find the registered hook wherever the session-hooks shape put it.
  const found: Array<{ callback: (m: never[], s?: AbortSignal) => Promise<boolean | string>; timeout?: number; silent?: boolean; id?: string }> = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (node instanceof Map) {
      for (const value of node.values()) walk(value)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const rec = node as Record<string, unknown>
    if (typeof rec.callback === 'function' && rec.id === hook.RUN_STOP_HOOK_ID) {
      found.push(rec as never)
      return
    }
    for (const value of Object.values(rec)) walk(value)
  }
  walk(state)
  check('the hook registered exactly once', found.length === 1, String(found.length))
  const registered = found[0]
  check('registered with the 30s executor ceiling', registered?.timeout === hook.RUN_STOP_HOOK_TIMEOUT_MS)
  check('registered silent (blocks re-prompt the model, never paint the transcript)', registered?.silent === true)
  check(
    'the supervisor deadline sits STRICTLY under the executor ceiling',
    hook.SUPERVISOR_EVALUATOR_DEADLINE_MS < hook.RUN_STOP_HOOK_TIMEOUT_MS,
  )

  delete process.env.MERCURY_SUPERVISOR
  gate.setSupervisorEnabled(false)
  const started = Date.now()
  const verdict = registered ? await registered.callback([]) : 'unreached'
  check('disarmed: every stop passes untouched (true)', verdict === true)
  check('disarmed: instantly — no evaluator machinery ran', Date.now() - started < 1_000)
}

// ─────────────────────────────────────────────────────────────────────────
section('§3 armed posture — verdict mapping, bounded output, fail-open')
// ─────────────────────────────────────────────────────────────────────────
{
  const allow = await hook.supervisedStopVerdict([], undefined, async () => ({
    allowStop: true,
    decision: { kind: 'complete', satisfied: ['done'] },
  }) as never)
  check('allowStop verdict maps to true (the stop stands)', allow === true)

  const cont = await hook.supervisedStopVerdict([], undefined, async () => ({
    allowStop: false,
    decision: { kind: 'continue', nextAction: 'finish task 3', reason: 'open deliverables' },
  }) as never)
  check('continue verdict maps to the re-prompt string', typeof cont === 'string')
  if (typeof cont === 'string') {
    check('…in the supervisor voice', cont.startsWith(hook.RUN_STOP_REPROMPT))
    check('…carrying the concrete next action', cont.includes('Next concrete action: finish task 3'))
    check('…teaching the typed blocker escape', cont.includes('BLOCKED(') || /blocker/i.test(cont))
    check('…and the never-bypass-gates clause', cont.includes('Never bypass a permission, approval,'))
  }

  const huge = await hook.supervisedStopVerdict([], undefined, async () => ({
    allowStop: false,
    decision: { kind: 'continue', nextAction: 'y'.repeat(100_000), reason: 'z'.repeat(100_000) },
  }) as never)
  check(
    'evaluator fields are BOUNDED on the way into the re-prompt',
    typeof huge === 'string' && huge.length < hook.RUN_STOP_REPROMPT.length + 4 * adapter.REPROMPT_FIELD_BUDGET,
    typeof huge === 'string' ? String(huge.length) : typeof huge,
  )

  let threw: unknown = null
  try {
    await hook.supervisedStopVerdict([], undefined, async () => {
      throw new Error('store exploded')
    })
  } catch (error) {
    threw = error
  }
  check('an evaluator ERROR throws the supervisor-named error', threw instanceof Error && threw.message.includes('run-completion supervisor failed'))
  check('…naming the fail-open outcome plainly', threw instanceof Error && threw.message.includes('stop proceeded unchecked'))

  let hung: unknown = null
  const t0 = Date.now()
  try {
    await hook.supervisedStopVerdict(
      [],
      undefined,
      () => new Promise(() => {}),
      120, // injected tiny deadline — the REAL race, provable in prover time
    )
  } catch (error) {
    hung = error
  }
  check('a HUNG evaluator hits the supervisor deadline', hung instanceof Error && hung.message.includes('supervisor timed out'))
  check('…within the deadline order of magnitude', Date.now() - t0 < 5_000)
  check('…also naming the fail-open outcome', hung instanceof Error && hung.message.includes('stop proceeded unchecked'))
}

// ─────────────────────────────────────────────────────────────────────────
section('§4 the surrounding harness — executor posture pinned')
// ─────────────────────────────────────────────────────────────────────────
{
  const { executeFunctionHook } = await import('../../src/utils/hooks/engine.ts')
  const base = {
    messages: [] as never[],
    hookName: 'proof',
    toolUseID: 'proof-tool-use',
    hookEvent: 'Stop' as never,
    timeoutMs: 5_000,
  }

  const thrown = await executeFunctionHook({
    ...base,
    hook: {
      type: 'function',
      id: 'proof-throw',
      timeout: 5_000,
      silent: true,
      errorMessage: 'unused',
      callback: async () => {
        throw new Error('the run-completion supervisor failed (proof) — this stop proceeded unchecked')
      },
    } as never,
  } as never)
  check('a THROW settles as non_blocking_error — the stop stands (fail-open)', thrown.outcome === 'non_blocking_error')
  const attachment = (thrown as { message?: { attachment?: { type?: string; content?: string } } }).message?.attachment
  check('…with a VISIBLE hook-error attachment (the notice)', attachment?.type === 'hook_error_during_execution')
  check('…carrying the supervisor-named message', typeof attachment?.content === 'string' && attachment.content.includes('run-completion supervisor'))

  const blocking = await executeFunctionHook({
    ...base,
    hook: {
      type: 'function',
      id: 'proof-block',
      timeout: 5_000,
      silent: true,
      errorMessage: 'fallback message',
      callback: async () => 'RE-PROMPT TEXT',
    } as never,
  } as never)
  check('a STRING settles as a blocking re-prompt', blocking.outcome === 'blocking')
  const blockErr = (blocking as { blockingError?: { blockingError?: string; silent?: boolean } }).blockingError
  check('…with the returned text as the re-prompt', blockErr?.blockingError === 'RE-PROMPT TEXT')
  check('…carrying the silent flag (model-facing, not painted)', blockErr?.silent === true)

  const expired = await executeFunctionHook({
    ...base,
    hook: {
      type: 'function',
      id: 'proof-hang',
      timeout: 150,
      silent: true,
      errorMessage: 'unused',
      callback: () => new Promise<boolean>(() => {}),
    } as never,
  } as never)
  check(
    'an expired HOOK timeout settles as silent cancelled — the class the supervisor deadline preempts',
    expired.outcome === 'cancelled',
  )
}

console.log(failures ? '\n❌ SUPERVISOR-GATE RED' : '\n✅ SUPERVISOR-GATE GREEN')
process.exit(failures)
