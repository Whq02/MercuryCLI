#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../../src/services/instructions')
const modules = [...readdirSync(root), ...readdirSync(join(root, 'adapters')).map(name => join('adapters', name))].filter(name => name.endsWith('.ts')).sort()

let failed = 0
for (const name of modules) {
  const run = spawnSync(process.execPath, ['-e', `globalThis.MACRO = { VERSION: '1.0.0' }; await import(${JSON.stringify(join(root, name))})`], { encoding: 'utf8', timeout: 60_000 })
  const ok = run.status === 0
  if (!ok) failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} loads as the first module of a process${ok ? '' : ` — ${(run.stderr || '').split('\n').find(line => /Error/.test(line)) ?? `exit ${run.status}`}`}`)
}
console.log(`instruction-modules-load-alone: ${modules.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
