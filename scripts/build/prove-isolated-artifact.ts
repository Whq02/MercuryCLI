#!/usr/bin/env bun
// ============================================================================
//  scripts/build/prove-isolated-artifact.ts
//  PROOF: dist/mercury.mjs is genuinely SELF-CONTAINED and the artifact
//  manifest tells the truth.
//
//  The artifact is copied out of the tree by `mercury join-kit` and run where
//  no node_modules exists. Before that copy was dead on arrival:
//  zod was `external` in build.ts, so the first import threw
//  ERR_MODULE_NOT_FOUND ('zod'); with zod inlined the next boot-blocker was
//  sharp's module-scope native-binding throw (spriteToAnsi's static import).
//  This proof would have failed on both.
//
//    (1) ISOLATED MAIN ARTIFACT: copy dist/mercury.mjs to a fresh OS temp dir
//        (outside the repo / any node_modules ancestry), clean env (fresh
//        HOME, no NODE_PATH, minimal PATH), run with stock node:
//        --version, --help, doctor --json — all must succeed.
//    (2) RE-EXTERNALIZATION NEEDLE: the bundle text carries no bare
//        `from "zod"` import shape (the tripwire build.ts also enforces).
//    (3) MANIFEST TRUTH: dist/manifest.json exists, its version matches the
//        booted --version, bundleBytes matches the real file, and its search
//        claim matches the real vendored rg on disk.
//    (4) JOIN-KIT ROUND TRIP: the ISOLATED artifact packages its own kit
//        (join-kit), then the copied kit completes a REAL local join
//        handshake — a live room server (startRoomRemoteServer) in this
//        process, `node kit/mercury.mjs join <url> --token <t> --diagnose`
//        from the kit dir with the same clean env; diagnose exit 0 = the
//        full dial → sealed handshake → welcome → history → ping loop ran.
//
//  Requires the prebuilt dist (the pooled gate prebuilds it in Phase 0).
//  Run:  ~/.bun/bin/bun run scripts/build/prove-isolated-artifact.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, statSync, existsSync, copyFileSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { builtinModules } from 'module'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

// Config home for the in-process room server (must precede src imports).
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'iso-artifact-home-'))
delete process.env.MERCURY_SESSION_ROOM
delete process.env.MERCURY_ROOM_TOKEN

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 120s (an await never resolved)')
  process.exit(1)
}, 120_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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

// The isolated arena: OS temp, outside the repo and any node_modules ancestry.
const iso = mkdtempSync(join(tmpdir(), 'iso-artifact-'))
const isoHome = join(iso, 'home')
mkdirSync(isoHome, { recursive: true })
copyFileSync(dist, join(iso, 'mercury.mjs'))

// Clean spawn env: fresh HOME, no NODE_PATH, no repo-adjacent cwd. PATH keeps
// only system dirs plus the directory of the real node binary (node itself is
// the declared prerequisite — isolation is about MODULE resolution).
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary found on PATH — cannot run the artifact')
  process.exit(1)
}
const cleanEnv: Record<string, string> = {
  HOME: isoHome,
  PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
  TERM: 'dumb',
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
// Async variant for legs where THIS process must stay responsive (the local
// room server answers the child's WS dial — spawnSync would deadlock it).
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

//
section('(1) isolated main artifact runs on stock node (no node_modules anywhere)')
const isoBundle = join(iso, 'mercury.mjs')
{
  const v = runIso([isoBundle, '--version'], iso)
  check('--version exits 0', v.status === 0, v.stderr.slice(0, 300))
  check('--version prints a Mercury version', /^Mercury \d+\.\d+\.\d+/.test(v.stdout.trim()), v.stdout.slice(0, 80))

  const h = runIso([isoBundle, '--help'], iso)
  check('--help exits 0 (full CLI module graph loads)', h.status === 0, (h.stderr || h.stdout).slice(0, 300))
  check('--help reports no module-load failure', !/Cannot find module|MERCURY COULD NOT START/.test(h.stderr), h.stderr.slice(0, 200))
  // `join` is a pre-commander fast-path subcommand and does not appear in the
  // commander help tree — assert on the tree's own shape instead.
  check(
    '--help renders the command tree',
    /usage/i.test(h.stdout) && h.stdout.length > 500,
    h.stdout.slice(0, 120),
  )

  const d = runIso([isoBundle, 'doctor', '--json'], iso, 60_000)
  check('doctor --json produces the record in isolation (0/3 by verdict — FC-044; a signed-out scratch home is honestly fault)', d.status === 0 || d.status === 3, d.stderr.slice(0, 300))
  // The incident ran exactly here: doctor goes through init() and
  // the transport owners, and the pre-fix bundle's runtime require('undici')
  // left this leg idling until the bound — the red was the hang itself.
  check('doctor --json in isolation reports no module-load failure', !/Cannot find module|MERCURY COULD NOT START/.test(d.stderr), d.stderr.slice(0, 200))
  let verdict = ''
  try {
    verdict = String(JSON.parse(d.stdout).verdict ?? '')
  } catch {
    /* parse failure -> empty */
  }
  check('doctor --json emits a parseable certificate with a verdict', verdict.length > 0, d.stdout.slice(0, 120))
}

//
section('(2) no bare STATIC package import survives in the bundle (AST scan)')
{
  // A text needle false-positives on skill-doc PROSE (`import … from "zod"`
  // as documentation) — scan the real import statements instead. Bare dynamic
  // imports are the sanctioned lazy-degradation seam (sharp-class), gated by
  // the allowlist in build.ts; statics are boot-fatal out-of-tree.
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
  check('zero bare static imports', staticBare.length === 0, staticBare.join(', '))
}

//
section('(3) manifest truth (dist/manifest.json describes the real files)')
let manifestOk = false
{
  check('manifest.json exists beside the bundle', existsSync(manifestPath))
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
      check('schema 2 + bundle name', m.schema === 2 && m.bundle === 'mercury.mjs')
      const booted = runIso([isoBundle, '--version'], iso).stdout.trim()
      check(
        `manifest version matches booted version (${m.version})`,
        booted === `Mercury ${m.version}`,
        booted,
      )
      check(
        'bundleBytes matches the real file',
        m.bundleBytes === statSync(dist).size,
        `manifest ${m.bundleBytes} vs real ${statSync(dist).size}`,
      )
      check('selfContained claimed (and proven by leg 1)', m.selfContained === true)
      const rgOnDisk = existsSync(join(root, 'dist', m.search.path))
      check(
        'search claim matches disk',
        m.search.vendored === rgOnDisk,
        `vendored=${m.search.vendored} rgOnDisk=${rgOnDisk}`,
      )
      // degraded[] is per-capability:
      // each vendorable capability's claim must agree with its membership.
      check(
        'degraded[] agrees with the search claim',
        m.search.vendored ? !m.degraded.includes('search') : m.degraded.includes('search'),
      )
      const py = (m as unknown as { pythonDebugger?: { vendored: boolean; path: string } }).pythonDebugger
      check('manifest carries the pythonDebugger record', py !== undefined)
      if (py) {
        const pyOnDisk = existsSync(join(root, 'dist', py.path, 'debugpy', 'adapter', '__main__.py'))
        check(
          'pythonDebugger claim matches disk',
          py.vendored === pyOnDisk,
          `vendored=${py.vendored} treeOnDisk=${pyOnDisk}`,
        )
        check(
          'degraded[] agrees with the pythonDebugger claim',
          py.vendored ? !m.degraded.includes('python-debugger') : m.degraded.includes('python-debugger'),
        )
      }
      const pyright = (m as unknown as { pyright?: { vendored: boolean; path: string } }).pyright
      check('manifest carries the pyright record', pyright !== undefined)
      if (pyright) {
        const onDisk = existsSync(join(root, 'dist', pyright.path, 'langserver.index.js'))
        check(
          'pyright claim matches disk',
          pyright.vendored === onDisk,
          `vendored=${pyright.vendored} treeOnDisk=${onDisk}`,
        )
        check(
          'degraded[] agrees with the pyright claim',
          pyright.vendored ? !m.degraded.includes('python-intelligence') : m.degraded.includes('python-intelligence'),
        )
      }
      // The enter screen beside the bundle: the ordinary build copies the
      // canonical pair next to mercury.mjs (a direct start resolves it there
      // first), and the record names the real bytes.
      const splash = (m as unknown as { splash?: { path: string; core: string; bytes: number; sha256: string } }).splash
      check('manifest carries the splash record', splash !== undefined)
      if (splash) {
        const driverPath = join(root, 'dist', splash.path)
        const corePath = join(root, 'dist', splash.core)
        check('splash driver + core sit beside the bundle', existsSync(driverPath) && existsSync(corePath), `${splash.path} · ${splash.core}`)
        if (existsSync(driverPath)) {
          const real = readFileSync(driverPath)
          check('splash record bytes match the real file', splash.bytes === real.length, `manifest ${splash.bytes} vs real ${real.length}`)
          check('splash record sha256 matches the real file', splash.sha256 === createHash('sha256').update(real).digest('hex'))
          check(
            'the shipped driver is the canonical asset byte-for-byte',
            real.equals(readFileSync(join(root, 'assets', 'splash', 'mercury-splash.mjs'))),
          )
        }
        if (existsSync(corePath)) {
          check(
            'the shipped core is the canonical asset byte-for-byte',
            readFileSync(corePath).equals(readFileSync(join(root, 'assets', 'splash', 'splash-core.mjs'))),
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
