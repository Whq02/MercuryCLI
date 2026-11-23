#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  const shown = cond || !hint ? detail : detail ? `${detail} — ${hint}` : hint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const { getRipgrepStatus } = await import('../../src/platform/shell/ripgrep.ts')

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
  'getRipgrepStatus in src/platform/shell/ripgrep.ts must resolve presence from the engine path and never from process.cwd()',
)
check('this tree resolves a real engine (present)', before.present === true, `${before.mode} @ ${before.path}`, 'getRipgrepStatus in src/platform/shell/ripgrep.ts found no ripgrep engine; install ripgrep or rebuild the vendored one')
{
  const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
  const { basename } = await import('node:path')
  const savedHere = process.cwd()
  process.chdir(decoyDir)
  const rowInDecoy = await runtimeChecks().find(row => row.id === 'runtime')?.run()
  process.chdir(savedHere)
  const owner = getRipgrepStatus()
  check('the row consumes the OWNER presence (rg.present, no local existsSync on rg.path)', rowInDecoy?.evidence.includes(`ripgrep ${owner.mode} @ ${basename(owner.path)} ${owner.present ? 'present' : 'MISSING'}`) === true, rowInDecoy?.evidence, 'runtimeCheck in src/platform/health/sections/runtime/host.ts must build the ripgrep part of the evidence from getRipgrepStatus().present')
}

console.log('\n§2 the row reads a PROBED answer: a present ripgrep that fails its probe says so')
if (process.platform === 'win32') {
  console.log('  [SKIP] not read on Windows: ripgrep spawn probe uses a POSIX #!/bin/sh stand-in')
} else {
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
  check('the runtime row exists in the certificate', row !== undefined, (res.stderr ?? '').slice(0, 200), 'node dist/mercury.mjs health --json must print a certificate with a runtime row (runtimeCheck in src/platform/health/sections/runtime/host.ts); run it by hand and read stderr')
  check('a system rg that exits 1 reads "present · probe FAILED" — the probe was awaited, never a cold null', row?.evidence?.includes('ripgrep system @ rg present · probe FAILED') === true, row?.evidence ?? '(no row)', 'runtimeCheck in src/platform/health/sections/runtime/host.ts must append probe FAILED when getRipgrepStatus().working is false, after warmRipgrepStatus has been awaited')
  check('…and the row fails', row?.status === 'fail', row?.status ?? '(no row)', 'runtimeCheck in src/platform/health/sections/runtime/host.ts must return status fail when the ripgrep probe failed')
  rmSync(fakeBin, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

rmSync(decoyDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-rg-presence-owner: all green' : `\nprove-rg-presence-owner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
