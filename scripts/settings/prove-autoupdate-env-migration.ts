#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runIn(seed: Record<string, unknown> | null, body: string): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), 'autoupdate-env-migration-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.chdir(${JSON.stringify(project)})
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const fs = await import('node:fs')
    const path = await import('node:path')
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
    const s = await import(${JSON.stringify(join(SRC, 'utils/settings/settings.ts'))})
    const m = await import(${JSON.stringify(join(SRC, 'migrations/migrateAutoupdateEnvName.ts'))})
    g.enableConfigs()
    const settingsPath = s.getSettingsWriteFilePathForSource('userSettings')
    const seed = ${JSON.stringify(seed)}
    if (seed) { fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); fs.writeFileSync(settingsPath, JSON.stringify(seed, null, 2) + '\\n') }
    const raw = () => { try { return fs.readFileSync(settingsPath, 'utf8') } catch { return null } }
    const parsed = () => { const t = raw(); return t === null ? null : JSON.parse(t) }
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' }, cwd: project })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}

console.log('L1 DISABLE_AUTOUPDATER=1 — the key is gone and nothing replaces it')
{
  const r = runIn({ env: { DISABLE_AUTOUPDATER: '1', OTHER: 'kept' } }, `
    out.verdict = m.migrateAutoupdateEnvName()
    const env = parsed().env ?? {}
    out.switched = env.MERCURY_AUTOUPDATE ?? null
    out.hasOld = 'DISABLE_AUTOUPDATER' in env
    out.other = env.OTHER
  `)
  check('the migration reports true', r.verdict === true, JSON.stringify(r.verdict))
  check('nothing replaces the key', r.switched === null, JSON.stringify(r.switched))
  check('the key DISABLE_AUTOUPDATER is gone', r.hasOld === false)
  check('the other env entries ride along', r.other === 'kept', JSON.stringify(r.other))
}

console.log('L2 DISABLE_AUTOUPDATER=0 — the key is gone the same way')
{
  const r = runIn({ env: { DISABLE_AUTOUPDATER: '0' } }, `
    out.verdict = m.migrateAutoupdateEnvName()
    const env = parsed().env ?? {}
    out.switched = env.MERCURY_AUTOUPDATE ?? null
    out.hasOld = 'DISABLE_AUTOUPDATER' in env
  `)
  check('the migration reports true', r.verdict === true)
  check('no switch is written', r.switched === null, JSON.stringify(r.switched))
  check('the key is gone', r.hasOld === false)
}

console.log('L3 a settings file without the key is left alone')
{
  const r = runIn({ env: { OTHER: 'kept' }, model: 'opus' }, `
    const before = raw()
    out.verdict = m.migrateAutoupdateEnvName()
    out.same = raw() === before
  `)
  check('the migration reports true', r.verdict === true)
  check('the file is byte-for-byte unchanged', r.same === true)
}

console.log('L4 a second run changes nothing')
{
  const r = runIn({ env: { DISABLE_AUTOUPDATER: '1' } }, `
    m.migrateAutoupdateEnvName()
    const first = raw()
    out.verdict = m.migrateAutoupdateEnvName()
    out.same = raw() === first
  `)
  check('the second run reports true', r.verdict === true)
  check('the second run changes nothing', r.same === true)
}

console.log('L5 the startup runner registers the migration in its landed set')
{
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  const at = main.indexOf('function runMigrationsIfNeeded(')
  const body = at === -1 ? '' : main.slice(at, at + 3000)
  check('runMigrationsIfNeeded pushes migrateAutoupdateEnvName() onto landed', body.includes('landed.push(migrateAutoupdateEnvName())'))
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ auto-update env migration: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ auto-update env migration: all legs green')
void dirname
