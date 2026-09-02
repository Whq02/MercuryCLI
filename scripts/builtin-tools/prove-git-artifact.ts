#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-git-artifact.ts — local Git
//  journeys proved FROM THE BUILT ARTIFACT, in a disposable repository
//  outside the source tree (zero paid calls).
//
//    · `node dist/mercury.mjs doctor --json --deep` from a temp cwd — the
//      TOOL CAPABILITY → Git work graph probe (status → diff → 2-group
//      plan → verified commits + settled transactions → stale refusal)
//      passes INSIDE the bundle;
//    · MERCURY_GIT_GRAPH=0 reads 'off' in the same probe.
// ============================================================================

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

const outsideCwd = mkdtempSync(join(tmpdir(), 'builtin-tools-git-artifact-'))
const configDir = mkdtempSync(join(tmpdir(), 'builtin-tools-git-home-'))

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
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configDir,
      // The proof key pin (the artifact-circuit idiom): the auth row is
      // presence-shaped; a keyless shell otherwise faults the cert whole.
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
  console.log('── the git work-graph loop INSIDE the artifact, outside the repo ──')
  const cert = runDoctor()
  const probe = findCheck(cert, 'git-graph')
  check('TOOL CAPABILITY → Git work graph probe present', probe !== undefined)
  check('probe status ok', probe?.status === 'ok', `${probe?.status}: ${probe?.evidence}`)
  check(
    'evidence names the full journey (plan → verified commits → stale refusal)',
    (probe?.evidence ?? '').includes('stale refusal') && (probe?.evidence ?? '').includes('verified commits'),
    probe?.evidence,
  )

  console.log('── authority-toggle honesty inside the artifact ──')
  const certOff = runDoctor({ MERCURY_GIT_GRAPH: '0' })
  const probeOff = findCheck(certOff, 'git-graph')
  check("MERCURY_GIT_GRAPH=0 reads 'off' (never a fake pass)", probeOff?.status === 'off', `${probeOff?.status}`)
} finally {
  rmSync(outsideCwd, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'GIT ARTIFACT: ALL GREEN' : `GIT ARTIFACT: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
