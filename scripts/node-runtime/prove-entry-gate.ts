#!/usr/bin/env bun
// ============================================================================
//  scripts/node-runtime/prove-entry-gate.ts — U2: the runtime gate at
//  the earliest Mercury-owned entry seam.
//    (1) structural: cli.tsx runs evaluateNodeRuntime as main()'s first work,
//        BEFORE the --version fast-path; setup() carries no duplicate
//        floor (the seam is the ONE owner)
//    (2) the built bundle carries the refusal copy (the gate survives
//        minification into the artifact)
//    (3) real spawns on THIS (supported) runtime: --version, --help and
//        doctor --json succeed through the gate (doctor --json projects
//        observed/label/range/verdict from the owner); the retired join-kit
//        verb answers its typed reason THROUGH the gate (never an unknown
//        verb, never a crash)
//    (4) real-refusal leg: when an older Node is discoverable locally it must
//        receive the concise refusal (qualify-artifact.sh); otherwise a LOUD
//        skip — the hosted gate.yml Node-22 leg is the standing owner
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { NODE_SUPPORT } from '../../src/utils/runtime/nodePolicy.js'

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

//
section('(1) the gate precedes every dispatch (structural)')
const cli = readFileSync(join(REPO, 'src/entrypoints/cli.tsx'), 'utf8')
check('cli.tsx imports the ONE policy owner', cli.includes("from '../utils/runtime/nodePolicy.js'"))
const gateIdx = cli.indexOf('evaluateNodeRuntime(process.versions?.node)')
const fastPathIdx = cli.indexOf("args[0] === '--version'")
check('gate call exists in main()', gateIdx !== -1)
check('gate runs BEFORE the --version fast-path', gateIdx !== -1 && fastPathIdx !== -1 && gateIdx < fastPathIdx)
check('gate refuses non-zero', cli.includes('console.error(nodeRefusalMessage(nodeDecision))') && /nodeRefusalMessage\(nodeDecision\)\);\s*\n\s*process\.exit\(1\)/.test(cli))
const setupSrc = readFileSync(join(REPO, 'src/setup.ts'), 'utf8')
check('setup() carries no duplicate Node floor', !setupSrc.includes('requires Node.js version 18') && !/parseInt\(nodeVersion\) < 18/.test(setupSrc))
// Bun is the build/verification runtime (truth 3) — its node-compat shim
// (e.g. 24.3.0) is not the product Node claim, so bun-hosted execution is
// exempt BY NAME (the proof estate drives the bundle under bun).
check('gate exempts Bun-hosted execution by name', cli.includes('if (!process.versions?.bun)') && cli.includes('node-compat shim'))

//
section('(2) the REAL bundle refuses unsupported runtimes on every route')
const dist = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.log('  [SKIP] dist/mercury.mjs absent — the pooled gate prebuilds it; build to run legs (2)-(4)')
} else {
  const bundle = readFileSync(dist, 'utf8')
  check('bundle carries the refusal copy (contiguous literal)', bundle.includes('Mercury currently supports '))

  // Behavioral refusal: a --import preload pins process.versions.node to an
  // arbitrary version BEFORE the bundle's entry runs — the whole decision,
  // message, and exit path are the REAL shipped code (the true older-binary
  // leg rides gate.yml's Node 22 job; this proves the same artifact locally).
  const fakeDir = mkdtempSync(join(tmpdir(), 'uplift-fakever-'))
  const fakeFor = (v: string): string => {
    const p = join(fakeDir, `fake-${v.replace(/[^0-9a-z.]/gi, '_')}.mjs`)
    require('node:fs').writeFileSync(p, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(v)}, configurable: true })\n`)
    return p
  }
  const refusal = (v: string, args: string[]): { status: number | null; out: string } => {
    const r = spawnSync('node', ['--import', fakeFor(v), dist, ...args], { encoding: 'utf8', timeout: 60_000 })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  for (const [v, args] of [
    ['22.21.0', ['--version']],
    ['22.21.0', ['--help']],
    ['22.21.0', ['join-kit', '--help']],
    ['22.21.0', ['doctor', '--json']],
    ['20.19.0', ['--version']],
    ['24.10.9', ['--version']],
  ] as Array<[string, string[]]>) {
    const r = refusal(v, args)
    check(
      `faked ${v} · ${args.join(' ')} → concise non-zero refusal`,
      r.status === 1 && r.out.includes(NODE_SUPPORT.label) && r.out.includes(NODE_SUPPORT.range) && !/^\s+at /m.test(r.out),
      `status=${r.status} out=${r.out.slice(0, 160)}`,
    )
  }
  {
    const r = refusal('25.0.0', ['--version'])
    check('faked 25.0.0 → unqualified-major refusal (the upper bound is ENFORCED)', r.status === 1 && r.out.includes('not yet qualified'), r.out.slice(0, 160))
  }
  {
    const r = refusal('26.1.0', ['--version'])
    check('faked 26.1.0 → unqualified-major refusal', r.status === 1 && r.out.includes('not yet qualified'), r.out.slice(0, 160))
  }
  rmSync(fakeDir, { recursive: true, force: true })

  //
  section('(3) every route succeeds through the gate on THIS supported runtime')
  const home = mkdtempSync(join(tmpdir(), 'uplift-gate-home-'))
  const env = {
    ...process.env,
    HOME: home,
    MERCURY_CONFIG_DIR: join(home, '.claude'),
    CI: 'true',
    TERM: 'dumb',
    ANTHROPIC_API_KEY: 'proof-key-uplift-not-a-real-key',
  }
  const run = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync('node', [dist, ...args], { encoding: 'utf8', env, timeout: 120_000 })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const ver = run(['--version'])
  check('--version exits 0 + identity', ver.status === 0 && ver.out.includes('Mercury'), ver.out.slice(0, 120))
  {
    // bun-hosted execution passes the gate (the exemption is real, not just text)
    const bunBin = `${process.env.HOME}/.bun/bin/bun`
    const r = spawnSync(bunBin, [dist, '--version'], { encoding: 'utf8', env, timeout: 60_000 })
    check('bun-hosted --version exits 0 (verification-runtime exemption)', r.status === 0 && `${r.stdout}`.includes('Mercury'), `status=${r.status} ${`${r.stdout}${r.stderr}`.slice(0, 120)}`)
  }
  const help = run(['--help'])
  check('--help exits 0', help.status === 0, help.out.slice(0, 120))
  const kit = run(['join-kit', '--help'])
  check('the retired join-kit verb answers its typed reason through the gate (exit 2, never unknown-verb)', kit.status === 2 && /retired — a new multiplayer is being built on the channel/.test(kit.out), kit.out.slice(0, 160))
  const doc = run(['doctor', '--json'])
  check('doctor --json exits 0', doc.status === 0, doc.out.slice(0, 200))
  try {
    const jsonStart = doc.out.indexOf('{')
    const cert = JSON.parse(doc.out.slice(jsonStart)) as {
      nodeRuntime?: { observed: string | null; label: string; range: string; verdict: string }
    }
    // observed must equal the CHILD's real node (this prover runs under bun,
    // whose process.versions.node is a compat shim — never compare to it)
    const realNode = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 30_000 }).stdout.trim()
    check(
      'doctor --json projects observed/label/range/verdict from the owner',
      cert.nodeRuntime?.verdict === 'supported' &&
        cert.nodeRuntime.label === NODE_SUPPORT.label &&
        cert.nodeRuntime.range === NODE_SUPPORT.range &&
        cert.nodeRuntime.observed === realNode,
      JSON.stringify(cert.nodeRuntime),
    )
  } catch (e) {
    check('doctor --json parses', false, String(e))
  }
  rmSync(home, { recursive: true, force: true })

  //
  section('(4) real-refusal leg (older Node, when discoverable)')
  const candidates: string[] = []
  const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvmDir)) {
    for (const d of require('node:fs').readdirSync(nvmDir) as string[]) {
      if (/^v(1[0-9]|2[0-3])\./.test(d)) candidates.push(join(nvmDir, d, 'bin'))
    }
  }
  for (const p of ['/opt/homebrew/opt/node@20/bin', '/opt/homebrew/opt/node@22/bin', '/usr/local/opt/node@22/bin']) {
    if (existsSync(join(p, 'node'))) candidates.push(p)
  }
  if (candidates.length === 0) {
    console.log('  [SKIP] no older Node runtime on this machine — the hosted gate.yml Node-22 leg owns the real-process refusal')
  } else {
    const bin = candidates[0]!
    const r = spawnSync('bash', [join(REPO, 'scripts/node-runtime/qualify-artifact.sh'), dist, 'expect-refusal'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      timeout: 120_000,
    })
    check(`older node at ${bin} receives the concise refusal`, r.status === 0, `${r.stdout}${r.stderr}`.slice(0, 300))
  }
}

// the qualification harness itself stays sane
const qual = readFileSync(join(REPO, 'scripts/node-runtime/qualify-artifact.sh'), 'utf8')
check('qualify-artifact asserts label + range + no stack on refusal', qual.includes('Node 24 LTS') && qual.includes(NODE_SUPPORT.minimum) && qual.includes('stack trace'))
try {
  execFileSync('bash', ['-n', join(REPO, 'scripts/node-runtime/qualify-artifact.sh')])
  check('qualify-artifact.sh survives bash -n', true)
} catch (e) {
  check('qualify-artifact.sh survives bash -n', false, String(e))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ENTRY GATE PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
