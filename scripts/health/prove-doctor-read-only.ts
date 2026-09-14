#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_DOCTOR_RO_BIN ?? join(REPO, 'dist', 'mercury.mjs')
const NODE = existsSync(join(REPO, 'dist', 'vendor', 'node', 'bin', 'node'))
  ? join(REPO, 'dist', 'vendor', 'node', 'bin', 'node')
  : 'node'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-read-only-')))

function seedRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'file.txt'), 'content\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed'], { cwd: dir })
}

function homeFiles(home: string): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p)
      else out.set(p.slice(home.length + 1), st.mtimeMs)
    }
  }
  if (existsSync(home)) walk(home)
  return out
}

function runDoctor(home: string, work: string): number {
  try {
    execFileSync(NODE, [BIN, 'doctor', '--json'], {
      cwd: work,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: home,
        MERCURY_CREDENTIAL_STORE: 'file',
        BROWSER: '/usr/bin/true',
        ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return (e as { status?: number }).status ?? -1
  }
  return 0
}

console.log('§1 the built doctor --json leaves the config home unmutated (no config save, no counter, no index)')
{
  const home = join(SCRATCH, 'home')
  const work = join(SCRATCH, 'work')
  mkdirSync(home, { recursive: true })
  seedRepo(work)

  runDoctor(home, work)
  const before = homeFiles(home)
  const stamp = Date.now()
  while (Date.now() - stamp < 1100) { void stamp }
  runDoctor(home, work)
  const after = homeFiles(home)

  const isCert = (rel: string): boolean => rel.includes('/doctor/') && rel.endsWith('last-cert.json')
  const changed: string[] = []
  for (const [rel, mt] of after) {
    if (isCert(rel)) continue
    const was = before.get(rel)
    if (was === undefined || mt > was + 0.5) changed.push(rel)
  }
  check('no config file is written under the home', !changed.some(r => r === '.mercury.json' || r.endsWith('.mercury.json')), changed.join(', '))
  check('no timestamped config backup is written', !changed.some(r => r.startsWith('backups/')), changed.join(', '))
  check('no verification index is written under the home', !changed.some(r => r.startsWith('verify/')), changed.join(', '))
  check('no housekeeping sentinel is stamped', !changed.some(r => r.includes('last-cleanup') || r.includes('.cleanup')), changed.join(', '))
  check('the ONLY files that move across a steady-state run are the accepted certificate artifacts', changed.length === 0, `moved: ${changed.join(', ')}`)
}

console.log('\n§2 the verification digest routes to a private temp index under a read-only diagnostic (no home index)')
{
  const home = join(SCRATCH, 'home2')
  mkdirSync(home, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = home
  const repo = join(SCRATCH, 'repo2')
  seedRepo(repo)

  const { computeWorkingTreeDigest } = await import('../../src/utils/verification/verificationState.ts')
  const { beginReadOnlyDiagnostic } = await import('../../src/utils/diagnosticReadOnly.ts')

  const verifyDir = join(home, 'verify')
  const d1 = computeWorkingTreeDigest(repo, { fresh: true })
  const wroteIndexNormally = existsSync(verifyDir) && readdirSync(verifyDir).length > 0
  check('a NON read-only digest writes the shared index under the home (the defect road)', wroteIndexNormally && typeof d1 === 'string', `${d1}`)

  rmSync(verifyDir, { recursive: true, force: true })
  beginReadOnlyDiagnostic()
  const d2 = computeWorkingTreeDigest(repo, { fresh: true })
  const wroteIndexReadOnly = existsSync(verifyDir) && readdirSync(verifyDir).length > 0
  check('a read-only digest writes NO shared index under the home', !wroteIndexReadOnly, existsSync(verifyDir) ? readdirSync(verifyDir).join(',') : '(absent)')
  check('the read-only digest is the SAME tree hash (no verdict change)', d2 === d1, `${d1} vs ${d2}`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ prove-doctor-read-only: all green' : `\n❌ prove-doctor-read-only: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
