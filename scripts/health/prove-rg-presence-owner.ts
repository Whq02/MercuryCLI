#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const { getRipgrepStatus } = await import('../../src/utils/ripgrep.ts')

const decoyDir = realpathSync(mkdtempSync(join(tmpdir(), 'rg-decoy-')))
writeFileSync(join(decoyDir, 'rg'), '')
const before = getRipgrepStatus()
const savedCwd = process.cwd()
process.chdir(decoyDir)
const inDecoy = getRipgrepStatus()
process.chdir(savedCwd)
check(
  'the presence verdict is cwd-independent (a 0-byte ./rg decoy changes nothing)',
  before.present === inDecoy.present && typeof before.present === 'boolean',
  `before=${before.present} inDecoy=${inDecoy.present} mode=${before.mode} path=${before.path}`,
)
check('this tree resolves a real engine (present)', before.present === true, `${before.mode} @ ${before.path}`)
{
  const healthSrc = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check('the row consumes the OWNER presence (rg.present, no local existsSync on rg.path)', healthSrc.includes('const rgPresent = rg.present') && !healthSrc.includes('const rgPresent = existsSync(rg.path)'))
}

console.log('\n§2 the row reads a PROBED answer: a present ripgrep that fails its probe says so')
{
  const fakeBin = mkdtempSync(join(tmpdir(), 'rg-fake-bin-'))
  writeFileSync(join(fakeBin, 'rg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const home = mkdtempSync(join(tmpdir(), 'rg-probe-home-'))
  const res = spawnSync('node', [join(ROOT, 'dist', 'mercury.mjs'), 'health', '--json'], {
    cwd: home,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, MERCURY_HOME: '', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', BROWSER: '/usr/bin/true', MERCURY_BUILTIN_RIPGREP: '0', PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let row: { status?: string; evidence?: string } | undefined
  try {
    const cert = JSON.parse(res.stdout) as { sections: Array<{ checks: Array<{ id: string; status: string; evidence: string }> }> }
    row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'runtime')
  } catch {
    row = undefined
  }
  check('the runtime row exists in the certificate', row !== undefined, (res.stderr ?? '').slice(0, 200))
  check('a system rg that exits 1 reads "present · probe FAILED" — the probe was awaited, never a cold null', row?.evidence?.includes('ripgrep system @ rg present · probe FAILED') === true, row?.evidence ?? '(no row)')
  check('…and the row fails', row?.status === 'fail', row?.status ?? '(no row)')
  rmSync(fakeBin, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

rmSync(decoyDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-rg-presence-owner: all green' : `\nprove-rg-presence-owner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
