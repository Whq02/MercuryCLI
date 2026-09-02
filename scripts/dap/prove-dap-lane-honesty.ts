#!/usr/bin/env bun
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'dap-lane-honesty-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = path.join(import.meta.dir, '..', '..')

console.log('§1 FC-105 — the deep probe BOOTS the resolved server')
{
  const probes = (await import('../../src/utils/healthDeepProbes.ts')) as {
    probeJsDebugBoot?: (signal?: AbortSignal) => Promise<{ status: string; evidence: string }>
  }
  check('the boot probe exists', typeof probes.probeJsDebugBoot === 'function')
  if (probes.probeJsDebugBoot) {
    process.env.MERCURY_JS_DEBUG_DAP = path.join(ROOT, 'dist', 'vendor', 'js-debug', 'src', 'dapDebugServer.js')
    const vendored = await probes.probeJsDebugBoot()
    check(
      'the REAL vendored bundle boots and listens (ok)',
      vendored.status === 'ok' && vendored.evidence.includes('listened on 127.0.0.1:'),
      `${vendored.status}: ${vendored.evidence.slice(0, 120)}`,
    )
    const scratch = mkdtempSync(path.join(tmpdir(), 'dap-lane-deadpin-'))
    const dead = path.join(scratch, 'dapDebugServer.js')
    writeFileSync(dead, "throw new Error('Dynamic require of \\'fs\\' is not supported')")
    process.env.MERCURY_JS_DEBUG_DAP = dead
    const broken = await probes.probeJsDebugBoot()
    check(
      "an exits-at-load server FAILS with the exit named (the card's certified-ready bundle)",
      broken.status === 'fail' && broken.evidence.includes('exited') && broken.evidence.includes('before listening'),
      `${broken.status}: ${broken.evidence.slice(0, 140)}`,
    )
    delete process.env.MERCURY_JS_DEBUG_DAP
  }
  const readiness = readFileSync(path.join(ROOT, 'src', 'utils', 'readiness.ts'), 'utf8')
  check(
    'the fast row speaks resolution, not liveness (the child-road-is-live claim is gone)',
    readiness.includes('resolution only; doctor --deep boots it') && !readiness.includes('the startDebugging child road is live'),
  )
  const report = readFileSync(path.join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check('the deep row is registered (js-debugger)', report.includes("id: 'js-debugger'") && report.includes('probeJsDebugBoot'))
}

console.log('§2 FC-106 — the debugpy remedy names the actual fault')
{
  const resolver = await import('../../src/services/dap/debugpyResolver.ts')
  process.env.MERCURY_DEBUGPY_VENDOR_DIR = '/no/such/debugpy-vendor-dir'
  const pinned = resolver.resolvePythonDebugAdapter({ exclusive: true, candidates: ['/no/such/python-interpreter'] })
  check(
    'a broken pin is the NAMED remedy (never rebuild-the-artifact)',
    pinned.state === 'unavailable' &&
      String(pinned.remedy).includes('MERCURY_DEBUGPY_VENDOR_DIR points at /no/such/debugpy-vendor-dir') &&
      !String(pinned.remedy).includes('rebuild the artifact'),
    String(pinned.remedy).slice(0, 160),
  )
  {
    const diag = (resolver as { debugpyVendorDiagnosis: () => { bundledPresent: boolean } }).debugpyVendorDiagnosis()
    check(
      "… and the present-bundle sentence tracks the diagnosis (source-mode has no bundle-sibling tree; the wiring is what's pinned)",
      String(pinned.remedy).includes('vendored debugpy IS present') === diag.bundledPresent,
      `bundledPresent=${diag.bundledPresent}`,
    )
  }
  delete process.env.MERCURY_DEBUGPY_VENDOR_DIR
  const unpinned = resolver.resolvePythonDebugAdapter({ exclusive: true, candidates: ['/no/such/python-interpreter-2'] })
  check(
    'without a pin the standing remedy is untouched (control)',
    unpinned.state === 'unavailable' && String(unpinned.remedy).includes('rebuild the artifact'),
    String(unpinned.remedy).slice(0, 120),
  )
}

console.log(failures === 0 ? '\nprove-dap-lane-honesty: all green' : `\nprove-dap-lane-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
