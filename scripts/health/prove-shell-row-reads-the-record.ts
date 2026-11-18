#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const flagAt = (flag: string): string | null => (process.argv.includes(flag) ? (process.argv[process.argv.indexOf(flag) + 1] ?? null) : null)

console.log('============================================================')
console.log(' The health row of the Bash tool shell says what the record says')
console.log('============================================================')

type Row = { status: string; evidence: string; fix?: string }
type Ready = { id: string; state: string; detail: string }
type Cert = { sections?: Array<{ checks: Array<Row & { id: string }> }>; readiness?: Ready[] }
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shell-row-')))

function health(bundle: string, name: string, env: Record<string, string | undefined> = {}): { row: (Row & { id: string }) | undefined; ready: Ready | undefined; text: string } {
  const ran = spawnSync('node', [bundle, 'health', '--json'], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, name), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_SHELL_ENGINE: undefined, MERCURY_SHELL_PREFIX: undefined, MERCURY_GIT_BASH_PATH: undefined, MERCURY_WINDOWS_SHELL_ROAD: undefined, ...env },
  })
  try {
    const cert = JSON.parse(ran.stdout) as Cert
    return { row: cert.sections?.flatMap(part => part.checks).find(row => row.id === 'shell'), ready: cert.readiness?.find(row => row.id === 'tool:shell'), text: '' }
  } catch {
    return { row: undefined, ready: undefined, text: `status ${String(ran.status)} · ${(ran.stderr ?? '').slice(-300)}` }
  }
}

try {
  section('(1) the row, asked in this process')
  {
    const { runtimeChecks } = await import('../../src/utils/health/sections/runtime.ts')
    const record = await import('../../src/utils/shell/shellRecord.ts')
    const row = (await runtimeChecks().find(spec => spec.id === 'shell')?.run()) as Row | undefined
    const served = await record.shellRecord()
    check('the row names the path of the shell the record names', row !== undefined && row.evidence.includes(served.path), JSON.stringify({ row, served }))
    check('…and its version', row !== undefined && served.version !== '' && row.evidence.includes(served.version), JSON.stringify({ row, served }))
    check('…and no zsh: neither a zsh as the shell that runs nor the words "bash or zsh"', row !== undefined && !/zsh[^/]* — /i.test(row.evidence) && !row.evidence.includes('bash or zsh'), row?.evidence)
    check('the bash Mercury ships reads ok; any other shell is a warning, with what to change where a pack is skipped', row !== undefined && (served.origin === 'shipped' ? row.status === 'ok' && row.fix === undefined : row.status === 'warn' || (row.status === 'ok' && /MERCURY_SHELL_ENGINE|Shell engine setting/.test(row.evidence))), JSON.stringify(row))
  }

  section('(2) the built bundle')
  {
    const bundle = join(ROOT, 'dist', 'mercury.mjs')
    if (!existsSync(bundle)) {
      console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
    } else {
      const own = health(bundle, 'own')
      check('health --json carries the row, naming a bash with its version, or the engine', own.row !== undefined && /^(?:bash \d+\.\d+|brush \d+\.\d+|the (?:bundled )?shell engine at )/.test(own.row.evidence), JSON.stringify(own.row) + own.text)
      check('…and the readiness row tool:shell is there beside it', own.ready !== undefined && own.ready.detail.length > 0, JSON.stringify(own.ready))
      const engine = health(bundle, 'engine', { MERCURY_SHELL_ENGINE: 'brush' })
      check('with the engine pinned the row names the engine and the pin, and stays ok where its pack is', engine.row !== undefined && (/brush/.test(engine.row.evidence) ? engine.row.status === 'ok' && engine.row.evidence.includes('MERCURY_SHELL_ENGINE') : engine.row.evidence.length > 0), JSON.stringify(engine.row) + engine.text)
    }
  }

  section('(3) an install whose bash pack was skipped')
  {
    const dist = flagAt('--no-pack-dist')
    if (dist === null) {
      console.log('  [SKIP] no --no-pack-dist <a dist built outside a checkout with MERCURY_BUILD_NO_VENDOR_BASH=1>: the skipped pack is read where one is named')
    } else {
      const bare = health(join(dist, 'mercury.mjs'), 'no-pack')
      check('the row warns, and names the shell that runs instead with its version', bare.row?.status === 'warn' && /^(?:bash \d+\.\d+|brush \d+\.\d+)/.test(bare.row.evidence), JSON.stringify(bare.row) + bare.text)
      check('…and its fix names the skipped pack and the command that makes it', (bare.row?.fix ?? '').startsWith('The bash pack is skipped in this install:') && /scripts\/vendor\/(?:build-bash|fetch-bash-win)\.ts/.test(bare.row?.fix ?? ''), String(bare.row?.fix))
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-shell-row-reads-the-record: ALL LAWS HOLD' : `\nprove-shell-row-reads-the-record: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
