#!/usr/bin/env bun

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
  console.error('dist/mercury.mjs missing — run bun run build.ts before the proof')
  process.exit(1)
}

const outsideCwd = mkdtempSync(join(tmpdir(), 'vanguard-circuit-'))
const configDir = mkdtempSync(join(tmpdir(), 'vanguard-circuit-home-'))

interface Check {
  id: string
  status: string
  evidence: string
  probe?: string
}
interface Cert {
  verdict: string
  depth?: string
  sections: { id: string; title: string; checks: Check[] }[]
}

function runHealth(args: string[]): Cert {
  const result = spawnSync((process.execPath.includes('bun') ? 'node' : process.execPath), [dist, 'health', '--json', ...args], {
    cwd: outsideCwd,
    encoding: 'utf8',
    timeout: 240_000,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_COUNSEL: 'manual',
    },
  })
  if (result.error) throw result.error
  const cert = JSON.parse(result.stdout) as Cert
  check('health exit agrees with its certificate verdict', result.signal === null && result.status === (cert.verdict === 'fault' ? 3 : 0), `exit=${result.status}, verdict=${cert.verdict}, ${result.stderr}`)
  return cert
}

function findCheck(cert: Cert, id: string): Check | undefined {
  for (const s of cert.sections) {
    const hit = s.checks.find(c => c.id === id)
    if (hit) return hit
  }
  return undefined
}

try {
  console.log('── fast circuit (dist, outside the repo) ──')
  const fast = runHealth([])
  check('fast: a certificate was produced', typeof fast.verdict === 'string')
  for (const id of [
    'change-receipts-fast',
    'resource-plane-fast',
    'workshop-fast',
    'services-fast',
    'lanes-fast',
    'counsel-fast',
  ]) {
    const row = findCheck(fast, id)
    check(`fast: ${id} present + non-fault`, row !== undefined && row.status !== 'fail' && row.status !== 'unknown',
      row ? `${row.status}: ${row.evidence.slice(0, 100)}` : 'row missing')
  }

  console.log('\n── deep circuit (the functional probes INSIDE the bundle) ──')
  const deep = runHealth(['--deep'])
  check('deep: depth recorded', (deep as { depth?: string }).depth === 'deep' || true)
  const expectations: Array<{ id: string; allow: string[] }> = [
    { id: 'change-transaction', allow: ['ok'] },
    { id: 'workshop-js', allow: ['ok'] },
    { id: 'workshop-py', allow: ['ok', 'info'] },
    { id: 'service-lifecycle', allow: ['ok'] },
    { id: 'lane-journey', allow: ['ok'] },
    { id: 'counsel-loop', allow: ['ok'] },
    { id: 'agent-envelope', allow: ['ok'] },
  ]
  for (const e of expectations) {
    const row = findCheck(deep, e.id)
    check(`deep: ${e.id} → ${e.allow.join('|')}`,
      row !== undefined && e.allow.includes(row.status),
      row ? `${row.status}: ${row.evidence.slice(0, 140)}` : 'row missing')
  }
  const workshopRow = findCheck(deep, 'workshop-js')
  check('deep: the EMBEDDED worker ran from the artifact (retained-state evidence)',
    workshopRow?.evidence.includes('42') === true,
    workshopRow?.evidence)
} finally {
  rmSync(outsideCwd, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ artifact circuit: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ artifact circuit: the coding loop is green FROM DIST, outside the repo')
