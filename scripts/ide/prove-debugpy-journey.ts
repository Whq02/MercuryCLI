#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-debugpy-journey.ts
//  PROOF: the BUNDLED debugpy adapter completes a real debugging journey
//  through the production surfaces.
//
//    (1) RESOLVER HONESTY — pointed at the built dist vendor tree, the
//        resolver reports source=bundled with a health-probed interpreter;
//        pointed at nothing, it reports environment or unavailable exactly
//        as the machine warrants, and createDapSession REFUSES an
//        unavailable python adapter BEFORE spawning (remedy attached).
//    (2) THE JOURNEY, through the REAL Debug tool (DebugTool.call — the
//        same runOp surface the model drives): launch a scratch program
//        with a breakpoint → adapter-VERIFIED stop → stack → scopes →
//        variables (locals) → evaluate → setVariable → continue → clean
//        termination with the MUTATED output → disconnect reaps; the
//        owner-registry session count returns to baseline (no orphans).
//        The leg asserts the BUNDLED adapter (a silent module fallback
//        fails it).
//    (3) READINESS AGREEMENT — /capabilities' lane:dap:python row (the
//        production readiness consumer) reports ready+BUNDLED from the
//        SAME probe.
//
//  Machine dependence: needs the prebuilt dist vendor tree and a healthy
//  Python interpreter (pydevd import chain). Missing prerequisites SKIP
//  LOUDLY with the exact remedy — never silently.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-debugpy-journey.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST_VENDOR = join(ROOT, 'dist', 'vendor', 'debugpy')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 480s')
  process.exit(1)
}, 480_000)
guard.unref?.()

console.log('============================================================')
console.log(' debugpy journey — bundled adapter · real Debug tool · readiness')
console.log('============================================================')

if (!existsSync(join(DIST_VENDOR, 'debugpy', 'adapter', '__main__.py'))) {
  console.log('\n  [SKIP — LOUD] dist/vendor/debugpy is absent: the journey needs the BUILT vendored tree.')
  console.log('  remedy: bun run scripts/vendor/fetch-debugpy.ts && bun run build.ts')
  console.log('  (the vendor-contract proof still covers manifest honesty; this leg is the live journey)')
  process.exit(0)
}

process.env.MERCURY_DEBUGPY_VENDOR_DIR = DIST_VENDOR
delete process.env.MERCURY_DAP
delete process.env.MERCURY_DAP_ADAPTERS

const resolver = await import('../../src/services/dap/debugpyResolver.js')
const dap = await import('../../src/services/dap/dapClient.js')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')

resolver._resetDebugpyResolverForTesting()
const resolution = resolver.resolvePythonDebugAdapter()

if (resolution.state === 'unavailable') {
  console.log('\n  [SKIP — LOUD] no healthy Python interpreter for the debug lane on this machine:')
  console.log(`    ${resolution.reason}`)
  console.log(`    remedy: ${resolution.remedy}`)
  console.log('  The journey cannot run here; readiness/doctor report the same truth (verified below).')
  // Even without an interpreter the preflight-refusal contract must hold.
  const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
  const owner = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'debugpy-skip-proof', lane: 'main' })
  let refused = ''
  try {
    await dap.createDapSession({ owner, id: 'x', adapterKey: 'python', program: '/tmp/nope.py', cwd: '/tmp' })
  } catch (e) {
    refused = (e as Error).message
  }
  check('createDapSession refuses BEFORE spawning (unavailable + remedy)', refused.includes('unavailable') && refused.length > 0, refused.slice(0, 160))
  process.exit(failures === 0 ? 0 : 1)
}

section('(1) resolver honesty — bundled source, health-probed interpreter')
{
  check('source is BUNDLED (module fallback must not pass this leg)', resolution.provenance.adapterSource === 'bundled', resolution.provenance.adapterSource)
  check('adapter path is the dist vendor tree', resolution.args[0] === join(DIST_VENDOR, 'debugpy', 'adapter'), resolution.args.join(' '))
  check('debugpy version is the pinned 1.8.21', resolution.provenance.debugpyVersion === '1.8.21', String(resolution.provenance.debugpyVersion))
  check('interpreter was health-probed (pydevd chain)', resolution.provenance.lastProbe.includes('pydevd import chain OK'), resolution.provenance.lastProbe)
  console.log(`  (interpreter: ${resolution.provenance.interpreter} ${resolution.provenance.interpreterVersion ?? ''})`)
}

section('(2) the journey through the REAL Debug tool (bundled adapter)')
{
  const ws = mkdtempSync(join(tmpdir(), 'debugpy-journey-'))
  const program = join(ws, 'demo.py')
  writeFileSync(
    program,
    'def compute(a, b):\n    total = a * 10 + b\n    return total\n\nif __name__ == "__main__":\n    x = compute(4, 2)\n    print("result:", x)\n',
  )
  const baselineSessions = dap._dapSessionCountForTesting()
  type CallOut = { data: { result: string; outcome: string; debuggee?: string } }
  const call = async (input: Record<string, unknown>): Promise<CallOut> =>
    (await DebugTool.call(input as never, {} as never)) as CallOut
  try {
    const launch = await call({
      op: 'launch',
      adapter: 'python',
      program,
      file: program,
      lines: [2],
      session: 'forge-proof',
    })
    check('launch stops at the VERIFIED breakpoint', /line 2 verified/.test(launch.data.result) && /stopped — reason breakpoint/.test(launch.data.result), launch.data.result.split('\n')[0])
    check('stop card names compute at line 2', /#0 .*compute.* \(.*demo\.py:2\)/.test(launch.data.result), launch.data.result)

    const stack = await call({ op: 'stack', session: 'forge-proof' })
    const frameId = Number(stack.data.result.match(/\[frameId (\d+)\]/)?.[1])
    check('stack exposes a frameId', Number.isInteger(frameId), stack.data.result.split('\n')[0])

    const scopes = await call({ op: 'scopes', session: 'forge-proof', frameId })
    const localRef = Number(scopes.data.result.match(/Local[^\[]*\[variablesReference (\d+)\]/i)?.[1])
    check('scopes expose the Locals reference', Number.isInteger(localRef), scopes.data.result)

    const vars = await call({ op: 'variables', session: 'forge-proof', variablesReference: localRef })
    check('locals show a = 4', /(^|\n)a = 4/.test(vars.data.result), vars.data.result.slice(0, 120))

    const evald = await call({ op: 'evaluate', session: 'forge-proof', expression: 'a * 10 + b', frameId })
    check('evaluate a*10+b = 42', evald.data.result.includes('= 42'), evald.data.result)

    const setv = await call({ op: 'setVariable', session: 'forge-proof', variablesReference: localRef, name: 'b', value: '7' })
    check('setVariable b=7 lands (capability advertised)', setv.data.result.includes('b = 7'), setv.data.result)

    const cont = await call({ op: 'continue', session: 'forge-proof' })
    check('continue runs to clean termination', cont.data.result.includes('terminated'), cont.data.result.split('\n')[0])

    await new Promise(res => setTimeout(res, 200))
    const output = await call({ op: 'output', session: 'forge-proof' })
    const combined = `${cont.data.result}\n${output.data.result}`
    check('program output reflects the MUTATED b (result: 47)', combined.includes('result: 47'), combined.slice(0, 200))

    const disc = await call({ op: 'disconnect', session: 'forge-proof' })
    check('disconnect reaps the session', disc.data.result.includes('disconnected'))
    check('session registry back at baseline (no orphans)', dap._dapSessionCountForTesting() === baselineSessions, `${dap._dapSessionCountForTesting()} vs ${baselineSessions}`)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

section('(3) readiness agreement — the production consumer reads the same probe')
{
  const { collectReadiness } = await import('../../src/utils/readiness.js')
  const report = collectReadiness({ includeEnv: false })
  const row = report.records.find(r => r.id === 'lane:dap:python')
  check('lane:dap:python row exists', row !== undefined)
  check('row is ready', row?.state === 'ready', `${row?.state}: ${row?.detail}`)
  check('row names the BUNDLED pinned wheel', (row?.detail ?? '').includes('BUNDLED'), row?.detail)
  check('row names the probed interpreter', (row?.detail ?? '').includes(resolution.provenance.interpreter ?? '?'), row?.detail)
}

section('(4) ISOLATED artifact — the bundled adapter through the artifact\'s own probe')
{
  // The acceptance bar: the artifact, copied OUT of the tree (no repo, no
  // node_modules, scratch HOME, minimal PATH), resolves its OWN bundle-
  // sibling vendor tree (no env override) and completes the deep
  // python-debugger journey via `doctor --json --deep` — the same probe
  // /doctor ships to operators.
  const { mkdtempSync: mkTemp, copyFileSync, cpSync, mkdirSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const { dirname } = await import('node:path')
  const arena = mkTemp(join(tmpdir(), 'iso-debugpy-'))
  try {
    const arenaHome = join(arena, 'home')
    mkdirSync(arenaHome, { recursive: true })
    copyFileSync(join(ROOT, 'dist', 'mercury.mjs'), join(arena, 'mercury.mjs'))
    cpSync(DIST_VENDOR, join(arena, 'vendor', 'debugpy'), { recursive: true })
    const nodeBin = Bun.which('node')
    check('node binary available for the arena', nodeBin !== null)
    if (nodeBin) {
      const r = spawnSync(nodeBin, [join(arena, 'mercury.mjs'), 'doctor', '--json', '--deep'], {
        cwd: arena,
        encoding: 'utf8',
        timeout: 300_000,
        env: {
          HOME: arenaHome,
          PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
          TERM: 'dumb',
          // The arena is hermetic: no repo env, no vendor override — the
          // resolver must find the tree BESIDE the running bundle.
        },
      })
      // 0|3, the prove-health-json precedent (control-proved): a
      // signed-out world's auth row FAULTS the deep verdict (exit 3) while
      // the cert still prints whole — the python rows below are the teeth
      // this journey pins; any other status is a real doctor break.
      check('isolated doctor --json --deep exits 0|3 (3 = the signed-out auth fault, cert still whole)', r.status === 0 || r.status === 3, (r.stderr || r.stdout).slice(0, 300))
      let pyCheck: { status?: string; evidence?: string } | undefined
      let pyReadiness: { state?: string; detail?: string } | undefined
      try {
        const cert = JSON.parse(r.stdout) as Record<string, unknown>
        const findCheck = (node: unknown): void => {
          if (Array.isArray(node)) {
            for (const item of node) findCheck(item)
          } else if (node && typeof node === 'object') {
            const o = node as Record<string, unknown>
            if (o.id === 'python-debugger' && typeof o.status === 'string') {
              pyCheck = o as { status: string; evidence?: string }
            }
            if (o.id === 'lane:dap:python' && typeof o.state === 'string') {
              pyReadiness = o as { state: string; detail?: string }
            }
            for (const v of Object.values(o)) findCheck(v)
          }
        }
        findCheck(cert)
      } catch (e) {
        check('isolated certificate parses', false, String(e).slice(0, 120))
      }
      check('deep python-debugger check ran in isolation', pyCheck !== undefined)
      check('…and is ok', pyCheck?.status === 'ok', `${pyCheck?.status}: ${pyCheck?.evidence?.slice(0, 160)}`)
      check('…on the BUNDLED adapter (bundle-sibling resolution, no override)', (pyCheck?.evidence ?? '').includes('BUNDLED'), pyCheck?.evidence)
      check('isolated readiness row agrees (ready + BUNDLED)', pyReadiness?.state === 'ready' && (pyReadiness?.detail ?? '').includes('BUNDLED'), `${pyReadiness?.state}: ${pyReadiness?.detail}`)
    }
  } finally {
    rmSync(arena, { recursive: true, force: true })
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL DEBUGPY JOURNEY CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
