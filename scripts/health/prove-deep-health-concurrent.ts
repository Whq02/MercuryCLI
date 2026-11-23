#!/usr/bin/env bun

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface HealthCheck {
  id: string
  status: string
  probe?: string
  evidence?: string
}

interface HealthCert {
  verdict: string
  sections: Array<{ id: string; checks: HealthCheck[] }>
}

interface RunResult {
  status: number
  cert: HealthCert | null
  stderr: string
}

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = process.env.MERCURY_PROOF_DIST || join(repoRoot, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.error(`${dist} missing — run bun run build.ts before the proof`)
  process.exit(1)
}

const nodeBin = process.execPath.includes('bun') ? 'node' : process.execPath

function findCheck(cert: HealthCert | null, id: string): HealthCheck | undefined {
  if (!cert) return undefined
  for (const section of cert.sections) {
    const hit = section.checks.find(c => c.id === id)
    if (hit) return hit
  }
  return undefined
}

const NEUTRAL = new Set(['ok', 'info', 'off'])
function notOk(cert: HealthCert | null): HealthCheck[] {
  return cert ? cert.sections.flatMap(section => section.checks.filter(c => !NEUTRAL.has(c.status))) : []
}

const machineTag = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const bundledApps = join(repoRoot, 'src', 'integrations', 'extensions', 'bundled')
const trueHere = new Map<string, { why: string; says: string }>()
if (!existsSync(join(repoRoot, 'vendor', 'bash', machineTag))) {
  trueHere.set('shell', { why: `this checkout holds no vendor/bash/${machineTag}`, says: 'no bash pack for' })
}
const unreleased = readdirSync(bundledApps).filter(name => {
  const lock = join(bundledApps, name, 'server', `${name}.lock.json`)
  return existsSync(lock) && (JSON.parse(readFileSync(lock, 'utf8')) as { platforms?: Record<string, unknown> }).platforms?.[machineTag] === undefined
})
if (unreleased.length > 0) {
  trueHere.set('extensions', { why: `${unreleased.join(', ')} have no release for ${machineTag}`, says: ' partial · 0 broken' })
}
const certifiedHere = trueHere.size === 0 ? 'ends certified' : `cautions on ${[...trueHere].map(([id, fact]) => `${id} alone where ${fact.why}`).join(' and on ')}, every other check certified`

function runHealthDeep(cwd: string, configDir: string, extraArgs: string[] = []): Promise<RunResult> {
  return new Promise(resolvePromise => {
    execFile(
      nodeBin,
      [dist, 'health', '--json', '--deep', ...extraArgs],
      {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          MERCURY_CONFIG_DIR: configDir,
          MERCURY_CREDENTIAL_STORE: 'file',
          ANTHROPIC_API_KEY: 'proof-key-deep-health-concurrent',
        },
      },
      (err, stdout, stderr) => {
        const status = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        let cert: HealthCert | null = null
        try {
          cert = JSON.parse(stdout) as HealthCert
        } catch {
          cert = null
        }
        resolvePromise({ status, cert, stderr })
      },
    )
  })
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'health-deep-concurrent-'))
  try {
    console.log('§1 two simultaneous full health --json --deep runs both end certified')
    {
      const jobs = [1, 2].map(i => {
        const cwd = join(scratch, `full-cwd-${i}`)
        const home = join(scratch, `full-home-${i}`)
        mkdirSync(cwd, { recursive: true })
        mkdirSync(home, { recursive: true })
        return runHealthDeep(cwd, home)
      })
      const results = await Promise.all(jobs)
      for (const [idx, r] of results.entries()) {
        const jl = findCheck(r.cert, 'journey-loop')
        check(
          `full run ${idx + 1} exits 0`,
          r.status === 0,
          `rc=${r.status} verdict=${r.cert?.verdict ?? 'none'} journey=${jl?.status}:${jl?.evidence ?? ''} stderr=${r.stderr.slice(0, 120)} — run node dist/mercury.mjs health --json --deep and read the journey-loop check; fix probeJourneyLoop in src/platform/health/healthDeepProbes.ts so concurrent runs stay isolated`,
        )
        const cautions = notOk(r.cert)
        check(
          `full run ${idx + 1} ${certifiedHere}`,
          r.cert?.verdict === (cautions.length === 0 ? 'certified' : 'caution') &&
            cautions.every(c => c.status === 'warn' && trueHere.has(c.id) && String(c.evidence).includes(trueHere.get(c.id)!.says)),
          `verdict=${r.cert?.verdict ?? 'none'} · not ok: ${cautions.map(c => `${c.id} ${c.status}: ${c.evidence ?? ''}`).join(' | ') || 'none read'} — a check named here that is true of this machine joins trueHere in scripts/health/prove-deep-health-concurrent.ts with the fact that makes it true; any other is a fault of that check in src/platform/health, or the JSON did not parse; read the cert from node dist/mercury.mjs health --json --deep`,
        )
        check(
          `full run ${idx + 1} journey-loop is ok with full pipeline evidence`,
          jl?.status === 'ok' &&
            jl.probe === 'functional' &&
            String(jl.evidence).includes('service→readiness→http→log→stop all passed') &&
            String(jl.evidence).includes('failure leg honest'),
          `${jl?.status}: ${jl?.evidence ?? 'missing'} — the journey-loop evidence must name the whole pipeline and a honest failure leg; see probeJourneyLoop in src/platform/health/healthDeepProbes.ts`,
        )
      }
    }

    console.log('\n§2 three simultaneous --deep --only journey-loop runs all end certified')
    {
      const jobs = [1, 2, 3].map(i => {
        const cwd = join(scratch, `only-cwd-${i}`)
        const home = join(scratch, `only-home-${i}`)
        mkdirSync(cwd, { recursive: true })
        mkdirSync(home, { recursive: true })
        return runHealthDeep(cwd, home, ['--only', 'journey-loop'])
      })
      const results = await Promise.all(jobs)
      for (const [idx, r] of results.entries()) {
        const jl = findCheck(r.cert, 'journey-loop')
        check(
          `journey-only run ${idx + 1} exits 0 and ends certified`,
          r.status === 0 && r.cert?.verdict === 'certified' && jl?.status === 'ok',
          `rc=${r.status} verdict=${r.cert?.verdict ?? 'none'} journey=${jl?.status}:${jl?.evidence ?? ''} — run node dist/mercury.mjs health --json --deep --only journey-loop; fix probeJourneyLoop in src/platform/health/healthDeepProbes.ts`,
        )
      }
    }

    if (!process.env.MERCURY_PROOF_DIST) {
      console.log('\n§3 concurrent in-process probeJourneyLoop calls stay isolated and clean up')
      const { probeJourneyLoop } = await import('../../src/platform/health/healthDeepProbes.js')
      const { ownerLifecycleCounts } = await import('../../src/engine/run-owner/ownerLifecycle.js')
      const { liveServiceChildren } = await import('../../src/tools/engines/project-services/serviceManager.js')
      const [a, b] = await Promise.all([probeJourneyLoop(), probeJourneyLoop()])
      check('in-process call 1 ok', a.status === 'ok', `${a.status}: ${a.evidence} — fix probeJourneyLoop in src/platform/health/healthDeepProbes.ts`)
      check('in-process call 2 ok', b.status === 'ok', `${b.status}: ${b.evidence} — fix probeJourneyLoop in src/platform/health/healthDeepProbes.ts`)
      const journeysLeft = ownerLifecycleCounts().stores['journeys'] ?? 0
      check('in-process calls dispose both journey owners', journeysLeft === 0, `journeys=${journeysLeft} — probeJourneyLoop in src/platform/health/healthDeepProbes.ts must dispose its journey owner; see ownerLifecycleCounts in src/engine/run-owner/ownerLifecycle.ts`)
      const children = liveServiceChildren()
      check('in-process calls leave no live fixture child processes', children.length === 0, `${JSON.stringify(children)} — probeJourneyLoop in src/platform/health/healthDeepProbes.ts must stop its fixture service; see liveServiceChildren in src/tools/engines/project-services/serviceManager.ts`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-deep-health-concurrent: ${checks} checks, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
