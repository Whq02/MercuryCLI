// ============================================================================
//  scripts/repo-generation/stub-hooks.ts — a scripted makeHooks factory for running
//  workflow scripts through the REAL executor (buildVMContext /
//  runWorkflowScript) with deterministic canned agents and NO live API.
//
//  The seam is the executor's own injection point (BuildContextOptions.
//  makeHooks — the same place WorkflowTool.tsx plugs the real agent fan-out),
//  so the compiled script, the hardened VM, the boundary marshalling, and the
//  `themis` global projection are all the production code paths; only the
//  subagent spawn is scripted. The proof-must-replicate-production-condition
//  card is why we stub HERE and not around the script.
// ============================================================================

import type { BuildContextOptions, WorkflowHooks } from '../../src/tools/WorkflowTool/executor.js'

export interface AgentCall {
  prompt: string
  label: string
  opts: Record<string, unknown> | undefined
}

export interface StubHarness {
  makeHooks: BuildContextOptions['makeHooks']
  /** Every agent() dispatch in order (label + opts recorded for assertions). */
  calls: AgentCall[]
  /** Every log() line the script emitted. */
  logs: string[]
}

/**
 * `respond(label, prompt, nth)` returns the canned result for an agent call —
 * `nth` counts calls PER LABEL (1-based) so retries are distinguishable.
 * Return null to simulate a skipped/failed subagent.
 */
export function makeStubHarness(
  respond: (label: string, prompt: string, nth: number) => unknown,
): StubHarness {
  const calls: AgentCall[] = []
  const logs: string[] = []
  const perLabel = new Map<string, number>()

  const makeHooks: BuildContextOptions['makeHooks'] = () => {
    let bridge: {
      settle: (v: unknown) => Promise<{ v: unknown }>
      call: (fn: unknown, ...args: unknown[]) => unknown
      clone: (hostVal: unknown) => unknown
    } | null = null
    let agentCount = 0
    const failures: string[] = []
    const hooks: WorkflowHooks = {
      agent: async (prompt: string, opts?: unknown) => {
        agentCount++
        const o = (opts ?? undefined) as Record<string, unknown> | undefined
        const label = String(o?.label ?? `agent-${agentCount}`)
        const nth = (perLabel.get(label) ?? 0) + 1
        perLabel.set(label, nth)
        calls.push({ prompt: String(prompt), label, opts: o })
        const res = respond(label, String(prompt), nth)
        // The real hooks clone results into the realm; mirror that discipline.
        return bridge ? bridge.clone(res) : res
      },
      parallel: async (thunks: Array<() => Promise<unknown>>) => {
        const out: unknown[] = []
        for (const t of thunks) {
          try {
            const settled = await bridge!.settle(bridge!.call(t))
            out.push(settled.v)
          } catch {
            out.push(null)
          }
        }
        return bridge!.clone(out) as unknown[]
      },
      pipeline: async () => {
        throw new Error('pipeline() is not used by the daedalus proofs')
      },
      log: (m: unknown) => {
        logs.push(String(m))
      },
      phase: () => {},
      getAgentCount: () => agentCount,
      getFailures: () => failures,
      bindVMAwait: b => {
        bridge = b
      },
    }
    return hooks
  }

  return { makeHooks, calls, logs }
}
