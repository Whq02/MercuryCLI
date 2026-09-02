#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-config-first-save-locked.ts — the FRESH-HOME
// first-save law for the config writers (the
//  saveGlobalConfig sibling audit).
//
//  The class: saveConfigWithLock pins its lock artefact to `${file}.lock`,
//  yet the library's default realpath step still refused a not-yet-created
//  target with ENOENT — so every FIRST save on a fresh home fell through to
//  the lockless fallback, silently. The lock is now taken with
//  realpath:false and every writer records the fallbacks it takes
//  (getConfigLocklessFallbackCount), so the branch is observable.
//
//   L1  the premise: the library refuses to lock a missing target under its
//       default realpath step (the shape that sent fresh homes lockless)
//   L2  a fresh home's first saveGlobalConfig takes the LOCKED branch:
//       zero lockless fallbacks, the value on disk, the lock released
//   L3  a fresh home's first saveCurrentProjectConfig: the same law
//   L4  poison: a lock another holder owns (a fresh `${file}.lock`
//       directory) REFUSES the save — counted on the contention-refusal
//       counter, nothing written (rank 42 retired the lockless rewrite
//       that used to land the value over the holder's state)
//   L5  the sibling writers on a fresh home: updateSettingsForSource and
//       writeUserBinding round-trip (read fresh, atomic publish)
//   L6  healScopeIdentitySnapshot never republishes over bytes it could not
//       parse (the damaged file is byte-identical after the call) while a
//       readable snapshot heals and keeps its other keys
//  Each scenario runs in its own fresh bun subprocess with its own scratch
//  MERCURY_CONFIG_DIR — the global config memoizes per process.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
// PROVE_SRC names another checkout's src (the A/B poison: against the
// pre-fix tree L2, L3 and L6 read red).
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

/** Run a scenario body in a fresh process against a scratch home; the body
 *  prints ONE JSON line the scenario asserts on. */
function runIn(home: string, body: string): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const fs = await import('node:fs')
    const path = await import('node:path')
    const env = await import(${JSON.stringify(join(SRC, 'utils/env.ts'))})
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
    const p = await import(${JSON.stringify(join(SRC, 'utils/config/projectConfig.ts'))})
    const schema = await import(${JSON.stringify(join(SRC, 'utils/config/schema.ts'))})
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

// ── L1: the premise ────────────────────────────────────────────────────────
console.log('L1 the premise — the library refuses a missing target under its default realpath step')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-lock-premise-'))
  const r = runIn(home, `
    const lockfile = await import(${JSON.stringify(join(SRC, 'utils/lockfile.ts'))})
    const missing = path.join(${JSON.stringify(home)}, 'absent.json')
    try { lockfile.lockSync(missing, { lockfilePath: missing + '.lock' }); out.defaultThrew = false } catch (e) { out.defaultThrew = e?.code ?? String(e) }
    try { const release = lockfile.lockSync(missing, { lockfilePath: missing + '.lock', realpath: false }); release(); out.noRealpathLocked = true } catch (e) { out.noRealpathLocked = e?.code ?? String(e) }
    out.artefactReleased = !fs.existsSync(missing + '.lock')
  `)
  check('default options: locking a missing target throws ENOENT', r.defaultThrew === 'ENOENT', String(r.defaultThrew))
  check('realpath:false: the same missing target locks and releases', r.noRealpathLocked === true && r.artefactReleased === true, `${String(r.noRealpathLocked)} released=${String(r.artefactReleased)}`)
}

// ── L2: a fresh home's first saveGlobalConfig ──────────────────────────────
console.log('L2 a fresh home — the first saveGlobalConfig takes the LOCKED branch')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-lock-fresh-global-'))
  const r = runIn(home, `
    out.fileExistedBefore = fs.existsSync(file)
    g.saveGlobalConfig(c => ({ ...c, theme: 'dark', numStartups: 7 }))
    out.fallbacks = typeof g.getConfigLocklessFallbackCount === 'function' ? g.getConfigLocklessFallbackCount() : 'no-counter'
    out.disk = readDisk()?.numStartups
    out.lockReleased = !fs.existsSync(file + '.lock')
    out.writes = g.getGlobalConfigWriteCount()
  `)
  check('no config file existed before the save', r.fileExistedBefore === false)
  check('the save took the locked branch (zero lockless fallbacks)', r.fallbacks === 0, `fallbacks=${String(r.fallbacks)}`)
  check('the value is on disk', r.disk === 7, `numStartups=${String(r.disk)}`)
  check('the lock artefact is released', r.lockReleased === true)
  check('exactly one disk write', r.writes === 1, `writes=${String(r.writes)}`)
}

// ── L3: a fresh home's first saveCurrentProjectConfig ─────────────────────
console.log('L3 a fresh home — the first saveCurrentProjectConfig takes the LOCKED branch')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-lock-fresh-project-'))
  const r = runIn(home, `
    out.fileExistedBefore = fs.existsSync(file)
    p.saveCurrentProjectConfig(c => ({ ...c, hasTrustDialogAccepted: true }))
    out.fallbacks = typeof g.getConfigLocklessFallbackCount === 'function' ? g.getConfigLocklessFallbackCount() : 'no-counter'
    const projects = readDisk()?.projects ?? {}
    out.projectKeys = Object.keys(projects).length
    out.trusted = Object.values(projects).some(v => v?.hasTrustDialogAccepted === true)
    out.lockReleased = !fs.existsSync(file + '.lock')
  `)
  check('no config file existed before the save', r.fileExistedBefore === false)
  check('the save took the locked branch (zero lockless fallbacks)', r.fallbacks === 0, `fallbacks=${String(r.fallbacks)}`)
  check('the project record is on disk', r.projectKeys === 1 && r.trusted === true, `keys=${String(r.projectKeys)} trusted=${String(r.trusted)}`)
  check('the lock artefact is released', r.lockReleased === true)
}

// ── L4: poison — a lock another holder owns ────────────────────────────────
// Re-trued to the contention-refusal law (release-hardening audit rank 42):
// a lock held past the whole ladder REFUSES the save — the old lockless
// whole-file rewrite silently overwrote whatever the holder had just
// committed, so "the value still lands" was the defect, not the honesty.
console.log('L4 poison — a held lock REFUSES the save (the lockless rewrite is retired)')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-lock-held-'))
  const file = join(home, '.mercury.json')
  writeFileSync(file, '{}')
  // proper-lockfile's artefact is a DIRECTORY; a fresh mtime reads as held.
  mkdirSync(`${file}.lock`)
  const now = new Date()
  utimesSync(`${file}.lock`, now, now)
  const r = runIn(home, `
    g.saveGlobalConfig(c => ({ ...c, numStartups: 3 }))
    out.refusals = typeof g.getConfigContentionRefusalCount === 'function' ? g.getConfigContentionRefusalCount() : 'no-counter'
    out.fallbacks = typeof g.getConfigLocklessFallbackCount === 'function' ? g.getConfigLocklessFallbackCount() : 'no-counter'
    out.disk = readDisk()?.numStartups
  `)
  check('the refusal is counted — never the lockless fallback', r.refusals === 1 && r.fallbacks === 0, `refusals=${String(r.refusals)} fallbacks=${String(r.fallbacks)}`)
  check('nothing is written under the held lock', r.disk === undefined, `numStartups=${String(r.disk)}`)
}

// ── L5: the sibling writers on a fresh home ────────────────────────────────
console.log('L5 the sibling writers — settings and keybindings round-trip on a fresh home')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-lock-siblings-'))
  const r = runIn(home, `
    const settings = await import(${JSON.stringify(join(SRC, 'utils/settings/settings.ts'))})
    const res = settings.updateSettingsForSource('userSettings', { language: 'nl' })
    out.settingsError = res.error ? String(res.error) : null
    const sfile = settings.getSettingsWriteFilePathForSource ? settings.getSettingsWriteFilePathForSource('userSettings') : null
    out.settingsOnDisk = sfile ? (JSON.parse(fs.readFileSync(sfile, 'utf8')).language === 'nl') : 'no-path-api'
    const kb = await import(${JSON.stringify(join(SRC, 'keybindings/writeBindings.ts'))})
    const w = await kb.writeUserBinding({ context: 'Global', chord: 'ctrl+alt+9', action: 'app:redraw' })
    out.kbOk = w.ok === true
    out.kbOnDisk = w.ok ? fs.readFileSync(w.path, 'utf8').includes('ctrl+alt+9') : false
  `)
  check('updateSettingsForSource lands a fresh user settings file', r.settingsError === null && r.settingsOnDisk === true, `${String(r.settingsError)} onDisk=${String(r.settingsOnDisk)}`)
  check('writeUserBinding lands a fresh keybindings file', r.kbOk === true && r.kbOnDisk === true, `ok=${String(r.kbOk)} onDisk=${String(r.kbOnDisk)}`)
}

// ── L6: the identity healer never republishes over unreadable bytes ───────
console.log('L6 healScopeIdentitySnapshot — unreadable bytes stay as they are; a readable snapshot heals')
{
  const home = mkdtempSync(join(tmpdir(), 'cfg-lock-heal-'))
  const damaged = join(home, 'scope-damaged')
  const readable = join(home, 'scope-readable')
  mkdirSync(damaged)
  mkdirSync(readable)
  const damagedBytes = '{"oauthAccount": {"emailAddress": "old@example.org"}, "projects": {"/a": {"x": 1}'
  writeFileSync(join(damaged, '.claude.json'), damagedBytes)
  writeFileSync(join(readable, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'stale@example.org' }, projects: { '/a': { x: 1 } } }))
  const r = runIn(home, `
    const ident = await import(${JSON.stringify(join(SRC, 'utils/accounts/accountIdentity.ts'))})
    ident.healScopeIdentitySnapshot(${JSON.stringify(damaged)}, { email: 'fresh@example.org', uuid: 'u-1' })
    out.damagedAfter = fs.readFileSync(path.join(${JSON.stringify(damaged)}, '.claude.json'), 'utf8')
    ident.healScopeIdentitySnapshot(${JSON.stringify(readable)}, { email: 'fresh@example.org', uuid: 'u-1' })
    const healed = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(readable)}, '.claude.json'), 'utf8'))
    out.healedEmail = healed.oauthAccount?.emailAddress
    out.healedKeptProjects = healed.projects?.['/a']?.x === 1
  `)
  check('the unparseable snapshot is byte-identical after the heal (never republished from {})', r.damagedAfter === damagedBytes, JSON.stringify(String(r.damagedAfter).slice(0, 60)))
  check('a readable snapshot heals its identity', r.healedEmail === 'fresh@example.org', String(r.healedEmail))
  check('…and keeps its other keys', r.healedKeptProjects === true)
}

console.log(failures === 0 ? 'FRESH-HOME FIRST-SAVE LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
