#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-config-contention-refusal.ts — a global-config
//  save whose lock ladder exhausts REFUSES; it never rewrites the monolith
//  from an unlocked read (release-hardening audit rank 42).
//
//  The class: when another instance held the config lock past the waiter's
//  whole backoff ladder (15·2^n ms, ~2s total), the waiter fell through to
//  the LOCKLESS fallback — a whole-file rewrite from its own unlocked
//  read. Everything in the monolith except the two auth-guarded fields was
//  exposed: a user-scope MCP server added seconds earlier by the holder
//  vanished, a project's trust grant reverted, model and tips state rolled
//  back, silently. The holder's critical section was long partly because
//  the timestamped backup (copy + directory listing + retention sweep) ran
//  INSIDE the lock.
//
//   L1 with the lock held by another process past the ladder, the save is
//      REFUSED: the file is byte-identical, the refusal counter reads 1,
//      and nothing was written while the holder still held
//   L2 control: with no contention the same save lands
//   L3 the backup runs OUTSIDE the locked section (ordering pin, both
//      needles proven present), and a save still mints a backup
//
//  Scenarios run in fresh bun subprocesses (the config memoizes per
//  process); the holder is a real child process taking the same lock the
//  writer takes. PROVE_SRC names another checkout's src (the A/B control:
//  L1 and L3's ordering read red there).
// ============================================================================
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

function runIn(home: string, body: string): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    const fs = await import('node:fs')
    const path = await import('node:path')
    const child_process = await import('node:child_process')
    const env = await import(${JSON.stringify(join(SRC, 'utils/env.ts'))})
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
    g.enableConfigs()
    const file = env.getGlobalMercuryFile()
    const raw = () => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' } })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

const REAL_STATE = { hasCompletedOnboarding: true, theme: 'dark', mcpServers: { keeper: { command: 'held' } } }

// ── L1: the held lock ──────────────────────────────────────────────────────
console.log('L1 the held lock — the save refuses, the file stands')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-contention-'))
  mkdirSync(home, { recursive: true })
  const r = runIn(home, `
    fs.writeFileSync(file, JSON.stringify(${JSON.stringify(REAL_STATE)}))
    // The holder: a REAL child taking the same lock artefact and holding it
    // well past the waiter's ~2s ladder.
    const holderSrc =
      'const lockfile = await import(' + ${JSON.stringify(JSON.stringify(join(SRC, 'utils/lockfile.ts')))} + ');' +
      'lockfile.lockSync(' + JSON.stringify(file) + ', { lockfilePath: ' + JSON.stringify(file + '.lock') + ', realpath: false });' +
      'console.log(\\'HELD\\');' +
      'setTimeout(() => {}, 8000)'
    const holder = child_process.spawn(process.execPath, ['-e', holderSrc], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise(resolve => holder.stdout.on('data', chunk => { if (String(chunk).includes('HELD')) resolve() }))
    const before = raw()
    const refusalsBefore = g.getConfigContentionRefusalCount?.() ?? 'absent'
    g.saveGlobalConfig(c => ({ ...c, theme: 'light' }))
    out.same = raw() === before
    out.refusals = g.getConfigContentionRefusalCount?.() ?? 'absent'
    out.refusalsBefore = refusalsBefore
    out.themeAfter = JSON.parse(raw()).theme
    holder.kill()
  `)
  check('the file is byte-identical after the save under a held lock', r.same === true, `theme after: ${r.themeAfter}`)
  check('the refusal is counted', r.refusals === 1 && r.refusalsBefore === 0, `refusals=${JSON.stringify(r.refusals)} (before=${JSON.stringify(r.refusalsBefore)})`)
}

// ── L2: control — no contention ────────────────────────────────────────────
console.log('L2 control — an uncontended save lands')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-uncontended-'))
  mkdirSync(home, { recursive: true })
  const r = runIn(home, `
    fs.writeFileSync(file, JSON.stringify(${JSON.stringify(REAL_STATE)}))
    g.saveGlobalConfig(c => ({ ...c, theme: 'light' }))
    const parsed = JSON.parse(raw())
    out.theme = parsed.theme
    out.keeper = parsed.mcpServers?.keeper !== undefined
    out.refusals = g.getConfigContentionRefusalCount?.() ?? 'absent'
  `)
  check('the save lands and keeps the rest of the monolith', r.theme === 'light' && r.keeper === true, JSON.stringify(r))
  check('no refusal is counted', r.refusals === 0 || r.refusals === 'absent', `refusals=${JSON.stringify(r.refusals)}`)
}

// ── L3: the backup sits outside the lock ───────────────────────────────────
console.log('L3 the backup runs outside the locked section')
{
  const src = readFileSync(join(SRC, 'utils/config/globalConfig.ts'), 'utf8')
  const fnAt = src.indexOf('export function saveConfigWithLock')
  const body = fnAt >= 0 ? src.slice(fnAt, fnAt + 3000) : ''
  const backupAt = body.indexOf('backupOutgoingConfig(file, fs)')
  const lockAt = body.indexOf('const takeLock')
  check('the pre-lock backup call exists', backupAt >= 0)
  check('it sits BEFORE the lock is taken', backupAt >= 0 && lockAt >= 0 && backupAt < lockAt, `backup=${backupAt} lock=${lockAt}`)

  const home = mkdtempSync(join(tmpdir(), 'cfg-backup-'))
  mkdirSync(home, { recursive: true })
  const r = runIn(home, `
    fs.writeFileSync(file, JSON.stringify(${JSON.stringify(REAL_STATE)}))
    g.saveGlobalConfig(c => ({ ...c, theme: 'light' }))
    const backups = (() => { try { return fs.readdirSync(g.getConfigBackupDir()).filter(n => n.includes('.backup.')) } catch { return [] } })()
    out.backups = backups.length
  `)
  check('a save still mints the timestamped backup', (r.backups as number) >= 1, `backups=${r.backups}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
