#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
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

const { FLAG_REGISTRY, RETIRED_FLAGS, retiredFlagsSet } = await import('../../src/substrate/flagRegistry.ts')
const report = await import('../../src/utils/healthReport.js')
type Row = { status: string; evidence: string; fix?: string; detail?: string }
const flagsRow = async (): Promise<Row> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'flags')
  return { status: String(row?.status), evidence: String(row?.evidence), fix: row?.fix, detail: row?.detail }
}
const PORT = RETIRED_FLAGS.find(r => r.env.endsWith('_GODOT_TOOLS_PORT'))?.env ?? ''
const TOKEN = RETIRED_FLAGS.find(r => r.env.endsWith('_GODOT_TOOLS_TOKEN'))?.env ?? ''
for (const name of RETIRED_FLAGS) delete process.env[name.env]

console.log('§1 the registry agrees with what is retired')
{
  check('the retired table names the fixed port and the shared token, and nothing else', RETIRED_FLAGS.map(r => r.env).sort().join(',') === `${PORT},${TOKEN}` && PORT.length > 0 && TOKEN.length > 0)
  check('nothing replaced either setting, and each says what stands in its place', RETIRED_FLAGS.every(r => r.replacedBy === null && r.now.length > 20 && r.was.length > 5))
  check('a retired name is never a registered flag', RETIRED_FLAGS.every(r => !FLAG_REGISTRY.some(f => f.env === r.env)))
  check('the reader answers the retired settings that are set, with their values', retiredFlagsSet({}).length === 0 && retiredFlagsSet({ [PORT]: '6010' }).map(r => `${r.spec.env}=${r.value}`).join() === `${PORT}=6010`)
}

console.log('\n§2 the Env overrides row with nothing retired set is unchanged')
{
  const row = await flagsRow()
  check('the row does not speak of retired settings', !/retired/.test(row.evidence) && row.fix === undefined && (row.status === 'ok' || row.status === 'info'), row.evidence.slice(0, 120))
}

console.log('\n§3 the row names a retired setting still set, what replaced it, and the fix')
{
  process.env[PORT] = '6010'
  process.env[TOKEN] = 'deadbeef'
  const row = await flagsRow()
  check('the row warns', row.status === 'warn', row.status)
  check('the evidence names both settings as retired and still set, with nothing replacing them', row.evidence.includes(`retired, still set: ${PORT} (nothing replaces it), ${TOKEN} (nothing replaces it)`), row.evidence.slice(-200))
  check('the detail says what each was and what stands in its place', (row.detail ?? '').includes(`${PORT}=6010 — retired: it was the fixed loopback port of the Godot bridge; nothing replaces it: every Godot instance publishes its own port`) && (row.detail ?? '').includes(`${TOKEN}=deadbeef — retired`), (row.detail ?? '').slice(0, 200))
  check('the fix says to unset both and why', (row.fix ?? '').startsWith(`Unset ${PORT} and ${TOKEN}: they are retired and nothing reads them.`) && (row.fix ?? '').includes('own token file'), row.fix ?? '')
  delete process.env[TOKEN]
  const one = await flagsRow()
  check('one retired setting alone reads in the singular', one.status === 'warn' && one.evidence.includes(`retired, still set: ${PORT} (nothing replaces it)`) && !one.evidence.includes(TOKEN) && (one.fix ?? '').startsWith(`Unset ${PORT}: it is retired and nothing reads it.`), one.fix ?? '')
  delete process.env[PORT]
}

console.log('\n§4 the built bundle')
{
  const doctorJson = (bin: string, extra: Record<string, string>): { text: string; status: number | null } => {
    const res = spawnSync('node', [bin, 'doctor', '--json'], {
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
    console.log('  [SKIP] dist/mercury.mjs absent — the built legs need a build')
  } else {
    const set = doctorJson(BIN, { [PORT]: '6010', [TOKEN]: 'deadbeef' })
    const row = rowOf(set.text)
    check('doctor --json produces the record and its Env overrides row warns about both retired settings', (set.status === 0 || set.status === 3) && row?.status === 'warn' && row.evidence.includes(`retired, still set: ${PORT} (nothing replaces it), ${TOKEN} (nothing replaces it)`), `status=${String(set.status)} ${row?.evidence.slice(-160) ?? ''}`)
    const clear = doctorJson(BIN, {})
    const clearRow = rowOf(clear.text)
    check('with nothing retired set the built row is silent about retirement', clearRow !== undefined && !/retired/.test(clearRow.evidence) && clearRow.fix === undefined, clearRow?.evidence.slice(0, 120) ?? '')
  }
  const baseDist = process.env.MERCURY_BASE_DIST
  if (baseDist && existsSync(join(baseDist, 'mercury.mjs'))) {
    const old = rowOf(doctorJson(join(baseDist, 'mercury.mjs'), { [PORT]: '6010', [TOKEN]: 'deadbeef' }).text)
    check('the pre-fix bundle names neither retired setting on the same row', old !== undefined && !/retired/.test(old.evidence) && old.status !== 'warn', old?.evidence.slice(0, 120) ?? '')
  } else {
    console.log('  [SKIP] MERCURY_BASE_DIST unset — no pre-fix bundle to compare')
  }
}

console.log(failures === 0 ? '\nprove-flags-row-retired: all green' : `\nprove-flags-row-retired: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
