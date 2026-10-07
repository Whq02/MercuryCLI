#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'retired-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { FLAG_REGISTRY, getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')
const report = await import('../../src/utils/healthReport.js')
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
  const registry = readFileSync(join(REPO, 'src/substrate/flagRegistry.ts'), 'utf8')
  check('a name that left the registry is unknown to it', UNKNOWN.every(name => getFlagSpec(name) === undefined))
  check('the registry keeps no table of retired names and no reader of one', !registry.includes('RETIRED_FLAGS') && !registry.includes('retiredFlagsSet') && !registry.includes('replacedBy'))
  check('the health report reads no such table', !readFileSync(join(REPO, 'src/utils/healthReport.ts'), 'utf8').includes('retired'))
}

console.log('\n§2 the Env overrides row names the registered overrides only')
{
  const row = await flagsRow()
  check('the row names the registered overrides only — ok at the defaults, info over an override, never a fix line', (row.status === 'ok' || row.status === 'info') && (row.evidence.includes(`all ${FLAG_REGISTRY.length} registered flags at their defaults`) || /flag\(s\) overridden in env/.test(row.evidence)) && row.fix === undefined && !/retired/.test(row.evidence), row.evidence.slice(0, 160))
}

console.log('\n§3 an unknown name in the environment is nobody\'s business')
{
  for (const name of UNKNOWN) process.env[name] = 'set-by-the-proof'
  const row = await flagsRow()
  check('the row does not warn, name the setting or offer a fix for an unregistered name', (row.status === 'ok' || row.status === 'info') && UNKNOWN.every(name => !row.evidence.includes(name) && !(row.detail ?? '').includes(name)) && row.fix === undefined, `${row.status} ${row.evidence.slice(-160)}`)
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
    check('the built bundle is present (bun run build.ts)', false, BIN)
  } else {
    const set = healthJson(BIN, Object.fromEntries(UNKNOWN.map(name => [name, 'set-by-the-proof'])))
    const row = rowOf(set.text)
    check('health --json produces the certificate and its Env overrides row', (set.status === 0 || set.status === 3) && row !== undefined, `status=${String(set.status)}`)
    check('the built row says nothing of an unregistered name set in the environment', row !== undefined && UNKNOWN.every(name => !row.evidence.includes(name) && !(row.detail ?? '').includes(name)) && row.fix === undefined, row?.evidence.slice(-160) ?? '')
  }
}

console.log(failures === 0 ? '\nprove-flags-row-retired: ALL LAWS HOLD' : `\nprove-flags-row-retired: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
