#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/repro-un52-pycache.ts — UN-52 expect-red driver
//  (D8: the managed payload mutates itself — debugpy probe writes bytecode
//  beside the vendored sources).
//
//  Mechanism under test: debugpyResolver.probeInterpreter spawns
//  `<python> -c "…sys.path.insert(0, vendorRoot); import debugpy; …"` with
//  env {…process.env} — no PYTHONPYCACHEPREFIX, no bytecode suppression —
//  so CPython compiles the vendored modules and writes __pycache__/ beneath
//  the managed payload (L19: managed payloads do not self-mutate). The same
//  inherited-env shape launches real adapters (dapClient), so a real debug
//  session mutates the payload too.
//
//  Driven against a TEMP payload copy through the REAL resolver via its
//  registered seam (MERCURY_DEBUGPY_VENDOR_DIR):
//
//    §A a byte-counted temp vendored tree (the managed-payload stand-in)
//    §B resolvePythonDebugAdapter() probes it green through a real
//       interpreter spawn
//    §C REPRODUCED: __pycache__ now exists beneath the payload copy —
//       the probe alone changed the managed bytes
//
//  Exit 0 = defect REPRODUCED (the recorded red for UN-52's before-state).
//  Exit 1 = not reproduced (e.g. no python on this host — record honestly).
//  Not part of the green gate (repro-*, not prove-*).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — the temp payload copy: the minimal vendored shape the resolver
// recognizes (adapter/__main__.py) with importable modules for the probe's
// exact import chain.
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

// §B — the REAL resolver against the temp payload (registered env seam).
process.env.MERCURY_DEBUGPY_VENDOR_DIR = vendorRoot
const resolver = await import('../../src/services/dap/debugpyResolver.ts')
resolver._resetDebugpyResolverForTesting()
const resolution = resolver.resolvePythonDebugAdapter()
check(
  '§B probe resolved green against the vendored copy',
  resolution.state === 'ok' && resolution.provenance.adapterSource === 'bundled',
  resolution.state === 'ok' ? resolution.provenance.lastProbe : resolution.reason,
)

// §C — the payload has grown its own bytecode.
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
