#!/usr/bin/env bun
const mode = process.argv[2]
if (mode === 'fork') {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
}
await import('../../src/tools.js')
const { initBundledWorkflows } = await import('../../src/tools/WorkflowTool/bundled/index.js')
initBundledWorkflows()
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
