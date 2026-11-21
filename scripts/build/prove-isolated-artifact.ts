#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, statSync, existsSync, copyFileSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { builtinModules } from 'module'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'iso-artifact-home-'))
delete process.env.MERCURY_SESSION_ROOM
delete process.env.MERCURY_ROOM_TOKEN

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 120s (an await never resolved)')
  process.exit(1)
}, 120_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && hint ? ` — change: ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const root = resolve(import.meta.dir, '..', '..')
const dist = join(root, 'dist', 'mercury.mjs')
const manifestPath = join(root, 'dist', 'manifest.json')

console.log('============================================================')
console.log(' Isolated artifact — self-containment · manifest truth · kit')
console.log('============================================================')

if (!existsSync(dist)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}

const iso = mkdtempSync(join(tmpdir(), 'iso-artifact-'))
const isoHome = join(iso, 'home')
mkdirSync(isoHome, { recursive: true })
copyFileSync(dist, join(iso, 'mercury.mjs'))

const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary found on PATH — cannot run the artifact')
  process.exit(1)
}
const cleanEnv: Record<string, string> = {
  HOME: isoHome,
  PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
  TERM: 'dumb',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
}
const runIso = (
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync(nodeBin, args, {
    cwd,
    env: cleanEnv,
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const runIsoAsync = (
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise(resolvePromise => {
    const child = spawn(nodeBin, args, { cwd, env: cleanEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', status => {
      clearTimeout(killer)
      resolvePromise({ status, stdout, stderr })
    })
    child.on('error', () => {
      clearTimeout(killer)
      resolvePromise({ status: null, stdout, stderr: stderr + ' [spawn error]' })
    })
  })

section('(1) isolated main artifact runs on stock node (no node_modules anywhere)')
const isoBundle = join(iso, 'mercury.mjs')
{
  const v = runIso([isoBundle, '--version'], iso)
  check('--version exits 0', v.status === 0, v.stderr.slice(0, 300), 'the built dist/mercury.mjs fails to start on stock node alone; rebuild with bun run build.ts and read the stderr above')
  check('--version prints a Mercury version', /^Mercury \d+\.\d+\.\d+/.test(v.stdout.trim()), v.stdout.slice(0, 80), 'the --version output of dist/mercury.mjs must start with Mercury and a version number')

  const h = runIso([isoBundle, '--help'], iso)
  check('--help exits 0 (full CLI module graph loads)', h.status === 0, (h.stderr || h.stdout).slice(0, 300), 'a module the CLI loads is missing from dist/mercury.mjs; rebuild with bun run build.ts and read the output above')
  check('--help reports no module-load failure', !/Cannot find module|MERCURY COULD NOT START/.test(h.stderr), h.stderr.slice(0, 200), 'the module named in the stderr above must be bundled into dist/mercury.mjs, not left as a package import')
  check(
    '--help renders the command tree',
    /usage/i.test(h.stdout) && h.stdout.length > 500,
    h.stdout.slice(0, 120),
    'dist/mercury.mjs --help must print the usage text of the command tree',
  )

  const d = runIso([isoBundle, 'health', '--json'], iso, 60_000)
  check('health --json produces the record in isolation (0/3 by verdict — FC-044; a signed-out scratch home is honestly fault)', d.status === 0 || d.status === 3, d.stderr.slice(0, 300), 'the health verb of dist/mercury.mjs must exit 0 or 3 in a scratch home; read the stderr above')
  check('health --json in isolation reports no module-load failure', !/Cannot find module|MERCURY COULD NOT START/.test(d.stderr), d.stderr.slice(0, 200), 'the module named in the stderr above must be bundled into dist/mercury.mjs, not left as a package import')
  let verdict = ''
  try {
    verdict = String(JSON.parse(d.stdout).verdict ?? '')
  } catch {
  }
  check('health --json emits a parseable certificate with a verdict', verdict.length > 0, d.stdout.slice(0, 120), 'health --json must print one JSON record with a verdict field on stdout')
}

section('(2) no bare STATIC package import survives in the bundle (AST scan)')
{
  const text = readFileSync(dist, 'utf8')
  const builtin = new Set(builtinModules)
  const staticBare = [
    ...new Set(
      new Bun.Transpiler({ loader: 'js' })
        .scanImports(text)
        .filter(
          i =>
            i.kind === 'import-statement' &&
            !i.path.startsWith('node:') &&
            !i.path.startsWith('./') &&
            !i.path.startsWith('../') &&
            !builtin.has(i.path),
        )
        .map(i => i.path),
    ),
  ]
  check('zero bare static imports', staticBare.length === 0, staticBare.join(', '), 'the packages listed must be bundled into dist/mercury.mjs by build.ts, not left as bare static imports')
}

section('(3) manifest truth (dist/manifest.json describes the real files)')
let manifestOk = false
{
  check('manifest.json exists beside the bundle', existsSync(manifestPath), '', 'build.ts must write dist/manifest.json beside the bundle; rebuild with bun run build.ts')
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        schema: number
        version: string
        bundle: string
        bundleBytes: number
        selfContained: boolean
        search: { vendored: boolean; path: string }
        degraded: string[]
      }
      manifestOk = true
      check('schema 2 + bundle name', m.schema === 2 && m.bundle === 'mercury.mjs', `schema ${m.schema} bundle ${m.bundle}`, 'the manifest written by build.ts must carry schema 2 and bundle mercury.mjs')
      const booted = runIso([isoBundle, '--version'], iso).stdout.trim()
      check(
        `manifest version matches booted version (${m.version})`,
        booted === `Mercury ${m.version}`,
        booted,
        'the version in dist/manifest.json must equal the version dist/mercury.mjs prints; rebuild both together with bun run build.ts',
      )
      check(
        'bundleBytes matches the real file',
        m.bundleBytes === statSync(dist).size,
        `manifest ${m.bundleBytes} vs real ${statSync(dist).size}`,
        'dist/manifest.json is stale against dist/mercury.mjs; rebuild with bun run build.ts',
      )
      check('selfContained claimed (and proven by leg 1)', m.selfContained === true, '', 'the manifest written by build.ts must claim selfContained true')
      const rgOnDisk = existsSync(join(root, 'dist', m.search.path))
      check(
        'search claim matches disk',
        m.search.vendored === rgOnDisk,
        `vendored=${m.search.vendored} rgOnDisk=${rgOnDisk}`,
        'the search record in dist/manifest.json must match whether the ripgrep binary sits under dist; rebuild with bun run build.ts',
      )
      check(
        'degraded[] agrees with the search claim',
        m.search.vendored ? !m.degraded.includes('search') : m.degraded.includes('search'),
        '',
        'degraded in dist/manifest.json must list search exactly when the search record says not vendored; rebuild with bun run build.ts',
      )
      const py = (m as unknown as { pythonDebugger?: { vendored: boolean; path: string } }).pythonDebugger
      check('manifest carries the pythonDebugger record', py !== undefined, '', 'build.ts must write a pythonDebugger record into dist/manifest.json')
      if (py) {
        const pyOnDisk = existsSync(join(root, 'dist', py.path, 'debugpy', 'adapter', '__main__.py'))
        check(
          'pythonDebugger claim matches disk',
          py.vendored === pyOnDisk,
          `vendored=${py.vendored} treeOnDisk=${pyOnDisk}`,
          'the pythonDebugger record in dist/manifest.json must match the debugpy tree under dist; rebuild with bun run build.ts',
        )
        check(
          'degraded[] agrees with the pythonDebugger claim',
          py.vendored ? !m.degraded.includes('python-debugger') : m.degraded.includes('python-debugger'),
          '',
          'degraded in dist/manifest.json must list python-debugger exactly when the pythonDebugger record says not vendored',
        )
      }
      const pyright = (m as unknown as { pyright?: { vendored: boolean; path: string } }).pyright
      check('manifest carries the pyright record', pyright !== undefined, '', 'build.ts must write a pyright record into dist/manifest.json')
      if (pyright) {
        const onDisk = existsSync(join(root, 'dist', pyright.path, 'langserver.index.js'))
        check(
          'pyright claim matches disk',
          pyright.vendored === onDisk,
          `vendored=${pyright.vendored} treeOnDisk=${onDisk}`,
          'the pyright record in dist/manifest.json must match the pyright tree under dist; rebuild with bun run build.ts',
        )
        check(
          'degraded[] agrees with the pyright claim',
          pyright.vendored ? !m.degraded.includes('python-intelligence') : m.degraded.includes('python-intelligence'),
          '',
          'degraded in dist/manifest.json must list python-intelligence exactly when the pyright record says not vendored',
        )
      }
      const splash = (m as unknown as { splash?: { path: string; core: string; bytes: number; sha256: string } }).splash
      check('manifest carries the splash record', splash !== undefined, '', 'build.ts must write a splash record into dist/manifest.json')
      if (splash) {
        const driverPath = join(root, 'dist', splash.path)
        const corePath = join(root, 'dist', splash.core)
        check('splash driver + core sit beside the bundle', existsSync(driverPath) && existsSync(corePath), `${splash.path} · ${splash.core}`, 'the splash driver and core named by the manifest must be copied under dist; rebuild with bun run build.ts')
        if (existsSync(driverPath)) {
          const real = readFileSync(driverPath)
          check('splash record bytes match the real file', splash.bytes === real.length, `manifest ${splash.bytes} vs real ${real.length}`, 'the splash bytes in dist/manifest.json are stale against the shipped driver; rebuild with bun run build.ts')
          check('splash record sha256 matches the real file', splash.sha256 === createHash('sha256').update(real).digest('hex'), '', 'the splash sha256 in dist/manifest.json is stale against the shipped driver; rebuild with bun run build.ts')
          check(
            'the shipped driver is the canonical asset byte-for-byte',
            real.equals(readFileSync(join(root, 'assets', 'splash', 'mercury-splash.mjs'))),
            '',
            'the dist driver differs from assets/splash/mercury-splash.mjs; rebuild with bun run build.ts',
          )
        }
        if (existsSync(corePath)) {
          check(
            'the shipped core is the canonical asset byte-for-byte',
            readFileSync(corePath).equals(readFileSync(join(root, 'assets', 'splash', 'splash-core.mjs'))),
            '',
            'the dist core differs from assets/splash/splash-core.mjs; rebuild with bun run build.ts',
          )
        }
      }
    } catch (e) {
      check('manifest parses', false, String(e).slice(0, 200))
    }
  }
}
if (!manifestOk) {
  console.log('  (manifest legs failed — rebuild dist with the current build.ts)')
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL ISOLATED-ARTIFACT CHECKS PASS')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
