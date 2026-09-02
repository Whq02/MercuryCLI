#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const payload = mkdtempSync(join(tmpdir(), 'unison-un52-payload-'))
const vendorRoot = join(payload, 'vendor', 'debugpy')
mkdirSync(join(vendorRoot, 'debugpy', 'adapter'), { recursive: true })
mkdirSync(join(vendorRoot, 'debugpy', '_vendored'), { recursive: true })
writeFileSync(join(vendorRoot, 'debugpy', '__init__.py'), '__version__ = "0.0-fixture"\n')
writeFileSync(join(vendorRoot, 'debugpy', '_vendored', '__init__.py'), '')
writeFileSync(join(vendorRoot, 'debugpy', '_vendored', 'force_pydevd.py'), '')
writeFileSync(join(vendorRoot, 'debugpy', 'adapter', '__main__.py'), '')

const countPycache = (dir: string): string[] => {
  const hits: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) {
        if (name === '__pycache__') hits.push(full)
        else walk(full)
      }
    }
  }
  walk(dir)
  return hits
}
check('§A payload copy starts byte-stable (zero __pycache__)', countPycache(payload).length === 0)

process.env.MERCURY_DEBUGPY_VENDOR_DIR = vendorRoot
const resolver = await import('../../src/services/dap/debugpyResolver.ts')
resolver._resetDebugpyResolverForTesting()
const resolution = resolver.resolvePythonDebugAdapter()
check(
  '§B probe resolved green against the vendored copy',
  resolution.state === 'ok' && resolution.provenance.adapterSource === 'bundled',
  resolution.state === 'ok' ? resolution.provenance.lastProbe : resolution.reason,
)

const pycaches = countPycache(payload)
check(
  '§C REPRODUCED: probe wrote __pycache__ beneath the managed payload',
  pycaches.length > 0,
  pycaches.map(p => p.slice(payload.length + 1)).join(', ') || 'none',
)

console.log(
  failed === 0
    ? '\n REPRODUCED — UN-52 red recorded (payload self-mutation via probe)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
