#!/usr/bin/env bun
// gate-watch: src/utils/hooks/runStopHook.ts src/utils/hooks/engine.ts src/utils/config/globalConfig.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'run-stop-hook-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures = 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' the default run stop hook — every stop stands; the record is the whole effect')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const hook = await import('../../src/utils/hooks/runStopHook.ts')

type Registered = { callback: (m: never[], s?: AbortSignal) => Promise<boolean | string>; timeout?: number; silent?: boolean; id?: string }

function registeredHooks(state: Record<string, unknown>): Registered[] {
  const found: Registered[] = []
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
  return found
}

section('§1 registration — one silent hook per session, under the executor ceiling')
{
  hook._resetRunStopHookForTesting()
  const state: Record<string, unknown> = { sessionHooks: new Map<string, unknown>() }
  const setAppState = (update: unknown): void => {
    if (typeof update === 'function') {
      const next = (update as (prev: Record<string, unknown>) => Record<string, unknown>)(state)
      Object.assign(state, next)
    }
  }
  const id = hook.registerRunStopHook(setAppState as never, 'proof-session')
  check('registration returns the stable hook id', id === hook.RUN_STOP_HOOK_ID)
  const again = hook.registerRunStopHook(setAppState as never, 'proof-session')
  check('registering the same session again returns the same id', again === id)
  const found = registeredHooks(state)
  check('the hook registered exactly once', found.length === 1, String(found.length))
  const registered = found[0]
  check('registered with the 30s executor ceiling', registered?.timeout === hook.RUN_STOP_HOOK_TIMEOUT_MS && hook.RUN_STOP_HOOK_TIMEOUT_MS === 30_000)
  check('registered silent (never paints the transcript)', registered?.silent === true)

  const started = Date.now()
  const verdict = registered ? await registered.callback([]) : 'unreached'
  check('a stop with no run passes untouched (true)', verdict === true, String(verdict))
  check('…promptly', Date.now() - started < 5_000, `${Date.now() - started} ms`)
}

section('§2 the hook never blocks — its one answer is true, the record its one effect')
{
  const text = readFileSync(join(ROOT, 'src/utils/hooks/runStopHook.ts'), 'utf8')
  const arm = text.slice(text.indexOf("'Stop'"))
  const callback = arm.slice(0, arm.indexOf('\n    },'))
  const returns = callback.match(/\breturn\b[^\n]*/g) ?? []
  check('every return in the Stop callback is `return true`', returns.length > 0 && returns.every(r => /^return true\b/.test(r)), returns.join(' | '))
  check('the callback hands the stop to the adapter with the ceiling, the evidence-only posture and the signal — nothing more', /await evaluateStopAttempt\(messages, \{\s*maxBlocks: MAX_BLOCKS,\s*wordingUnfinished: false,[^}]*\bsignal,\s*\}\)/.test(callback))
  check('the callback reads no environment and no setting', !/process\.env|flagEnv\(|getGlobalConfig\(|getSettings/.test(callback))
  check('the module composes no re-prompt', !/repromptWithNextAction|RUN_STOP_REPROMPT/.test(text))
  const exported = Object.keys(hook).sort()
  check('the module exports the hook id, the ceiling, the registrar and the test reset — nothing else', exported.join(',') === ['RUN_STOP_HOOK_ID', 'RUN_STOP_HOOK_TIMEOUT_MS', '_resetRunStopHookForTesting', 'registerRunStopHook'].join(','), exported.join(','))
}

section('§3 the executor — a true answer is success; the stop stands')
{
  const { executeFunctionHook } = await import('../../src/utils/hooks/engine.ts')
  const settled = await executeFunctionHook({
    messages: [] as never[],
    hookName: 'proof',
    toolUseID: 'proof-tool-use',
    hookEvent: 'Stop' as never,
    timeoutMs: 5_000,
    hook: {
      type: 'function',
      id: hook.RUN_STOP_HOOK_ID,
      timeout: hook.RUN_STOP_HOOK_TIMEOUT_MS,
      silent: true,
      errorMessage: 'unused',
      callback: async () => true,
    } as never,
  } as never)
  check('a true answer settles as success (no block, no notice)', settled.outcome === 'success', String(settled.outcome))
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(failures ? '\n❌ RUN-STOP-HOOK RED' : '\n✅ RUN-STOP-HOOK GREEN')
process.exit(failures)
