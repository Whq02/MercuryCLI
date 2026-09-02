// ============================================================================
//  scripts/eval/lib — shared fixture plumbing for the eval provers.
//
//  Every prover runs against a SCRATCH config home (never the operator's),
//  builds a minimal ToolUseContext, and disposes every kernel it spawned —
//  no process left behind. No top-level src imports: the scratch env must
//  be pinned before any memoizing module loads, so src enters through
//  loadEval()/loadTool() AFTER setup().
// ============================================================================

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

export let failures = 0
export function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
export function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
export function finish(name: string): never {
  console.log('\n' + '═'.repeat(76))
  console.log(failures === 0 ? `✅ ALL ${name} PROOFS PASS` : `❌ ${failures} ${name} PROOF(S) FAILED`)
  console.log('═'.repeat(76))
  process.exit(failures === 0 ? 0 : 1)
}

let scratch: string | null = null
/** Pin a scratch config home + cwd sandbox. Call BEFORE loadEval(). */
export function setup(): { home: string; work: string } {
  if (!scratch) {
    scratch = mkdtempSync(join(tmpdir(), 'mercury-eval-prover-'))
    process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
    // Never inherit an operator pin into a prover.
    delete process.env.MERCURY_EVAL_PYTHON
  }
  const work = join(scratch, 'work')
  mkdirSync(work, { recursive: true })
  return { home: process.env.MERCURY_CONFIG_DIR!, work }
}

export function cleanup(): void {
  if (scratch) {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

export async function loadEval(): Promise<typeof import('../../src/services/eval/kernelManager.js')> {
  return import('../../src/services/eval/kernelManager.js')
}

/** A bridge that refuses everything (kernel-only provers). */
export function refusingBridge(): import('../../src/services/eval/kernelManager.js').BridgeServer {
  return async () => ({ ok: false, error: 'no bridge in this prover' })
}

/** Minimal ToolUseContext for runToolUse-path provers. */
export async function makeContext(options?: {
  mode?: string
  tools?: unknown[]
  abortController?: AbortController
}): Promise<import('../../src/Tool.js').ToolUseContext> {
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
  const permissionContext = { ...getEmptyToolPermissionContext(), mode: (options?.mode ?? 'default') as never }
  const appState = { toolPermissionContext: permissionContext, sessionHooks: new Map() } as never
  return {
    options: {
      commands: [],
      verbose: false,
      mainLoopModel: 'claude-sonnet-5',
      tools: (options?.tools ?? []) as never,
      mcpClients: [],
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] } as never,
    },
    abortController: options?.abortController ?? new AbortController(),
    readFileState: new Map() as never,
    getAppState: () => appState as never,
    setAppState: () => undefined,
    messages: [],
    setResponseLength: () => undefined,
    updateFileHistoryState: () => undefined,
    updateAttributionState: () => undefined,
  } as never
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Bounded await — a prover must fail loud, never hang. */
export async function within<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)
  })
  try {
    return await Promise.race([work, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
