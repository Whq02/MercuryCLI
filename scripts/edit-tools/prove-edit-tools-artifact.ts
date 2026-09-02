#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-edit-tools-artifact.ts — every selected workbench slice proved
//  FROM THE BUILT ARTIFACT (dist/mercury.mjs), outside the repository, zero
//  paid calls.
//
//    S. structural: the slice surfaces exist INSIDE the bundle (String
//       search over dist — host-side green can be DCE'd out of a build,
//       the banked host-vs-binary law), including every workbench flag read.
//    B. behavioral: `node dist/mercury.mjs doctor --json` from a DISPOSABLE
//       cwd carrying a runner manifest + a git repo + a gh shim answers the
//       §10.7 glance INSIDE the bundle — discovered runner profiles, repo-
//       host availability, open-transaction state — and flag-off honesty
//       (MERCURY_REPO_HOST=0 reads OFF in the same probe).
//
//  Billed missions through the artifact stay OUT of the gate —
//  scripts/edit-tools/journey-edit-tools-artifact.ts is the operator-run receipt
//
// ============================================================================

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

// ── S. structural markers inside the bundle ────────────────────────────────
console.log('\nS. slice surfaces exist inside the artifact')
const bundle = readFileSync(dist, 'utf8')
const MARKERS: Array<[string, string]> = [
  ['S1 front-door directory header', '(target: directory · owner: Read'],
  ['S1 url delegation header', '(target: url · owner: WebFetch'],
  ['S2 hunks refusal grammar', 'insert takes a single anchor line'],
  ['S3 pinned tap reporter', '--test-reporter'],
  ['S3 no-PM-guess law', 'never guesses a package manager'],
  ['S4 vacuous stabilize', 'stabilization vacuous'],
  ['S5 review resource', 'mercury://repo/review/latest'],
  ['flag MERCURY_READ_TARGETS read', 'MERCURY_READ_TARGETS'],
  ['flag MERCURY_EDIT_HUNKS read', 'MERCURY_EDIT_HUNKS'],
  ['flag MERCURY_TX_AUTOCAPTURE read', 'MERCURY_TX_AUTOCAPTURE'],
  ['flag MERCURY_REPO_HOST read', 'MERCURY_REPO_HOST'],
]
for (const [label, marker] of MARKERS) {
  check(label, bundle.includes(marker), `marker '${marker}' absent — stale dist? (bun run build.ts)`)
}

// ── B. the §10.7 glance answered INSIDE the bundle ─────────────────────────
console.log('\nB. doctor probe from a disposable cwd (runner manifest · git · gh shim)')
const cwd = mkdtempSync(join(tmpdir(), 'anvil-artifact-'))
const home = mkdtempSync(join(tmpdir(), 'anvil-artifact-home-'))
writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'f', private: true, scripts: { test: 'node --test' } }) + '\n')
writeFileSync(join(cwd, 'a.test.mjs'), "import { test } from 'node:test'\ntest('t', () => {})\n")
execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', 'init', '-q'], { cwd })
const shimDir = mkdtempSync(join(tmpdir(), 'anvil-artifact-shim-'))
writeFileSync(join(shimDir, 'gh'), '#!/usr/bin/env bash\necho shim\n')
chmodSync(join(shimDir, 'gh'), 0o755)

interface Check {
  id: string
  status: string
  evidence: string
  detail?: string
}
interface Cert {
  sections: { id: string; title: string; checks: Check[] }[]
}

function runDoctor(extraEnv: Record<string, string> = {}): Cert {
  const raw = execFileSync((process.execPath.includes('bun') ? 'node' : process.execPath), [dist, 'doctor', '--json'], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      PATH: `${shimDir}:${process.env.PATH}`,
      ...extraEnv,
    },
  })
  return JSON.parse(raw) as Cert
}

function workbenchCheck(cert: Cert): Check | undefined {
  for (const s of cert.sections) {
    const hit = s.checks.find(c => c.id === 'anvil-workbench-fast')
    if (hit) return hit
  }
  return undefined
}

const on = runDoctor()
const wb = workbenchCheck(on)
check('B1 the Utility workbench row exists in the certificate', wb !== undefined)
check('B2 runner discovery answered (node-test found)', !!wb && wb.evidence.includes('node-test 1/1'), wb?.evidence)
check('B3 repo-host availability answered (shim gh on PATH)', !!wb && (wb.detail ?? '').includes('gh on PATH'), wb?.detail)
check('B4 open-transaction state answered', !!wb && (wb.detail ?? '').includes('open coding transaction: —'))

const off = runDoctor({ MERCURY_REPO_HOST: '0' })
const wbOff = workbenchCheck(off)
check('B5 flag-off honesty inside the artifact (repo host OFF)', !!wbOff && (wbOff.detail ?? '').includes('repo host: OFF'), wbOff?.detail)

console.log('')
if (failures > 0) {
  console.error(`prove-edit-tools-artifact: ${failures} RED`)
  process.exit(1)
}
console.log('prove-edit-tools-artifact: GREEN')
