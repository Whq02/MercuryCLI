#!/usr/bin/env bun
// ============================================================================
//  prove-permission-write-base — a permission-array write is computed from
//  the fresh raw file, never a cached filtered snapshot; concurrent
//  writers serialize (release-hardening audit rank 41).
//
//  The gap: persistPermissionUpdate read the CACHED per-source view, built
//  the whole behaviour array as [...cachedExisting, ...additions], and
//  handed it to a writer whose merge replaces arrays wholesale. Two
//  sessions sharing one config home: A's cache read before B's grant meant
//  A's next "don't ask again" silently erased B's rule from
//  settings.json — B was prompted again and watched a grant it made
//  revert. The same shape reverted a hand-edited file and erased any rule
//  the loader had filtered as invalid (the array was rebuilt from the
//  filtered view — the warned-invalid rule vanished with its only
//  evidence). And there was no cross-process lock on the
//  read-merge-publish, so racing writers clobbered whole rounds.
//
//   L1 the stale-cache race, in-process: cache primed, the file gains a
//      peer rule behind it, addRules — the peer rule SURVIVES beside the
//      new one
//   L2 the loader-filtered invalid rule survives an unrelated grant
//   L3 dedup: re-adding an existing raw rule does not duplicate it;
//      removeRules keeps unparseable raw entries and removes exactly its
//      target
//   L4 the writer serializes: the lock family sits in the settings writer
//      (structural) and six racing child processes each land their rule
//      (behavioural, fixed tree only — skipped where the lock is absent)
//
//  PROVE_SRC names another checkout's src (the A/B control: L1, L2 and
//  L4's pins read red there).
// ============================================================================
import { spawnSync, spawn } from 'node:child_process'
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
  const root = mkdtempSync(join(tmpdir(), 'perm-write-base-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  return { home, project }
}

function runIn(home: string, project: string, body: string): Record<string, unknown> {
  const src = `
    process.chdir(${JSON.stringify(project)})
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    const fs = await import('node:fs')
    const path = await import('node:path')
    const s = await import(${JSON.stringify(join(SRC, 'utils/settings/settings.ts'))})
    const pu = await import(${JSON.stringify(join(SRC, 'utils/permissions/PermissionUpdate.ts'))})
    const localPath = s.getSettingsWriteFilePathForSource('localSettings')
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    const readAllow = () => { try { return JSON.parse(fs.readFileSync(localPath, 'utf8')).permissions?.allow ?? [] } catch { return null } }
    const rule = (toolName, ruleContent) => ({ toolName, ...(ruleContent === undefined ? {} : { ruleContent }) })
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' }, cwd: project })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

// ── L1: the stale-cache race ───────────────────────────────────────────────
console.log('L1 the stale-cache race — the peer grant survives')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    fs.writeFileSync(localPath, JSON.stringify({ permissions: { allow: ['Read(//tmp/**)'] } }, null, 2))
    void s.getSettingsForSource('localSettings') // prime THIS session's cache
    // The peer session's grant lands behind the cache.
    const onDisk = JSON.parse(fs.readFileSync(localPath, 'utf8'))
    onDisk.permissions.allow.push('WebFetch(domain:example.com)')
    fs.writeFileSync(localPath, JSON.stringify(onDisk, null, 2))
    // This session persists its own grant off the stale cache.
    pu.persistPermissionUpdate({ type: 'addRules', rules: [rule('Bash', 'git status:*')], behavior: 'allow', destination: 'localSettings' })
    out.allow = readAllow()
  `)
  const allow = r.allow as string[]
  check("the peer session's rule survives", Array.isArray(allow) && allow.includes('WebFetch(domain:example.com)'), JSON.stringify(allow))
  check('the new grant landed beside it', Array.isArray(allow) && allow.includes('Bash(git status:*)'), JSON.stringify(allow))
  check('the original rule is still there', Array.isArray(allow) && allow.includes('Read(//tmp/**)'))
}

// ── L2: the filtered-invalid rule survives ─────────────────────────────────
console.log('L2 a loader-filtered invalid rule survives an unrelated grant')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    const INVALID = 'Bash(unclosed'
    fs.writeFileSync(localPath, JSON.stringify({ permissions: { allow: [INVALID, 'Read(//tmp/**)'] } }, null, 2))
    const view = s.getSettingsForSource('localSettings')
    out.premiseFiltered = !(view?.permissions?.allow ?? []).includes(INVALID)
    pu.persistPermissionUpdate({ type: 'addRules', rules: [rule('Glob')], behavior: 'allow', destination: 'localSettings' })
    out.allow = readAllow()
  `)
  check('premise: the loader filters the invalid rule from the cached view', r.premiseFiltered === true, 'the fixture rule was not filtered — pick a worse one')
  const allow = r.allow as string[]
  check('the invalid rule SURVIVES in the file (its only evidence)', Array.isArray(allow) && allow.includes('Bash(unclosed'), JSON.stringify(allow))
  check('the unrelated grant landed', Array.isArray(allow) && allow.includes('Glob'))
}

// ── L3: dedup and removal honesty ──────────────────────────────────────────
console.log('L3 dedup and removal honesty')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    fs.writeFileSync(localPath, JSON.stringify({ permissions: { allow: ['Bash(git status:*)', 'Bash(unclosed'] } }, null, 2))
    pu.persistPermissionUpdate({ type: 'addRules', rules: [rule('Bash', 'git status:*')], behavior: 'allow', destination: 'localSettings' })
    out.afterReAdd = readAllow()
    pu.persistPermissionUpdate({ type: 'removeRules', rules: [rule('Bash', 'git status:*')], behavior: 'allow', destination: 'localSettings' })
    out.afterRemove = readAllow()
  `)
  const afterReAdd = r.afterReAdd as string[]
  const afterRemove = r.afterRemove as string[]
  check('re-adding an existing raw rule does not duplicate it', afterReAdd.filter(x => x === 'Bash(git status:*)').length === 1, JSON.stringify(afterReAdd))
  check('removeRules removes exactly its target and keeps the unparseable raw entry', !afterRemove.includes('Bash(git status:*)') && afterRemove.includes('Bash(unclosed'), JSON.stringify(afterRemove))
}

// ── L4: the writer serializes ──────────────────────────────────────────────
console.log('L4 the writer serializes')
{
  const settingsSrc = readFileSync(join(SRC, 'utils/settings/settings.ts'), 'utf8')
  const hasLock = settingsSrc.includes('acquireSettingsWriteLock')
  check('the settings writer carries the bounded write lock (the global-config family)', hasLock && settingsSrc.includes("code !== 'ELOCKED'"), hasLock ? 'ladder needle missing' : 'no lock in the writer')
  if (!hasLock) {
    console.log('  [SKIP] the racing-writers drill — no lock in this src (pre-fix tree)')
  } else {
    const { home, project } = scratch()
    // The write path, resolved by the module itself (never guessed).
    const pathProbe = runIn(home, project, 'out.localPath = localPath')
    const localPath = String(pathProbe.localPath)
    const child = (n: number): Promise<number> =>
      new Promise(resolvePromise => {
        const src =
          `process.chdir(${JSON.stringify(project)});` +
          `process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)};` +
          `delete process.env.NODE_ENV;` +
          `const pu = await import(${JSON.stringify(join(SRC, 'utils/permissions/PermissionUpdate.ts'))});` +
          `pu.persistPermissionUpdate({ type: 'addRules', rules: [{ toolName: ${JSON.stringify(`Tool${n}`)} }], behavior: 'allow', destination: 'localSettings' })`
        const proc = spawn(BUN, ['-e', src], { env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' }, cwd: project, stdio: 'ignore' })
        proc.on('exit', code => resolvePromise(code ?? 1))
      })
    const codes = await Promise.all([0, 1, 2, 3, 4, 5].map(n => child(n)))
    const allow = (() => {
      try {
        const parsed = JSON.parse(readFileSync(localPath, 'utf8')) as { permissions?: { allow?: string[] } }
        return parsed.permissions?.allow ?? []
      } catch {
        return null
      }
    })()
    check('all six racing writers exited clean', codes.every(code => code === 0), JSON.stringify(codes))
    check('every racing writer landed its rule (none clobbered)', Array.isArray(allow) && [0, 1, 2, 3, 4, 5].every(n => allow.includes(`Tool${n}`)), JSON.stringify(allow))
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
