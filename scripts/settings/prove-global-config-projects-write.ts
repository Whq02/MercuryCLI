#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-global-config-projects-write.ts — the STORE pin
//  for the saveGlobalConfig dropped-write class: both
//  branches of saveGlobalConfig rebuilt `projects` from the PRE-update config
//  (removeProjectHistory(current.projects)), so every projects mutation
//  routed through it was silently discarded — setPathTrusted was a no-op end
//  to end (a trust decision persisted only where TrustDialog's own
//  saveCurrentProjectConfig write happened to cover the same path). Both
//  branches carry the fix: the locked one (the lock is taken with
//  realpath:false, so a fresh home's first save takes it too —
//  prove-config-first-save-locked pins that law) and the lockless fallback
//  (the branch a held lock still sends a save down).
//
//   S1  the LOCKED path (the config file already exists, so the lock takes):
//       a projects mutation through saveGlobalConfig survives the read-back
//       — in the cache AND on disk.
//   S2  the FRESH-HOME first save (no config file yet): the same mutation
//       survives — whichever branch the save takes, projects are rebuilt
//       from the UPDATED config.
//   S3  an unrelated update that leaves projects alone keeps them
//       byte-identical (the same-reference spread), and a same-reference
//       updater performs no disk write at all.
//   S4  the ledger's own door: setPathTrusted → isPathTrusted round-trips on
//       a fresh home (the operator-facing meaning of the class).
//  Each scenario runs in its own fresh bun subprocess with its own scratch
//  MERCURY_CONFIG_DIR — the global config memoizes per process.
// ============================================================================
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

/** Run a scenario body in a fresh process against a scratch home; the body
 *  prints ONE JSON line the scenario asserts on. */
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

// ── S1: the locked path ────────────────────────────────────────────────────
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

// ── S2: the first save on a fresh home ─────────────────────────────────────
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

// ── S3: unrelated updates keep projects byte-identical; same-ref writes nothing ──
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

// ── S4: the ledger door — what the class MEANT for operators ───────────────
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
