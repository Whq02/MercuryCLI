#!/usr/bin/env bun

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
          `rc=${r.status} verdict=${r.cert?.verdict ?? 'none'} journey=${jl?.status}:${jl?.evidence ?? ''} stderr=${r.stderr.slice(0, 120)} — run node dist/mercury.mjs health --json --deep and read the journey-loop check; fix probeJourneyLoop in src/services/health/healthDeepProbes.ts so concurrent runs stay isolated`,
        )
        check(
          `full run ${idx + 1} ends certified`,
          r.cert?.verdict === 'certified',
          `verdict=${r.cert?.verdict ?? 'none'} — a non-certified verdict means a check in the cert failed or the JSON did not parse; read the cert from node dist/mercury.mjs health --json --deep`,
        )
        check(
          `full run ${idx + 1} journey-loop is ok with full pipeline evidence`,
          jl?.status === 'ok' &&
            jl.probe === 'functional' &&
            String(jl.evidence).includes('service→readiness→http→log→stop all passed') &&
            String(jl.evidence).includes('failure leg honest'),
          `${jl?.status}: ${jl?.evidence ?? 'missing'} — the journey-loop evidence must name the whole pipeline and a honest failure leg; see probeJourneyLoop in src/services/health/healthDeepProbes.ts`,
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
          `rc=${r.status} verdict=${r.cert?.verdict ?? 'none'} journey=${jl?.status}:${jl?.evidence ?? ''} — run node dist/mercury.mjs health --json --deep --only journey-loop; fix probeJourneyLoop in src/services/health/healthDeepProbes.ts`,
        )
      }
    }

    if (!process.env.MERCURY_PROOF_DIST) {
      console.log('\n§3 concurrent in-process probeJourneyLoop calls stay isolated and clean up')
      const { probeJourneyLoop } = await import('../../src/services/health/healthDeepProbes.js')
      const { ownerLifecycleCounts } = await import('../../src/utils/run/ownerLifecycle.js')
      const { liveServiceChildren } = await import('../../src/services/projectServices/serviceManager.js')
      const [a, b] = await Promise.all([probeJourneyLoop(), probeJourneyLoop()])
      check('in-process call 1 ok', a.status === 'ok', `${a.status}: ${a.evidence} — fix probeJourneyLoop in src/services/health/healthDeepProbes.ts`)
      check('in-process call 2 ok', b.status === 'ok', `${b.status}: ${b.evidence} — fix probeJourneyLoop in src/services/health/healthDeepProbes.ts`)
      const journeysLeft = ownerLifecycleCounts().stores['journeys'] ?? 0
      check('in-process calls dispose both journey owners', journeysLeft === 0, `journeys=${journeysLeft} — probeJourneyLoop in src/services/health/healthDeepProbes.ts must dispose its journey owner; see ownerLifecycleCounts in src/utils/run/ownerLifecycle.ts`)
      const children = liveServiceChildren()
      check('in-process calls leave no live fixture child processes', children.length === 0, `${JSON.stringify(children)} — probeJourneyLoop in src/services/health/healthDeepProbes.ts must stop its fixture service; see liveServiceChildren in src/services/projectServices/serviceManager.ts`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-deep-health-concurrent: ${checks} checks, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
