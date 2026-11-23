#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'flags-check-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — to fix: ' + hint : ''}`)
  if (!cond) failures++
}

const { FLAG_REGISTRY, getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')
const report = await import('../../src/platform/health/healthReport.js')
type Row = { status: string; evidence: string; fix?: string; detail?: string }
const flagsRow = async (): Promise<Row> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'flags')
  return { status: String(row?.status), evidence: String(row?.evidence), fix: row?.fix, detail: row?.detail }
}
const UNKNOWN = ['MERCURY_GODOT_TOOLS_PORT', 'MERCURY_GODOT_TOOLS_TOKEN', ['MERCURY_CLASS', 'IFIER_FALLBACK'].join(''), ['MERCURY_CLASS', 'IFIER_FAIL_CLOSED'].join('')]
for (const name of UNKNOWN) delete process.env[name]

console.log('§1 the registry knows registered flags and nothing else')
{
  check('a name that left the registry is unknown to it', UNKNOWN.every(name => getFlagSpec(name) === undefined), '', 'one of the UNKNOWN names is still an entry of FLAG_REGISTRY; remove that entry from the registry')
  const { settingsChecks } = await import('../../src/platform/health/sections/settings.ts')
  const flagsCheck = settingsChecks().find(row => row.id === 'flags')
  const unset = JSON.stringify(await flagsCheck?.run())
  for (const name of UNKNOWN) process.env[name] = 'set-by-the-proof'
  const set = JSON.stringify(await flagsCheck?.run())
  for (const name of UNKNOWN) delete process.env[name]
  check('the health report reads no such table', flagsCheck !== undefined && set === unset && !/retired/.test(set), set.slice(0, 200), 'flagsCheck in src/platform/health/sections/settings/sources.ts must be built from FLAG_REGISTRY only, so an unregistered env name changes nothing and no retired table is read')
}

console.log('\n§2 the Env overrides row names the registered overrides only')
{
  const row = await flagsRow()
  check('the row names the registered overrides only — ok at the defaults, info over an override, never a fix line', (row.status === 'ok' || row.status === 'info') && (row.evidence.includes(`all ${FLAG_REGISTRY.length} registered flags at their defaults`) || /flag\(s\) overridden in env/.test(row.evidence)) && row.fix === undefined && !/retired/.test(row.evidence), row.evidence.slice(0, 160), 'flagsCheck in src/platform/health/sections/settings/sources.ts must report ok with all registered flags at their defaults, or info with the overridden flags, and set no fix')
}

console.log('\n§3 an unknown name in the environment is nobody\'s business')
{
  for (const name of UNKNOWN) process.env[name] = 'set-by-the-proof'
  const row = await flagsRow()
  check('the row does not warn, name the setting or offer a fix for an unregistered name', (row.status === 'ok' || row.status === 'info') && UNKNOWN.every(name => !row.evidence.includes(name) && !(row.detail ?? '').includes(name)) && row.fix === undefined, `${row.status} ${row.evidence.slice(-160)}`, 'flagsCheck in src/platform/health/sections/settings/sources.ts must iterate FLAG_REGISTRY only; it must not warn about, name or offer a fix for an env name the registry lacks')
  for (const name of UNKNOWN) delete process.env[name]
}

console.log('\n§4 the built bundle')
{
  const healthJson = (bin: string, extra: Record<string, string>): { text: string; status: number | null } => {
    const res = spawnSync('node', [bin, 'health', '--json'], {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', BROWSER: '/usr/bin/true', MERCURY_HOME: '', ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { text: res.stdout ?? '', status: res.status }
  }
  const rowOf = (text: string): Row | undefined => {
    try {
      const cert = JSON.parse(text) as { sections: Array<{ checks: Array<Row & { id: string }> }> }
      return cert.sections.flatMap(s => s.checks).find(c => c.id === 'flags')
    } catch {
      return undefined
    }
  }
  if (!existsSync(BIN)) {
    check('the built bundle is present (bun run build.ts)', false, BIN, 'run bun run build.ts to write dist/mercury.mjs, then rerun this proof')
  } else {
    const set = healthJson(BIN, Object.fromEntries(UNKNOWN.map(name => [name, 'set-by-the-proof'])))
    const row = rowOf(set.text)
    check('health --json produces the certificate and its Env overrides row', (set.status === 0 || set.status === 3) && row !== undefined, `status=${String(set.status)}`, 'run node dist/mercury.mjs health --json by hand; it must exit 0 or 3 and print a certificate with a check whose id is flags (src/platform/health/sections/settings/sources.ts)')
    check('the built row says nothing of an unregistered name set in the environment', row !== undefined && UNKNOWN.every(name => !row.evidence.includes(name) && !(row.detail ?? '').includes(name)) && row.fix === undefined, row?.evidence.slice(-160) ?? '', 'the bundle is stale or flagsCheck in src/platform/health/sections/settings/sources.ts names an unregistered env name; rebuild with bun run build.ts and fix flagsCheck')
  }
}

console.log(failures === 0 ? '\nprove-flags-row-retired: ALL LAWS HOLD' : `\nprove-flags-row-retired: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
