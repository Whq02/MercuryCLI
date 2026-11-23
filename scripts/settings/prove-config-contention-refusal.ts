#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runIn(home: string, body: string): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    const fs = await import('node:fs')
    const path = await import('node:path')
    const child_process = await import('node:child_process')
    const env = await import(${JSON.stringify(join(SRC, 'platform/environment/env.ts'))})
    const g = await import(${JSON.stringify(join(SRC, 'platform/config/globalConfig.ts'))})
    g.enableConfigs()
    const file = env.getGlobalMercuryFile()
    const raw = () => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' } })
  if (res.status !== 0) throw new Error(`scenario failed (the bun -e child of runIn in this file exited non-zero; the last 1500 characters of its stderr follow): ${res.stderr.slice(-1500)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

const REAL_STATE = { hasCompletedOnboarding: true, theme: 'dark', mcpServers: { keeper: { command: 'held' } } }

console.log('L1 the held lock — the save refuses, the file stands')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-contention-'))
  mkdirSync(home, { recursive: true })
  const r = runIn(home, `
    fs.writeFileSync(file, JSON.stringify(${JSON.stringify(REAL_STATE)}))
    // The holder: a REAL child taking the same lock artefact and holding it
    // well past the waiter's ~2s ladder.
    const holderSrc =
      'const lockfile = await import(' + ${JSON.stringify(JSON.stringify(join(SRC, 'platform/storage/lockfile.ts')))} + ');' +
      'lockfile.lockSync(' + JSON.stringify(file) + ', { lockfilePath: ' + JSON.stringify(file + '.lock') + ', realpath: false });' +
      'console.log(\\'HELD\\');' +
      'setTimeout(() => {}, 8000)'
    const holder = child_process.spawn(process.execPath, ['-e', holderSrc], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise(resolve => holder.stdout.on('data', chunk => { if (String(chunk).includes('HELD')) resolve() }))
    const before = raw()
    const refusalsBefore = g.getConfigContentionRefusalCount?.() ?? 'absent'
    g.saveGlobalConfig(c => ({ ...c, theme: 'not-a-theme' }))
    out.same = raw() === before
    out.refusals = g.getConfigContentionRefusalCount?.() ?? 'absent'
    out.refusalsBefore = refusalsBefore
    out.themeAfter = JSON.parse(raw()).theme
    holder.kill()
  `)
  check('the file is byte-identical after the save under a held lock', r.same === true, `theme after: ${r.themeAfter}`, 'saveGlobalConfig in src/platform/config/globalConfig.ts must refuse the write when the lock is held past its backoff ladder (the ELOCKED branch of saveGlobalConfigOutcome) and leave the file untouched')
  check('the refusal is counted', r.refusals === 1 && r.refusalsBefore === 0, `refusals=${JSON.stringify(r.refusals)} (before=${JSON.stringify(r.refusalsBefore)})`, 'the ELOCKED branch of saveGlobalConfigOutcome in src/platform/config/globalConfig.ts must call noteConfigContentionRefusal once, and getConfigContentionRefusalCount must be exported')
}

console.log('L2 control — an uncontended save lands')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-uncontended-'))
  mkdirSync(home, { recursive: true })
  const r = runIn(home, `
    fs.writeFileSync(file, JSON.stringify(${JSON.stringify(REAL_STATE)}))
    g.saveGlobalConfig(c => ({ ...c, theme: 'not-a-theme' }))
    const parsed = JSON.parse(raw())
    out.theme = parsed.theme
    out.keeper = parsed.mcpServers?.keeper !== undefined
    out.refusals = g.getConfigContentionRefusalCount?.() ?? 'absent'
  `)
  check('the save lands and keeps the rest of the monolith', r.theme === 'not-a-theme' && r.keeper === true, JSON.stringify(r), 'an uncontended saveGlobalConfig in src/platform/config/globalConfig.ts must write the updater result and keep the other keys of the file')
  check('no refusal is counted', r.refusals === 0 || r.refusals === 'absent', `refusals=${JSON.stringify(r.refusals)}`, 'noteConfigContentionRefusal in src/platform/config/globalConfig.ts must be called only when the lock was refused, not on an uncontended save')
}

console.log('L3 the backup runs outside the locked section')
{

  const home = mkdtempSync(join(tmpdir(), 'cfg-backup-'))
  mkdirSync(home, { recursive: true })
  const r = runIn(home, `
    fs.writeFileSync(file, JSON.stringify(${JSON.stringify(REAL_STATE)}))
    g.saveGlobalConfig(c => ({ ...c, theme: 'not-a-theme' }))
    const backups = (() => { try { return fs.readdirSync(g.getConfigBackupDir()).filter(n => n.includes('.backup.')) } catch { return [] } })()
    out.backups = backups.length
  `)
  check('a save still mints the timestamped backup', (r.backups as number) >= 1, `backups=${r.backups}`, 'a save through src/platform/config/globalConfig.ts must still run backupOutgoingConfig so a stamped .backup. copy lands in getConfigBackupDir()')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
