#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')

function runIn(home: string, body: string): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    const fs = await import('node:fs')
    const path = await import('node:path')
    const env = await import(${JSON.stringify(join(HERE, '../../src/utils/env.ts'))})
    const g = await import(${JSON.stringify(join(HERE, '../../src/utils/config/globalConfig.ts'))})
    const trust = await import(${JSON.stringify(join(HERE, '../../src/utils/config/trust.ts'))})
    const schema = await import(${JSON.stringify(join(HERE, '../../src/utils/config/schema.ts'))})
    g.enableConfigs()
    const file = env.getGlobalMercuryFile()
    const readDisk = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
    const out = {}
    ${body}
    process.stdout.write(JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' } })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-800)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}

const MUTATE = `
    const dir = '/tmp/concflow-store-probe/a'
    g.saveGlobalConfig(c => ({ ...c, projects: { ...(c.projects ?? {}), [dir]: { ...schema.DEFAULT_PROJECT_CONFIG, hasTrustDialogAccepted: true } } }))
    out.cache = g.getGlobalConfig().projects?.[dir]?.hasTrustDialogAccepted === true
    out.disk = readDisk()?.projects?.[dir]?.hasTrustDialogAccepted === true
`

console.log('S1 the LOCKED path (the file exists — the lock takes)')
{
  const home = mkdtempSync(join(tmpdir(), 'gc-projects-locked-'))
  writeFileSync(join(home, '.mercury.json'), '{}')
  const r = runIn(home, `
    out.fileExistedBefore = fs.existsSync(file)
    ${MUTATE}
  `)
  check('the config file existed before the save (the locked branch)', r.fileExistedBefore === true)
  check('the projects mutation survives in the cache', r.cache === true)
  check('…and on disk', r.disk === true)
}

console.log('S2 the FRESH-HOME first save (no file yet)')
{
  const home = mkdtempSync(join(tmpdir(), 'gc-projects-fresh-'))
  const r = runIn(home, `
    out.fileExistedBefore = fs.existsSync(file)
    ${MUTATE}
  `)
  check('no config file existed before the save', r.fileExistedBefore === false)
  check('the projects mutation survives in the cache', r.cache === true)
  check('…and on disk', r.disk === true)
}

console.log('S3 unrelated update — projects byte-identical; same-reference — no write')
{
  const home = mkdtempSync(join(tmpdir(), 'gc-projects-sameref-'))
  const r = runIn(home, `
    const dir = '/tmp/concflow-store-probe/b'
    g.saveGlobalConfig(c => ({ ...c, projects: { ...(c.projects ?? {}), [dir]: { ...schema.DEFAULT_PROJECT_CONFIG, hasTrustDialogAccepted: true } } }))
    const before = JSON.stringify(g.getGlobalConfig().projects)
    g.saveGlobalConfig(c => ({ ...c, theme: 'dark' }))
    out.afterUnrelated = JSON.stringify(g.getGlobalConfig().projects)
    out.before = before
    out.diskAfterUnrelated = JSON.stringify(readDisk()?.projects)
    const writes = g.getGlobalConfigWriteCount()
    g.saveGlobalConfig(c => c)
    out.sameRefWrote = g.getGlobalConfigWriteCount() !== writes
  `)
  check('an unrelated update leaves projects byte-identical in the cache', r.afterUnrelated === r.before, `${String(r.before).slice(0, 60)}…`)
  check('…and on disk', r.diskAfterUnrelated === r.before)
  check('a same-reference updater performs no disk write', r.sameRefWrote === false)
}

console.log('S4 setPathTrusted → isPathTrusted round-trips on a fresh home')
{
  const home = mkdtempSync(join(tmpdir(), 'gc-projects-trust-'))
  const r = runIn(home, `
    const dir = fs.mkdtempSync(path.join(${JSON.stringify(tmpdir())}, 'gc-trust-dir-'))
    out.before = trust.isPathTrusted(dir)
    trust.setPathTrusted(dir)
    out.after = trust.isPathTrusted(dir)
    out.disk = readDisk()?.projects?.[dir]?.hasTrustDialogAccepted === true
  `)
  check('a fresh folder is untrusted', r.before === false)
  check('the grant persists — the operator\'s trust decision is no longer silently dropped', r.after === true && r.disk === true)
}

console.log(failures === 0 ? 'ALL STORE LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
