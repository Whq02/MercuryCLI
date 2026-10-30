#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST_VENDOR = join(ROOT, 'dist', 'vendor', 'debugpy')
const DIST_PYTHON = join(ROOT, 'dist', 'vendor', 'python')
const PINNED_DEBUGPY = '1.8.22'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 600s')
  process.exit(1)
}, 600_000)
guard.unref?.()

console.log('============================================================')
console.log(' debugpy journey — bundled adapter on the bundled interpreter · real Debug tool · readiness · the fallback')
console.log('============================================================')

if (!existsSync(join(DIST_VENDOR, 'debugpy', 'adapter', '__main__.py'))) {
  console.log('\n  [SKIP — LOUD] dist/vendor/debugpy is absent: the journey needs the BUILT vendored tree.')
  console.log('  remedy: bun run scripts/vendor/fetch-debugpy.ts && bun run build.ts')
  process.exit(0)
}
const bundledBinary = process.platform === 'win32' ? join(DIST_PYTHON, 'python.exe') : join(DIST_PYTHON, 'bin', 'python3')
if (!existsSync(bundledBinary)) {
  console.log('\n  [SKIP — LOUD] dist/vendor/python is absent: the journey needs the BUILT Python runtime pack.')
  console.log('  remedy: bun run scripts/vendor/fetch-python.ts && bun run build.ts')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'debugpy-journey-'))
const originalPath = process.env.PATH ?? ''
const nodeBin = Bun.which('node')
const trap = join(scratch, 'trap')
mkdirSync(trap, { recursive: true })
if (process.platform !== 'win32') {
  for (const name of ['python3', 'python']) {
    writeFileSync(join(trap, name), '#!/bin/sh\necho "journey trap: the PATH python must not be used" >&2\nexit 86\n')
    chmodSync(join(trap, name), 0o755)
  }
}
const hiddenPath = [trap, nodeBin ? dirname(nodeBin) : null, '/usr/bin', '/bin'].filter((p): p is string => p !== null).join(delimiter)
const appleStub = process.platform === 'darwin' ? spawnSync('/usr/bin/python3', ['-c', 'import sys; print(sys.version_info >= (3, 10))'], { encoding: 'utf8', timeout: 20_000 }) : null
const machinePythonReachesTheFloor = appleStub !== null && appleStub.status === 0 && appleStub.stdout.trim() === 'True'

process.env.MERCURY_DEBUGPY_VENDOR_DIR = DIST_VENDOR
process.env.MERCURY_PYTHON_VENDOR_DIR = DIST_PYTHON
process.env.PATH = hiddenPath
delete process.env.MERCURY_DAP
delete process.env.MERCURY_DAP_ADAPTERS
delete process.env.MERCURY_PYTHON
delete process.env.VIRTUAL_ENV
delete process.env.CONDA_PREFIX

const resolver = await import('../../src/services/dap/debugpyResolver.js')
const pythonProject = await import('../../src/services/ide/pythonProject.js')
const dap = await import('../../src/services/dap/dapClient.js')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')

const resetResolvers = (): void => {
  resolver._resetDebugpyResolverForTesting()
  pythonProject._resetPythonProjectForTesting()
}
resetResolvers()
const resolution = resolver.resolvePythonDebugAdapter()

if (resolution.state === 'unavailable') {
  console.log('\n  [FAIL] the bundled interpreter did not resolve the debug lane with every PATH python hidden:')
  console.log(`    ${resolution.reason}`)
  console.log(`    remedy: ${resolution.remedy}`)
  failures++
  console.log(`\n ❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}

const same = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return a === b
  }
}

type CallOut = { data: { result: string; outcome: string; debuggee?: string } }
const call = async (input: Record<string, unknown>): Promise<CallOut> =>
  (await DebugTool.call(input as never, {} as never)) as CallOut

const PROGRAM = 'import sys\n\ndef compute(a, b):\n    total = a * 10 + b\n    return total\n\nif __name__ == "__main__":\n    x = compute(4, 2)\n    print("result:", x)\n    print("interpreter:", sys.executable)\n'

async function journey(label: string, sessionId: string, expectedInterpreter: string | null): Promise<void> {
  const ws = mkdtempSync(join(scratch, 'ws-'))
  const program = join(ws, 'demo.py')
  writeFileSync(program, PROGRAM)
  const baselineSessions = dap._dapSessionCountForTesting()
  try {
    const launch = await call({ op: 'launch', adapter: 'python', program, file: program, lines: [4], session: sessionId })
    check(`${label}: launch stops at the VERIFIED breakpoint`, /line 4 verified/.test(launch.data.result) && /stopped — reason breakpoint/.test(launch.data.result), launch.data.result.split('\n')[0])
    check(`${label}: stop card names compute at line 4`, /#0 .*compute.* \(.*demo\.py:4\)/.test(launch.data.result), launch.data.result)

    const stack = await call({ op: 'stack', session: sessionId })
    const frameId = Number(stack.data.result.match(/\[frameId (\d+)\]/)?.[1])
    check(`${label}: stack exposes a frameId`, Number.isInteger(frameId), stack.data.result.split('\n')[0])

    const scopes = await call({ op: 'scopes', session: sessionId, frameId })
    const localRef = Number(scopes.data.result.match(/Local[^\[]*\[variablesReference (\d+)\]/i)?.[1])
    check(`${label}: scopes expose the Locals reference`, Number.isInteger(localRef), scopes.data.result)

    const vars = await call({ op: 'variables', session: sessionId, variablesReference: localRef })
    check(`${label}: locals show a = 4`, /(^|\n)a = 4/.test(vars.data.result), vars.data.result.slice(0, 120))

    const evald = await call({ op: 'evaluate', session: sessionId, expression: 'a * 10 + b', frameId })
    check(`${label}: evaluate a*10+b = 42`, evald.data.result.includes('= 42'), evald.data.result)

    const exe = await call({ op: 'evaluate', session: sessionId, expression: 'sys.executable', frameId })
    const ran = exe.data.result.match(/= '([^']+)'/)?.[1] ?? exe.data.result.match(/= "([^"]+)"/)?.[1] ?? ''
    if (expectedInterpreter !== null) {
      check(`${label}: the program runs on ${expectedInterpreter}`, ran !== '' && same(ran, expectedInterpreter), exe.data.result.slice(0, 200))
    } else {
      check(`${label}: the program runs on the interpreter the resolver chose`, ran !== '', exe.data.result.slice(0, 200))
    }

    const setv = await call({ op: 'setVariable', session: sessionId, variablesReference: localRef, name: 'b', value: '7' })
    check(`${label}: setVariable b=7 lands`, setv.data.result.includes('b = 7'), setv.data.result)

    const cont = await call({ op: 'continue', session: sessionId })
    check(`${label}: continue reports code-zero termination`, cont.data.debuggee === 'terminated' && cont.data.outcome === 'succeeded' && cont.data.result.split('\n')[0] === 'continue: debuggee exited (code 0)', cont.data.result.split('\n')[0])

    await new Promise(res => setTimeout(res, 200))
    const output = await call({ op: 'output', session: sessionId })
    const combined = `${cont.data.result}\n${output.data.result}`
    check(`${label}: program output reflects the MUTATED b (result: 47)`, combined.includes('result: 47'), combined.slice(0, 200))

    const disc = await call({ op: 'disconnect', session: sessionId })
    check(`${label}: disconnect reaps the session`, disc.data.result.includes('disconnected'))
    check(`${label}: session registry back at baseline (no orphans)`, dap._dapSessionCountForTesting() === baselineSessions, `${dap._dapSessionCountForTesting()} vs ${baselineSessions}`)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

section('(1) resolver honesty — the bundled adapter runs on the bundled interpreter, every PATH python hidden')
{
  check('source is BUNDLED (module fallback must not pass this leg)', resolution.provenance.adapterSource === 'bundled', resolution.provenance.adapterSource)
  check('adapter path is the dist vendor tree', resolution.args[0] === join(DIST_VENDOR, 'debugpy', 'adapter'), resolution.args.join(' '))
  check(`debugpy version is the pinned ${PINNED_DEBUGPY}`, resolution.provenance.debugpyVersion === PINNED_DEBUGPY, String(resolution.provenance.debugpyVersion))
  check('the adapter command is the bundled interpreter (dist/vendor/python)', same(resolution.command, bundledBinary), resolution.command)
  check('the provenance names the bundled interpreter and its version', resolution.provenance.interpreter === resolution.command && /^3\.\d+\.\d+$/.test(resolution.provenance.interpreterVersion ?? ''), `${resolution.provenance.interpreter} ${resolution.provenance.interpreterVersion ?? ''}`)
  check('interpreter was health-probed (pydevd chain)', resolution.provenance.lastProbe.includes('pydevd import chain OK'), resolution.provenance.lastProbe)
  if (machinePythonReachesTheFloor) {
    console.log(`  (the machine's /usr/bin/python3 carries debugpy, so the program runs on it: ${resolution.debuggee})`)
  } else {
    check('with no machine python able to carry debugpy, the program runs on the bundled interpreter too', same(resolution.debuggee, bundledBinary), resolution.debuggee)
  }
  const reachable = dap.reachableDapAdapterKeys()
  check('the python adapter is reachable through the bundled interpreter alone (no PATH python)', reachable.includes('python'), reachable.join(','))
}

section('(2) the journey through the REAL Debug tool — bundled adapter, bundled interpreter, PATH pythons hidden')
await journey('bundled', 'forge-proof', machinePythonReachesTheFloor ? null : bundledBinary)

section('(3) readiness agreement — the production consumer reads the same probe')
{
  const { collectReadiness } = await import('../../src/utils/readiness.js')
  const report = collectReadiness({ includeEnv: false })
  const row = report.records.find(r => r.id === 'lane:dap:python')
  check('lane:dap:python row exists', row !== undefined)
  check('row is ready', row?.state === 'ready', `${row?.state}: ${row?.detail}`)
  check('row names the BUNDLED pinned wheel', (row?.detail ?? '').includes('BUNDLED'), row?.detail)
  check('row names the bundled interpreter', (row?.detail ?? '').includes(resolution.provenance.interpreter ?? '?'), row?.detail)
}

section('(4) ISOLATED artifact — the bundled adapter and interpreter through the artifact\'s own probe, PATH pythons hidden')
{
  const { copyFileSync, cpSync } = await import('node:fs')
  const arena = join(scratch, 'iso')
  const arenaHome = join(arena, 'home')
  mkdirSync(arenaHome, { recursive: true })
  copyFileSync(join(ROOT, 'dist', 'mercury.mjs'), join(arena, 'mercury.mjs'))
  cpSync(DIST_VENDOR, join(arena, 'vendor', 'debugpy'), { recursive: true })
  cpSync(DIST_PYTHON, join(arena, 'vendor', 'python'), { recursive: true })
  if (process.platform !== 'win32') chmodSync(join(arena, 'vendor', 'python', 'bin', 'python3'), 0o755)
  check('node binary available for the arena', nodeBin !== null)
  if (nodeBin) {
    const r = spawnSync(nodeBin, [join(arena, 'mercury.mjs'), 'health', '--json', '--deep'], {
      cwd: arena,
      encoding: 'utf8',
      timeout: 300_000,
      env: {
        HOME: arenaHome,
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        PATH: hiddenPath,
        TERM: 'dumb',
      },
    })
    check('isolated health --json --deep exits 0|3 (3 = the signed-out auth fault, cert still whole)', r.status === 0 || r.status === 3, (r.stderr || r.stdout).slice(0, 300))
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
    check('…and on the bundled interpreter beside the bundle (vendor/python)', (pyCheck?.evidence ?? '').includes(join('vendor', 'python')), pyCheck?.evidence)
    check('isolated readiness row agrees (ready + BUNDLED + the interpreter beside the bundle)', pyReadiness?.state === 'ready' && (pyReadiness?.detail ?? '').includes('BUNDLED') && (pyReadiness?.detail ?? '').includes(join('vendor', 'python')), `${pyReadiness?.state}: ${pyReadiness?.detail}`)
  }
}

section('(5) the fallback — the pack absent, the adapter on the machine python3')
{
  process.env.PATH = originalPath
  process.env.MERCURY_PYTHON_VENDOR_DIR = join(scratch, 'no-pack')
  mkdirSync(process.env.MERCURY_PYTHON_VENDOR_DIR, { recursive: true })
  resetResolvers()
  check('without the pack the resolver sees no bundled interpreter', resolver.bundledPythonInterpreter() === null)
  const fallback = resolver.resolvePythonDebugAdapter()
  if (fallback.state === 'unavailable') {
    console.log('  [SKIP — LOUD] no machine python can carry debugpy here (the pack is the only road on this box):')
    console.log(`    ${fallback.reason}`)
  } else {
    check('the adapter source stays BUNDLED (the vendored debugpy tree)', fallback.provenance.adapterSource === 'bundled', fallback.provenance.adapterSource)
    check('the adapter command is a machine python, not the pack', !same(fallback.command, bundledBinary) && !fallback.command.includes(DIST_PYTHON), fallback.command)
    check('the program runs on that same machine python', fallback.debuggee === fallback.command, `${fallback.debuggee} vs ${fallback.command}`)
    await journey('fallback', 'forge-proof-fallback', null)
  }
  delete process.env.MERCURY_PYTHON_VENDOR_DIR
  resetResolvers()
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL DEBUGPY JOURNEY CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
