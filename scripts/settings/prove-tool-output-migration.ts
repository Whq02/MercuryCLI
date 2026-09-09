#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function scratch(): { home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'tool-output-migration-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  return { home, project }
}

function runIn(seed: Record<string, unknown> | null, body: string): Record<string, unknown> {
  const { home, project } = scratch()
  const src = `
    process.chdir(${JSON.stringify(project)})
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const fs = await import('node:fs')
    const env = await import(${JSON.stringify(join(SRC, 'utils/env.ts'))})
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
    const m = await import(${JSON.stringify(join(SRC, 'migrations/migrateVerboseToToolOutput.ts'))})
    const configFile = env.getGlobalMercuryFile()
    const seed = ${JSON.stringify(seed)}
    if (seed) fs.writeFileSync(configFile, JSON.stringify(seed, null, 2) + '\\n')
    g.enableConfigs()
    const raw = () => { try { return fs.readFileSync(configFile, 'utf8') } catch { return null } }
    const parsed = () => { const t = raw(); return t === null ? null : JSON.parse(t) }
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    cwd: project,
  })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}

console.log('L1 verbose: true — the config reads toolOutput full and the key is gone')
{
  const r = runIn({ verbose: true, numStartups: 3 }, `
    m.migrateVerboseToToolOutput()
    await g.flushDeferredGlobalConfigSaves()
    const file = parsed()
    out.toolOutput = g.getGlobalConfig().toolOutput
    out.fileToolOutput = file.toolOutput
    out.fileHasKey = 'verbose' in file
    out.numStartups = file.numStartups
  `)
  check("the loaded config reads toolOutput 'full'", r.toolOutput === 'full', JSON.stringify(r.toolOutput))
  check("the file carries toolOutput 'full'", r.fileToolOutput === 'full', JSON.stringify(r.fileToolOutput))
  check('the file no longer carries the key verbose', r.fileHasKey === false)
  check('the other keys ride along untouched', r.numStartups === 3, JSON.stringify(r.numStartups))
}

console.log('L2 verbose: false — the config reads toolOutput compact and the key is gone')
{
  const r = runIn({ verbose: false }, `
    m.migrateVerboseToToolOutput()
    await g.flushDeferredGlobalConfigSaves()
    const file = parsed()
    out.toolOutput = g.getGlobalConfig().toolOutput
    out.fileHasKey = 'verbose' in file
  `)
  check("the loaded config reads toolOutput 'compact'", r.toolOutput === 'compact', JSON.stringify(r.toolOutput))
  check('the file no longer carries the key verbose', r.fileHasKey === false)
}

console.log('L3 a fresh config — the default is compact and the migration writes nothing')
{
  const r = runIn(null, `
    m.migrateVerboseToToolOutput()
    await g.flushDeferredGlobalConfigSaves()
    out.toolOutput = g.getGlobalConfig().toolOutput
    out.fileExists = raw() !== null
  `)
  check("the default reads 'compact'", r.toolOutput === 'compact', JSON.stringify(r.toolOutput))
  check('no file is written for a config with nothing to carry over', r.fileExists === false)
}

console.log('L4 idempotent — a second run leaves the file byte-for-byte unchanged')
{
  const r = runIn({ verbose: true }, `
    m.migrateVerboseToToolOutput()
    await g.flushDeferredGlobalConfigSaves()
    const first = raw()
    m.migrateVerboseToToolOutput()
    await g.flushDeferredGlobalConfigSaves()
    out.same = raw() === first
    out.toolOutput = g.getGlobalConfig().toolOutput
  `)
  check('the second run changes nothing', r.same === true)
  check("the setting still reads 'full'", r.toolOutput === 'full', JSON.stringify(r.toolOutput))
}

console.log("L5 a config already on toolOutput 'full' with no verbose key is left alone")
{
  const r = runIn({ toolOutput: 'full' }, `
    const before = raw()
    m.migrateVerboseToToolOutput()
    await g.flushDeferredGlobalConfigSaves()
    out.same = raw() === before
    out.toolOutput = g.getGlobalConfig().toolOutput
  `)
  check('the file is byte-for-byte unchanged', r.same === true)
  check("the setting reads 'full'", r.toolOutput === 'full', JSON.stringify(r.toolOutput))
}

console.log('L6 the setting is a global config key with a compact default')
{
  const r = runIn(null, `
    const schema = await import(${JSON.stringify(join(SRC, 'utils/config/schema.ts'))})
    out.isKey = schema.isGlobalConfigKey('toolOutput')
    out.retiredIsKey = schema.isGlobalConfigKey('verbose')
    out.def = schema.createDefaultGlobalConfig().toolOutput
  `)
  check("isGlobalConfigKey('toolOutput')", r.isKey === true)
  check("'verbose' is not a global config key", r.retiredIsKey === false)
  check("the default config reads toolOutput 'compact'", r.def === 'compact', JSON.stringify(r.def))
}

console.log('L7 the startup runner registers the migration')
{
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  const runnerAt = main.indexOf('function runMigrationsIfNeeded(')
  const body = runnerAt === -1 ? '' : main.slice(runnerAt, runnerAt + 3000)
  check('runMigrationsIfNeeded calls migrateVerboseToToolOutput', body.includes('migrateVerboseToToolOutput()'))
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ tool-output migration: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ tool-output migration: all legs green')
