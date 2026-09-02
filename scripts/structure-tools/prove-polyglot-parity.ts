#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const repoRoot = join(import.meta.dir, '..', '..')
const bun = `${process.env.HOME}/.bun/bin/bun`

const PROBE = `
const { StructureTool } = await import('./src/tools/StructureTool/StructureTool.ts')
const schema = StructureTool.inputSchema
const keys = Object.keys(schema.shape).sort()
const action = schema.shape.action
const inner = typeof action?.unwrap === 'function' ? action.unwrap() : action
const actions = inner?.options ?? []
const prompt = await StructureTool.prompt({ getToolPermissionContext: () => ({}) })
console.log(JSON.stringify({ keys, actions, polyglotPrompt: prompt.includes('POLYGLOT pattern lane') || prompt.includes('the POLYGLOT pattern lane') || prompt.includes('pattern lane'), polyglotDiscovery: StructureTool.searchHint.includes('metavariable') || StructureTool.capability.intents.some(i => i.includes('across languages')) }))
`

function probe(env: Record<string, string>): {
  keys: string[]
  actions: string[]
  polyglotPrompt: boolean
  polyglotDiscovery: boolean
} {
  const out = execFileSync(bun, ['-e', PROBE], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  })
  const lastLine = out.trim().split('\n').at(-1)!
  return JSON.parse(lastLine)
}

{
  const off = probe({ MERCURY_STRUCTURE_POLYGLOT: '0' })
  check('OFF: no pattern field', !off.keys.includes('pattern'), off.keys.join(','))
  check('OFF: no lang field', !off.keys.includes('lang'))
  check('OFF: no out field', !off.keys.includes('out'))
  check('OFF: no rewrite action', !off.actions.includes('rewrite'), off.actions.join(','))
  check('OFF: prompt carries no pattern-lane bytes', !off.polyglotPrompt)
  check('OFF: discovery surface never advertises the lane', !off.polyglotDiscovery)
}

{
  const on = probe({})
  check('ON: pattern field present', on.keys.includes('pattern'), on.keys.join(','))
  check('ON: lang field present', on.keys.includes('lang'))
  check('ON: out field present', on.keys.includes('out'))
  check('ON: rewrite action present', on.actions.includes('rewrite'), on.actions.join(','))
  check('ON: prompt names the pattern lane', on.polyglotPrompt)
  check('ON: discovery surface advertises the lane', on.polyglotDiscovery)
}

{
  const RUNOP_PROBE = `
process.env.MERCURY_TREESITTER_VENDOR_DIR ??= './node_modules/@vscode/tree-sitter-wasm/wasm'
const { runPolyglotQuery } = await import('./src/services/structure/polyglotQuery.ts')
const { structurePolyglotEnabled } = await import('./src/services/structure/contracts.ts')
console.log(JSON.stringify({ enabled: structurePolyglotEnabled() }))
`
  const out = execFileSync(bun, ['-e', RUNOP_PROBE], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, MERCURY_STRUCTURE_POLYGLOT: '0' },
  })
  const parsed = JSON.parse(out.trim().split('\n').at(-1)!)
  check('OFF: structurePolyglotEnabled() reads env live', parsed.enabled === false)
  const master = execFileSync(bun, ['-e', RUNOP_PROBE], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, MERCURY_STRUCTURE: '0' },
  })
  const masterParsed = JSON.parse(master.trim().split('\n').at(-1)!)
  check('MERCURY_STRUCTURE=0 also disables the pattern lane', masterParsed.enabled === false)
}

console.log(failures === 0 ? '\nPOLYGLOT PARITY GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
