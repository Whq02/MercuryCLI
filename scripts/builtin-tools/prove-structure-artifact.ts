#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-structure-artifact.ts — the
//  structural closed loop proved FROM THE BUILT ARTIFACT, outside the
//  repository (zero paid calls).
//
//    · drives `node dist/mercury.mjs doctor --json --deep` from a temp cwd
//      with NO workspace typescript — the TOOL CAPABILITY → Structural
//      loop probe must pass INSIDE the bundle on the VENDORED compiler
//      (no repository-relative runtime dependency, no source-only
//      registration);
//    · the build manifest declares the vendored compiler (version + entry);
//    · MERCURY_STRUCTURE=0 reads 'off' in the same probe (authority-toggle
//      honesty inside the artifact).
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const outsideCwd = mkdtempSync(join(tmpdir(), 'builtin-tools-structure-artifact-'))
const configDir = mkdtempSync(join(tmpdir(), 'builtin-tools-structure-home-'))

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
  console.log('── build manifest declares the vendored compiler ──')
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'dist', 'manifest.json'), 'utf8')) as {
    typescript?: { vendored: boolean; version?: string; compilerEntry?: string }
    degraded?: string[]
  }
  check('manifest.typescript.vendored', manifest.typescript?.vendored === true, JSON.stringify(manifest.typescript))
  check(
    'vendored compiler file exists beside the bundle',
    existsSync(join(repoRoot, 'dist', 'vendor', 'typescript', 'typescript.js')),
  )
  check(
    "no 'structural-intelligence' degradation",
    !(manifest.degraded ?? []).includes('structural-intelligence'),
  )

  console.log('── the structural loop INSIDE the artifact, outside the repo ──')
  const cert = runDoctor()
  const probe = findCheck(cert, 'structure-loop')
  check('TOOL CAPABILITY → Structural loop probe present', probe !== undefined)
  check('probe status ok', probe?.status === 'ok', `${probe?.status}: ${probe?.evidence}`)
  check(
    'the probe ran on the VENDORED facility (no workspace typescript in the temp cwd)',
    (probe?.evidence ?? '').includes('facility: vendored'),
    probe?.evidence,
  )

  console.log('── authority-toggle honesty inside the artifact ──')
  const certOff = runDoctor({ MERCURY_STRUCTURE: '0' })
  const probeOff = findCheck(certOff, 'structure-loop')
  check("MERCURY_STRUCTURE=0 reads 'off' (never a fake pass)", probeOff?.status === 'off', `${probeOff?.status}`)
} finally {
  rmSync(outsideCwd, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'STRUCTURE ARTIFACT: ALL GREEN' : `STRUCTURE ARTIFACT: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
