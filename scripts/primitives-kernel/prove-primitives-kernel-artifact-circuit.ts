#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-artifact-circuit.ts — the
//  BUILT-ARTIFACT circuit. Drives dist/mercury.mjs from a temp cwd OUTSIDE
//  the repository (zero paid calls) and proves the integrated primitive
//  journey INSIDE the bundle:
//
//    · fast: the ARCHITECTURE PRIMITIVES rows are ok in the artifact —
//      owner vocabulary, the four primitive resource kinds, the execution
//      census (no unclassified domain), record consistency, view coverage,
//      kernel capabilities (no source-only registration side effects);
//    · deep: the primitive JOURNEY probe runs inside the bundle (owner →
//      execution lifecycle → observed mutation → exactly-once receipt →
//      transaction → evidence → owner→execution traversal → canonical
//      stream fixture → clean disposal), beside the real-child service
//      lifecycle, the EMBEDDED workshop runtimes (python honest-or-ok),
//      the anchored change transaction, and envelope normalization;
//    · restart honesty: a durable service record CLAIMING life (dead pid,
//      forged start token) is reconciled by a FRESH artifact process —
//      recorded state downgrades from process-table truth and the durable
//      record is REWRITTEN honest (Law 6: reconcile, never resurrect).
//
//  Run:  ~/.bun/bin/bun run scripts/primitives-kernel/prove-primitives-kernel-artifact-circuit.ts
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const repoRoot = resolve(import.meta.dir, '..', '..')
const dist = join(repoRoot, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.log('dist/mercury.mjs missing — building once')
  execFileSync(`${process.env.HOME}/.bun/bin/bun`, ['run', 'build.ts'], {
    cwd: repoRoot,
    stdio: 'inherit',
    timeout: 300_000,
  })
}

const outsideCwd = mkdtempSync(join(tmpdir(), 'axiom-circuit-'))
const configDir = mkdtempSync(join(tmpdir(), 'axiom-circuit-home-'))

interface Check {
  id: string
  status: string
  evidence: string
}
interface Cert {
  verdict: string
  sections: { id: string; title: string; checks: Check[] }[]
}

function runDoctor(args: string[]): Cert {
  const raw = execFileSync((process.execPath.includes('bun') ? 'node' : process.execPath), [dist, 'doctor', '--json', ...args], {
    cwd: outsideCwd,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, MERCURY_CONFIG_DIR: configDir },
  })
  return JSON.parse(raw) as Cert
}

function findCheck(cert: Cert, id: string): Check | undefined {
  for (const s of cert.sections) {
    const hit = s.checks.find(c => c.id === id)
    if (hit) return hit
  }
  return undefined
}

try {
  console.log('── fast: ARCHITECTURE PRIMITIVES inside the artifact ──')
  const fast = runDoctor([])
  const archSection = fast.sections.find(s => s.title === 'ARCHITECTURE PRIMITIVES')
  check('the ARCHITECTURE PRIMITIVES section exists in the artifact', archSection !== undefined)
  for (const id of [
    'owner-vocabulary',
    'primitive-resources',
    'execution-census',
    'primitive-consistency',
    'view-coverage',
    'runtime-kernel',
  ]) {
    const row = findCheck(fast, id)
    check(`fast: ${id} → ok`, row !== undefined && row.status === 'ok',
      row ? `${row.status}: ${row.evidence.slice(0, 120)}` : 'row missing')
  }
  const census = findCheck(fast, 'execution-census')
  check('no unclassified execution domain inside the bundle',
    census?.evidence.includes('all census-classified') === true, census?.evidence)

  console.log('\n── deep: the primitive journey INSIDE the bundle ──')
  const deep = runDoctor(['--deep'])
  const journey = findCheck(deep, 'axiom-primitives')
  check('the primitive journey probe ran and passed', journey?.status === 'ok',
    journey ? `${journey.status}: ${journey.evidence.slice(0, 160)}` : 'row missing')
  check('journey evidence names every leg',
    journey !== undefined &&
      ['execution lifecycle', 'receipt→transaction→evidence', 'owner→execution traversal', 'canonical stream fixture', 'clean disposal']
        .every(leg => journey.evidence.includes(leg)),
    journey?.evidence)
  const legs: Array<{ id: string; allow: string[]; why: string }> = [
    { id: 'service-lifecycle', allow: ['ok'], why: 'a REAL service child through the plane-projected manager' },
    { id: 'workshop-js', allow: ['ok'], why: 'the EMBEDDED worker (retained state)' },
    { id: 'workshop-py', allow: ['ok', 'info'], why: 'the python kernel or HONEST unavailability' },
    { id: 'change-transaction', allow: ['ok'], why: 'the anchored change + exactly-once receipt' },
    { id: 'agent-envelope', allow: ['ok'], why: 'envelope normalization from observed evidence' },
    { id: 'effect-observer', allow: ['ok'], why: 'the ONE observation chokepoint' },
  ]
  for (const leg of legs) {
    const row = findCheck(deep, leg.id)
    check(`deep: ${leg.id} → ${leg.allow.join('|')} (${leg.why})`,
      row !== undefined && leg.allow.includes(row.status),
      row ? `${row.status}: ${row.evidence.slice(0, 140)}` : 'row missing')
  }

  console.log('\n── restart honesty: reconcile, never resurrect ──')
  // A durable record CLAIMING life: dead pid + forged start token. A fresh
  // artifact process must downgrade it from process-table truth.
  // The bundle slugs its REAL cwd (macOS tmp resolves under /private).
  const slug = realpathSync(outsideCwd).replace(/[^a-zA-Z0-9]/g, '-').slice(-80)
  const servicesDir = join(configDir, 'services', slug)
  mkdirSync(servicesDir, { recursive: true })
  // Mint a real-but-dead pid so the claim is PLAUSIBLE, not malformed.
  const dead = execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], {
    encoding: 'utf8',
  }).trim()
  const staleRecord = {
    schema: 1,
    spec: {
      name: 'stale-svc',
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: realpathSync(outsideCwd),
      readiness: [],
      readinessMode: 'all',
      restart: 'never',
      lifecycle: 'project',
    },
    state: 'running',
    pid: Number(dead),
    startToken: 'forged-token-from-a-previous-boot',
    startedAt: Date.now() - 60_000,
    stoppedAt: null,
    lastExitCode: null,
    explicitStop: false,
    restartCount: 0,
    readiness: [],
    logFile: join(servicesDir, 'stale-svc.log'),
    ownerSessionId: 'previous-session',
    updatedAt: Date.now() - 60_000,
  }
  writeFileSync(join(servicesDir, 'stale-svc.json'), JSON.stringify(staleRecord, null, 2))

  const after = runDoctor([])
  const servicesRow = findCheck(after, 'services-fast')
  check('the fresh artifact process sees the record but claims NO life',
    servicesRow !== undefined &&
      servicesRow.evidence.includes('1 record(s)') &&
      servicesRow.evidence.includes('0 live'),
    servicesRow?.evidence)
  const rewritten = JSON.parse(readFileSync(join(servicesDir, 'stale-svc.json'), 'utf8')) as {
    state: string
    pid: number | null
  }
  check('the durable record was REWRITTEN honest (failed/stopped, pid cleared)',
    ['failed', 'stopped'].includes(rewritten.state) && rewritten.pid === null,
    `state=${rewritten.state} pid=${rewritten.pid}`)

  console.log('\n── no repository-relative runtime dependency ──')
  check('the circuit ran from a temp cwd outside the repo',
    !outsideCwd.startsWith(repoRoot))
} finally {
  rmSync(outsideCwd, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ axiom artifact circuit — the primitive journey holds in dist')
  process.exit(0)
} else {
  console.log(` ❌ axiom artifact circuit — ${failures} check(s) failed`)
  process.exit(1)
}
