#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'dap-lane-honesty-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const ROOT = path.join(import.meta.dir, '..', '..')

console.log('§1 FC-105 — the deep probe BOOTS the resolved server')
{
  const probes = (await import('../../src/platform/health/healthDeepProbes.ts')) as {
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
      'fix probeJsDebugBoot in src/platform/health/healthDeepProbes.ts, or rebuild dist/vendor/js-debug (src/dapDebugServer.js) so it boots and listens on 127.0.0.1',
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
      'probeJsDebugBoot in src/platform/health/healthDeepProbes.ts must return fail naming the exit before listening when the server script exits at load',
    )
    delete process.env.MERCURY_JS_DEBUG_DAP
  }
  const { ideLoopChecks } = await import('../../src/platform/health/sections/ide-loop.ts')
  const deepProbes = await import('../../src/platform/health/healthDeepProbes.ts')
  const jsRow = ideLoopChecks().find(row => row.id === 'js-debugger')
  const jsSays = await jsRow?.run()
  const jsDirect = await deepProbes.probeJsDebugBoot()
  const portless = (text: string): string => text.replace(/127\.0\.0\.1:\d+/, '127.0.0.1')
  check('the deep row is registered (js-debugger)', jsRow?.depth === 'deep' && jsRow.probe === 'functional' && jsSays?.status === jsDirect.status && portless(jsSays.evidence) === portless(jsDirect.evidence), `${jsSays?.status}: ${jsSays?.evidence.slice(0, 140)}`, 'the js-debugger row in src/platform/health/sections/ide-loop.ts must be deep, functional and run probeJsDebugBoot from healthDeepProbes.ts')
}

console.log('§2 FC-106 — the debugpy remedy names the actual fault')
{
  const resolver = await import('../../src/integrations/debugger/debugpyResolver.ts')
  process.env.MERCURY_DEBUGPY_VENDOR_DIR = '/no/such/debugpy-vendor-dir'
  const pinned = resolver.resolvePythonDebugAdapter({ exclusive: true, candidates: ['/no/such/python-interpreter'] })
  check(
    'a broken pin is the NAMED remedy (never rebuild-the-artifact)',
    pinned.state === 'unavailable' &&
      String(pinned.remedy).includes('MERCURY_DEBUGPY_VENDOR_DIR points at /no/such/debugpy-vendor-dir') &&
      !String(pinned.remedy).includes('rebuild the artifact'),
    String(pinned.remedy).slice(0, 160),
    'resolvePythonDebugAdapter in src/integrations/debugger/debugpyResolver.ts must name MERCURY_DEBUGPY_VENDOR_DIR and the pinned path as the remedy when the pin holds no adapter',
  )
  {
    const diag = (resolver as { debugpyVendorDiagnosis: () => { bundledPresent: boolean } }).debugpyVendorDiagnosis()
    check(
      "… and the present-bundle sentence tracks the diagnosis (source-mode has no bundle-sibling tree; the wiring is what's pinned)",
      String(pinned.remedy).includes('vendored debugpy IS present') === diag.bundledPresent,
      `bundledPresent=${diag.bundledPresent}`,
      'the pin remedy in resolvePythonDebugAdapter (src/integrations/debugger/debugpyResolver.ts) must say vendored debugpy IS present exactly when debugpyVendorDiagnosis().bundledPresent is true',
    )
  }
  delete process.env.MERCURY_DEBUGPY_VENDOR_DIR
  const unpinned = resolver.resolvePythonDebugAdapter({ exclusive: true, candidates: ['/no/such/python-interpreter-2'] })
  check(
    'without a pin the standing remedy is untouched (control)',
    unpinned.state === 'unavailable' && String(unpinned.remedy).includes('rebuild the artifact'),
    String(unpinned.remedy).slice(0, 120),
    'with no MERCURY_DEBUGPY_VENDOR_DIR pin, resolvePythonDebugAdapter in src/integrations/debugger/debugpyResolver.ts must keep the rebuild-the-artifact remedy',
  )
}

console.log(failures === 0 ? '\nprove-dap-lane-honesty: all green' : `\nprove-dap-lane-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
