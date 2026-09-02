#!/usr/bin/env bun
// ============================================================================
//  scripts/repo-generation/registration-worker.ts — one-process registration probe.
//
//  Spawned by prove-repo-generation-registration.ts (initBundledWorkflows latches
//  per process, so each flag/build combination needs a fresh process).
//  argv[2] = 'fork' | 'plain' (stamp-sim via globalThis.MACRO, set BEFORE any
//  import so every module reads the simulated build).
//
//  IMPORT ORDER MATTERS (a pre-existing source-run hazard, NOT introduced by
//  daedalus): entering the graph at bundled/index.ts under stamp-sim TDZ-crashes
//  — its registry/flag import chain transitively evaluates src/tools.ts, whose
//  stamp-gated WorkflowTool block calls back into the still-initializing
//  bundled module ("Cannot access 'registered' before initialization").
//  Production is immune because the dist entry always evaluates tools.ts
//  FIRST; this worker reproduces exactly that order. The bun-run-proof-
//  loadability lesson applies: probe through the production entry, not a
//  convenient inner module.
// ============================================================================
const mode = process.argv[2]
if (mode === 'fork') {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
}
// Production entry order: tools.ts first (its stamp-gated WorkflowTool block
// runs initBundledWorkflows itself on fork builds).
await import('../../src/tools.js')
const { initBundledWorkflows } = await import('../../src/tools/WorkflowTool/bundled/index.js')
initBundledWorkflows() // idempotent on fork (already ran); real registration on plain
const { getBuiltinWorkflows } = await import('../../src/tools/WorkflowTool/registry.js')
const all = getBuiltinWorkflows()
const daedalus = all.find(w => w.name === 'daedalus')
console.log(
  JSON.stringify({
    names: all.map(w => w.name).sort(),
    daedalus: daedalus
      ? {
          hidden: daedalus.hidden === true,
          source: daedalus.source,
          phases: (daedalus.phases ?? []).map(p => p.title),
          hasScript: typeof daedalus.script === 'string' && daedalus.script.length > 1000,
        }
      : null,
  }),
)
