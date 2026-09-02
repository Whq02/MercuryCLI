#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
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

const outsideCwd = mkdtempSync(join(tmpdir(), 'builtin-tools-circuit-'))
const configDir = mkdtempSync(join(tmpdir(), 'builtin-tools-circuit-home-'))

interface Check {
  id: string
  status: string
  evidence: string
}
interface Cert {
  sections: { id: string; title: string; checks: Check[] }[]
}

function runDoctor(extraEnv: Record<string, string> = {}): Cert {
  const raw = execFileSync((process.execPath.includes('bun') ? 'node' : process.execPath), [dist, 'doctor', '--json', '--deep'], {
    cwd: outsideCwd,
    encoding: 'utf8',
    timeout: 420_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configDir,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'proof-key-builtin-tools-not-a-real-key',
      ...extraEnv,
    },
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
  console.log('── ONE integrated deep pass inside the artifact, outside the repo ──')
  const cert = runDoctor()

  const census = findCheck(cert, 'capability-census')
  check('fast: capability census ok in the artifact (no source-only registration)', census?.status === 'ok', `${census?.status}: ${census?.evidence}`)
  const integrations = findCheck(cert, 'capability-integrations')
  check('fast: lifecycle integrations reported', integrations?.status === 'ok', integrations?.evidence)
  const search = findCheck(cert, 'capability-search')
  check('fast: the declared-intent index ranks Git first IN the bundle', search?.status === 'ok', `${search?.status}: ${search?.evidence}`)

  const structure = findCheck(cert, 'structure-loop')
  check('deep: the structural closed loop (vendored compiler)', structure?.status === 'ok', `${structure?.status}: ${structure?.evidence}`)
  check('     …on the VENDORED facility', (structure?.evidence ?? '').includes('facility: vendored'), structure?.evidence)
  const git = findCheck(cert, 'git-graph')
  check('deep: the git work-graph journey (verified commits · stale refusal)', git?.status === 'ok', `${git?.status}: ${git?.evidence}`)
  const journey = findCheck(cert, 'journey-loop')
  check('deep: the application journey (real service · honest failure)', journey?.status === 'ok', `${journey?.status}: ${journey?.evidence}`)

  console.log('── bounded output ──')
  const oversized = cert.sections
    .flatMap(s => s.checks)
    .filter(c => (c.evidence ?? '').length > 600)
    .map(c => c.id)
  check('every evidence string is bounded (≤600 chars)', oversized.length === 0, oversized.join(', '))

  console.log('── authority-toggle honesty (all three, one flags-off pass) ──')
  const offCert = runDoctor({ MERCURY_STRUCTURE: '0', MERCURY_GIT_GRAPH: '0', MERCURY_JOURNEYS: '0' })
  check("MERCURY_STRUCTURE=0 reads 'off'", findCheck(offCert, 'structure-loop')?.status === 'off')
  check("MERCURY_GIT_GRAPH=0 reads 'off'", findCheck(offCert, 'git-graph')?.status === 'off')
  check("MERCURY_JOURNEYS=0 reads 'off'", findCheck(offCert, 'journey-loop')?.status === 'off')
  const offSearch = findCheck(offCert, 'capability-search')
  check("…and capability-search reads 'off' (no Git target), never a fault", offSearch?.status === 'off', `${offSearch?.status}: ${offSearch?.evidence}`)
} finally {
  rmSync(outsideCwd, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'builtin-tools ARTIFACT CIRCUIT: ALL GREEN' : `builtin-tools ARTIFACT CIRCUIT: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
