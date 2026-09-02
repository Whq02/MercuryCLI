#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-cli-verbs-exit.ts — the headless `mercury
// extensions` verbs END.
//
//  The BINARY's add / install --yes / approve / uninstall --yes finished
//  their work and kept running: init's API warm-up (utils/apiPreconnect, a
//  HEAD to the API origin) ran for every subcommand, and its socket was the
//  one live handle left after a verb's receipt — on a stalled origin the
//  loop lived until the warm-up's connect timed out (11 s over http, 31 s
//  over https on the pre-fix bundle; ESTABLISHED for 55 minutes in the
//  field). The warm-up now belongs to the ROOT action alone (main.tsx's
//  preAction arm), so a headless verb opens no request and ends the moment
//  its work does.
//
//  Every leg drives the BUILT bundle against a seeded scratch home, the
//  suite's fixture source, and a black-hole origin as ANTHROPIC_BASE_URL —
//  a loopback server (its own process) that accepts every connection and
//  never answers, the stalled shape that held the field's verbs:
//    V1  add <folder>                                 → exit 0 within the bound, the source receipt
//    V2  install kitchen-sink --yes                   → exit 0, 'approved and on'
//    V3  approve kitchen-sink@fixture-source (no TTY) → exit 1, the scripted-approval remedy
//    V4  uninstall kitchen-sink@fixture-source --yes  → exit 0, 'uninstalled'
//    V5  list --json                                  → exit 0, a parseable record
//    V6  the origin accepted NO connection across the five verbs
//  Poison controls:
//    P1  the bound detector trips on a child that holds a socket to the
//        black hole open past the bound (the hung shape, synthesised)
//    P2  with MERCURY_BASE_DIST naming a pre-fix bundle, its `add` runs past
//        the bound against the same origin ([SKIP] when unset — the lane
//        receipt records the pre-fix bundle's 11 s / 31 s shapes)
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const BOUND_MS = 5_000
const PORT = 36820
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-cli-verbs-exit-'))
const HOME = join(SCRATCH, 'home')
const CWD = join(SCRATCH, 'project')
const SRC = join(SCRATCH, 'fixture-source')
const ACCEPT_LOG = join(SCRATCH, 'blackhole-accepts.log')
mkdirSync(CWD, { recursive: true })
cpSync(join(import.meta.dir, 'fixtures', 'fixture-source'), SRC, { recursive: true })
seedFirstRun(HOME, [CWD])

// ── the black-hole origin: its own process, one line per accepted socket ──
const blackHole = spawn(
  'node',
  [
    '-e',
    `const net=require('net');const fs=require('fs');const srv=net.createServer(s=>{fs.appendFileSync(process.env.BH_LOG,'accept\\n');s.on('error',()=>{})});srv.listen(${PORT},'127.0.0.1',()=>process.stdout.write('ready\\n'))`,
  ],
  { env: { ...process.env, BH_LOG: ACCEPT_LOG }, stdio: ['ignore', 'pipe', 'inherit'] },
)
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('black hole never became ready')), 5_000)
  blackHole.stdout.on('data', d => {
    if (String(d).includes('ready')) {
      clearTimeout(timer)
      resolve()
    }
  })
})
const accepts = (): number => (existsSync(ACCEPT_LOG) ? readFileSync(ACCEPT_LOG, 'utf8').split('\n').filter(Boolean).length : 0)

type Outcome = { exited: boolean; code: number | null; ms: number; out: string; err: string }
/** Run one child with stdin closed; kill it when the bound passes. */
function bounded(argv: string[], env: Record<string, string | undefined>, bin = BIN): Promise<Outcome> {
  return new Promise(resolvePromise => {
    const started = Date.now()
    // An empty `bin` runs node itself on argv (the P1 socket holder).
    const child = spawn('node', bin === '' ? argv : [bin, ...argv], { cwd: CWD, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolvePromise({ exited: false, code: null, ms: Date.now() - started, out, err })
    }, BOUND_MS)
    child.on('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ exited: true, code, ms: Date.now() - started, out, err })
    })
  })
}
const verbEnv = {
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_HOME: '',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  NODE_ENV: undefined,
  CI: undefined,
}
const verb = (args: string[], bin?: string): Promise<Outcome> => bounded(['extensions', ...args], verbEnv, bin)
const shape = (o: Outcome): string => `${o.exited ? `exit ${o.code}` : 'HELD past the bound'} after ${o.ms}ms`

try {
  console.log('V1 add <folder> ends with its receipt')
  const v1 = await verb(['add', SRC])
  check('add exits 0 within the bound', v1.exited && v1.code === 0, shape(v1))
  check('…with the source receipt', v1.out.includes('added fixture-source (folder)'), v1.out.trim().split('\n')[0] ?? '')

  console.log('V2 install --yes ends with its receipt')
  const v2 = await verb(['install', 'kitchen-sink', '--yes'])
  check('install --yes exits 0 within the bound', v2.exited && v2.code === 0, shape(v2))
  check('…approved and on', v2.out.includes('approved and on'), v2.out.trim().split('\n').pop() ?? '')

  console.log('V3 approve without --yes on a TTY-less run refuses and ends')
  const v3 = await verb(['approve', 'kitchen-sink@fixture-source'])
  check('approve exits 1 within the bound', v3.exited && v3.code === 1, shape(v3))
  check('…naming the scripted-approval remedy', v3.err.includes('re-run with --yes'), v3.err.trim().split('\n').pop() ?? '')

  console.log('V4 uninstall --yes ends with its receipt')
  const v4 = await verb(['uninstall', 'kitchen-sink@fixture-source', '--yes'])
  check('uninstall --yes exits 0 within the bound', v4.exited && v4.code === 0, shape(v4))
  check('…uninstalled', v4.out.includes('uninstalled'), v4.out.trim().split('\n').pop() ?? '')

  console.log('V5 list --json ends with the parseable roster')
  const v5 = await verb(['list', '--json'])
  check('list --json exits 0 within the bound', v5.exited && v5.code === 0, shape(v5))
  check(
    '…with a parseable record',
    (() => {
      try {
        JSON.parse(v5.out)
        return true
      } catch {
        return false
      }
    })(),
    v5.out.trim().slice(0, 60),
  )

  console.log('V6 no verb touched the API origin')
  check('the black-hole origin accepted no connection across the five verbs', accepts() === 0, `accepts=${accepts()}`)

  // V7 — the OPERATOR's shape: the verb typed inside a GIT CHECKOUT with the
  // terminal's stdin open. The git watching cache (utils/git/gitFilesystem)
  // armed persistent fs.watchFile pollers on HEAD/config/the branch ref
  // through one cached branch read, so `list --json` printed its roster and
  // then never ended (held 60 s+ on a repo cwd; the
  // V5 leg above runs from a plain folder and never saw it). Poison = the
  // pre-fix pollers (persistent:true) — HELD past the bound.
  console.log('V7 list --json inside a git checkout, stdin open, still ends')
  const REPO_CWD = join(SCRATCH, 'checkout')
  mkdirSync(REPO_CWD, { recursive: true })
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid', HOME: SCRATCH }
  const git = (args: string[]): boolean => spawnSync('git', args, { cwd: REPO_CWD, env: gitEnv, stdio: 'ignore' }).status === 0
  const repoReady = git(['init', '-q']) && (writeFileSync(join(REPO_CWD, 'README'), 'proof\n'), git(['add', 'README'])) && git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'proof'])
  if (!repoReady) {
    console.log('  [SKIP] git unavailable — the checkout leg needs a real repo')
  } else {
    seedFirstRun(HOME, [REPO_CWD])
    const v7 = await new Promise<Outcome>(resolvePromise => {
      const started = Date.now()
      const child = spawn('node', [BIN, 'extensions', 'list', '--json'], { cwd: REPO_CWD, env: { ...process.env, ...verbEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', d => (out += String(d)))
      child.stderr.on('data', d => (err += String(d)))
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        resolvePromise({ exited: false, code: null, ms: Date.now() - started, out, err })
      }, BOUND_MS)
      child.on('exit', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ exited: true, code, ms: Date.now() - started, out, err })
      })
    })
    check('list --json from a git checkout with stdin open exits 0 within the bound', v7.exited && v7.code === 0, shape(v7))
    check('…and answered the roster before ending', v7.out.includes('"extensions"'), v7.out.trim().slice(0, 60))
  }

  console.log('P1 poison: the bound detector trips on a child that holds a socket open')
  const holder = await bounded(
    ['-e', `require('net').connect(${PORT},'127.0.0.1',()=>{}).on('error',()=>{});setTimeout(()=>{}, 60000)`],
    verbEnv,
    '',
  ).catch(() => null)
  // `bin` is '' so argv[0] is the -e flag: node -e <script>.
  check('a socket-holding child is reported HELD past the bound', holder !== null && !holder.exited && holder.ms >= BOUND_MS, holder ? shape(holder) : 'no outcome')
  check('…and the origin saw its connection (the detector observed a real socket)', accepts() === 1, `accepts=${accepts()}`)

  console.log('P2 poison: a pre-fix bundle runs past the bound (MERCURY_BASE_DIST)')
  const baseDist = process.env.MERCURY_BASE_DIST
  if (baseDist && existsSync(join(baseDist, 'mercury.mjs'))) {
    const before = accepts()
    const p2 = await verb(['add', SRC], join(baseDist, 'mercury.mjs'))
    check('the pre-fix bundle is HELD past the bound by its warm-up socket', !p2.exited, shape(p2))
    check('…and it is the one that connected to the origin', accepts() === before + 1, `accepts=${accepts()}`)
  } else {
    console.log('  [SKIP] MERCURY_BASE_DIST unset — the base dist shape measured 11 s over http, 31 s over https')
  }
} finally {
  blackHole.kill('SIGKILL')
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? 'CLI VERBS EXIT LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
