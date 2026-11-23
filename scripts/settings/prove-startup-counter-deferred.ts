#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — fix: ${hint}` : ''}`)
}
const HINT_GLOBAL_STORE = 'saveGlobalConfigDeferred, flushDeferredGlobalConfigSaves and hasPendingDeferredGlobalConfigSaves in src/platform/config/globalConfig.ts'
const HINT_PROJECT_SAVE = 'saveProjectConfigForWorkspace in src/platform/config/projectConfig.ts must publish the pending global update with its own write (and src/platform/config/globalConfig.ts must clear it)'
const HINT_STARTUP_RECORDS = 'recordFirstStartTime in src/platform/config/derived.ts, recordPermissionPosture in src/platform/config/trust.ts and the deferred queue in src/platform/config/globalConfig.ts'
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const HERE = import.meta.dir
const ROOT = join(HERE, '..', '..')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = join(ROOT, 'src')

function runIn(body: string, setup = ''): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), 'startup-counter-deferred-'))
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const fs = await import('node:fs')
    ${setup}
    const env = await import(${JSON.stringify(join(SRC, 'platform/environment/env.ts'))})
    const g = await import(${JSON.stringify(join(SRC, 'platform/config/globalConfig.ts'))})
    g.enableConfigs()
    const file = env.getGlobalMercuryFile()
    const readDisk = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
    const bump = current => ({ ...current, numStartups: (current.numStartups ?? 0) + 1 })
    const out = {}
    ${body}
    process.stdout.write(JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { cwd: home, encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' } })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-800)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}

section('D1 a deferred save: cache now, zero writes; the flush publishes once')
{
  const r = runIn(`
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    out.writesSeeded = g.getGlobalConfigWriteCount()
    g.saveGlobalConfigDeferred(bump)
    out.cacheAfterDeferred = g.getGlobalConfig().numStartups
    out.diskAfterDeferred = readDisk()?.numStartups
    out.writesAfterDeferred = g.getGlobalConfigWriteCount()
    out.pendingAfterDeferred = g.hasPendingDeferredGlobalConfigSaves()
    await g.flushDeferredGlobalConfigSaves()
    out.cacheAfterFlush = g.getGlobalConfig().numStartups
    out.diskAfterFlush = readDisk()?.numStartups
    out.writesAfterFlush = g.getGlobalConfigWriteCount()
    out.pendingAfterFlush = g.hasPendingDeferredGlobalConfigSaves()
    await g.flushDeferredGlobalConfigSaves()
    out.writesAfterSecondFlush = g.getGlobalConfigWriteCount()
  `)
  check('the seed landed with one write', r.writesSeeded === 1, `writes=${String(r.writesSeeded)}`, 'saveGlobalConfig in src/platform/config/globalConfig.ts must publish exactly one write')
  check('the deferred save lands in the cache at once (first-render readers see 5)', r.cacheAfterDeferred === 5, `cache=${String(r.cacheAfterDeferred)}`, 'saveGlobalConfigDeferred in src/platform/config/globalConfig.ts must apply the updater to the cached config at once')
  check('…with ZERO disk writes (the disk still reads 4)', r.writesAfterDeferred === 1 && r.diskAfterDeferred === 4, `writes=${String(r.writesAfterDeferred)} disk=${String(r.diskAfterDeferred)}`, 'saveGlobalConfigDeferred in src/platform/config/globalConfig.ts must not write the disk before the flush')
  check('the update is pending until published', r.pendingAfterDeferred === true, '', 'hasPendingDeferredGlobalConfigSaves in src/platform/config/globalConfig.ts must report true until the flush')
  check('the flush publishes it — exactly one write, disk and cache agree at 5', r.writesAfterFlush === 2 && r.diskAfterFlush === 5 && r.cacheAfterFlush === 5, `writes=${String(r.writesAfterFlush)} disk=${String(r.diskAfterFlush)}`, 'flushDeferredGlobalConfigSaves in src/platform/config/globalConfig.ts must publish the pending update in one write')
  check('…and clears the pending list; a second flush writes nothing', r.pendingAfterFlush === false && r.writesAfterSecondFlush === 2, `writes=${String(r.writesAfterSecondFlush)}`, 'flushDeferredGlobalConfigSaves in src/platform/config/globalConfig.ts must clear the pending list so a second flush writes nothing')
  console.log('  BEFORE: 1 locked + backed-up + fsync\'d whole-config publish in front of the first paint, every boot · AFTER: 0 before the paint; the same one publish rides the background class')
}

section('D2 a save in between folds the pending update into its own write')
{
  const r = runIn(`
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    g.saveGlobalConfigDeferred(bump)
    // A NON-default value: the store persists only non-default fields, so a
    // default theme would never reach the disk and prove nothing.
    g.saveGlobalConfig(c => ({ ...c, theme: 'not-a-theme' }))
    const disk = readDisk()
    out.diskTheme = disk?.theme
    out.diskCount = disk?.numStartups
    out.cacheCount = g.getGlobalConfig().numStartups
    out.writes = g.getGlobalConfigWriteCount()
    out.pending = g.hasPendingDeferredGlobalConfigSaves()
    await g.flushDeferredGlobalConfigSaves()
    out.writesAfterFlush = g.getGlobalConfigWriteCount()
    out.diskCountAfterFlush = readDisk()?.numStartups
  `)
  check('the intermediate save carried the increment with its own field (disk: not-a-theme, 5)', r.diskTheme === 'not-a-theme' && r.diskCount === 5, `theme=${String(r.diskTheme)} count=${String(r.diskCount)}`, 'saveGlobalConfig in src/platform/config/globalConfig.ts must fold the pending deferred update into its own write')
  check('the cache agrees', r.cacheCount === 5, `cache=${String(r.cacheCount)}`, HINT_GLOBAL_STORE)
  check('two writes in total (seed + the intermediate save) and nothing left pending', r.writes === 2 && r.pending === false, `writes=${String(r.writes)} pending=${String(r.pending)}`, 'saveGlobalConfig in src/platform/config/globalConfig.ts must clear the pending list once it folds the update in')
  check('the flush afterwards writes nothing (the increment is not applied twice)', r.writesAfterFlush === 2 && r.diskCountAfterFlush === 5, `writes=${String(r.writesAfterFlush)} disk=${String(r.diskCountAfterFlush)}`, 'flushDeferredGlobalConfigSaves in src/platform/config/globalConfig.ts must not apply an already folded update twice')
}

section('D3 the same-reference law: a no-change updater schedules nothing')
{
  const r = runIn(`
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    g.saveGlobalConfigDeferred(c => c)
    out.pending = g.hasPendingDeferredGlobalConfigSaves()
    await g.flushDeferredGlobalConfigSaves()
    out.writes = g.getGlobalConfigWriteCount()
    out.disk = readDisk()?.numStartups
  `)
  check('nothing pending, nothing written on flush, the disk untouched', r.pending === false && r.writes === 1 && r.disk === 4, `pending=${String(r.pending)} writes=${String(r.writes)} disk=${String(r.disk)}`, 'saveGlobalConfigDeferred in src/platform/config/globalConfig.ts must schedule nothing when the updater returns the same object')
}

section('D4 two deferred updates stack — both apply once, one write')
{
  const r = runIn(`
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    g.saveGlobalConfigDeferred(bump)
    g.saveGlobalConfigDeferred(c => ({ ...c, theme: 'not-a-theme' }))
    out.cacheCount = g.getGlobalConfig().numStartups
    out.cacheTheme = g.getGlobalConfig().theme
    await g.flushDeferredGlobalConfigSaves()
    const disk = readDisk()
    out.diskCount = disk?.numStartups
    out.diskTheme = disk?.theme
    out.writes = g.getGlobalConfigWriteCount()
  `)
  check('the cache carries both at once', r.cacheCount === 5 && r.cacheTheme === 'not-a-theme', `count=${String(r.cacheCount)} theme=${String(r.cacheTheme)}`, 'saveGlobalConfigDeferred in src/platform/config/globalConfig.ts must stack updaters on the cached config')
  check('one flush publishes both in one write (5, not-a-theme)', r.diskCount === 5 && r.diskTheme === 'not-a-theme' && r.writes === 2, `count=${String(r.diskCount)} theme=${String(r.diskTheme)} writes=${String(r.writes)}`, 'flushDeferredGlobalConfigSaves in src/platform/config/globalConfig.ts must apply every stacked updater in one write')
}

section('pending global changes survive a project-config save')
for (const fallback of [false, true]) for (const changed of [false, true]) {
  const r = runIn(`
    const p = await import(${JSON.stringify(join(SRC, 'platform/config/projectConfig.ts'))})
    const workspace = process.env.MERCURY_CONFIG_DIR
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    g.saveGlobalConfigDeferred(bump)
    p.saveProjectConfigForWorkspace(workspace, c => ${changed} ? { ...c, hasCompletedProjectOnboarding: true } : c)
    out.diskCount = readDisk()?.numStartups
    out.cacheCount = g.getGlobalConfig().numStartups
    out.project = p.getProjectConfigForWorkspace(workspace).hasCompletedProjectOnboarding
    out.projectExists = Boolean(readDisk()?.projects?.[p.projectConfigKeyForWorkspace(workspace)])
    out.pending = g.hasPendingDeferredGlobalConfigSaves()
    out.writes = g.getGlobalConfigWriteCount()
    await g.flushDeferredGlobalConfigSaves()
    out.afterFlush = readDisk()?.numStartups
    out.writesAfterFlush = g.getGlobalConfigWriteCount()
    out.fallbacks = g.getConfigLocklessFallbackCount()
  `, fallback ? `
    const { mock } = await import('bun:test')
    mock.module(${JSON.stringify(join(SRC, 'platform/storage/lockfile.ts'))}, () => ({ lockSync() { throw Object.assign(new Error('fixture lock unavailable'), { code: 'ENOTSUP' }) } }))
  ` : '')
  const label = `${fallback ? 'fallback' : 'locked'} / ${changed ? 'changed project' : 'unchanged project'}`
  check(`${label}: the project write carries the pending global update`, r.diskCount === 5 && r.cacheCount === 5 && (r.project === true) === changed && r.projectExists === changed, JSON.stringify(r), HINT_PROJECT_SAVE)
  check(`${label}: the project publish clears pending changes without applying them twice`, r.pending === false && r.writes === 2 && r.writesAfterFlush === 2 && r.afterFlush === 5, JSON.stringify(r), HINT_PROJECT_SAVE)
  check(`${label}: the intended publication path was exercised`, fallback ? Number(r.fallbacks) >= 2 : r.fallbacks === 0, JSON.stringify(r), 'the locked or lockless publication path counted by getConfigLocklessFallbackCount in src/platform/config/globalConfig.ts was not the one taken; check the lock mock in this proof against src/platform/storage/lockfile.ts')
}

section('another process refresh preserves the pending cached view')
{
  const r = runIn(`
    const io = await import(${JSON.stringify(join(SRC, 'platform/files/fsOperations.ts'))})
    g.getGlobalConfig()
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    g.saveGlobalConfigDeferred(bump)
    const external = { ...readDisk(), theme: 'not-a-theme' }
    fs.writeFileSync(file, JSON.stringify(external))
    const implementation = io.getFsImplementation()
    io.setFsImplementation({ ...implementation, readFile: async () => JSON.stringify(external) })
    refreshConfig({ mtimeMs: Date.now() + 1000 })
    await Promise.resolve()
    out.cacheCount = g.getGlobalConfig().numStartups
    out.theme = g.getGlobalConfig().theme
    out.pending = g.hasPendingDeferredGlobalConfigSaves()
    out.writes = g.getGlobalConfigWriteCount()
    io.setOriginalFsImplementation()
    await g.flushDeferredGlobalConfigSaves()
    out.diskCount = readDisk()?.numStartups
    out.diskTheme = readDisk()?.theme
    out.writesAfterFlush = g.getGlobalConfigWriteCount()
  `, `
    const { mock } = await import('bun:test')
    let refreshConfig
    mock.module('fs', () => ({ ...fs, watchFile: (_file, _options, callback) => { refreshConfig = callback }, unwatchFile: () => {} }))
  `)
  check('a fresh disk view includes the pending update for cache readers', r.theme === 'not-a-theme' && r.cacheCount === 5 && r.pending === true && r.writes === 1, JSON.stringify(r), 'the cache refresh from another process in src/platform/config/globalConfig.ts must re-apply the pending deferred updates to the fresh disk view')
  check('the later flush applies it once to the external write', r.diskCount === 5 && r.diskTheme === 'not-a-theme' && r.writesAfterFlush === 2, JSON.stringify(r), HINT_GLOBAL_STORE)
}

section('deferred flush carries an undeclared project key as written')
{
  const r = runIn(`
    fs.writeFileSync(file, JSON.stringify({ numStartups: 4, projects: { fixture: { history: ['as written'] } } }))
    g.saveGlobalConfigDeferred(bump)
    out.cacheHistory = g.getGlobalConfig().projects.fixture.history ?? null
    await g.flushDeferredGlobalConfigSaves()
    out.diskHistory = readDisk()?.projects.fixture.history ?? null
    out.diskCount = readDisk()?.numStartups
  `)
  check('the undeclared project key rides the deferred cache and the published config untouched', JSON.stringify(r.cacheHistory) === '["as written"]' && JSON.stringify(r.diskHistory) === '["as written"]' && r.diskCount === 5, JSON.stringify(r), 'the deferred cache and flush in src/platform/config/globalConfig.ts must carry keys the config schema does not declare as written')
}

section('startup metadata remains usable while another process holds the config lock')
{
  const r = runIn(`
    const lock = await import(${JSON.stringify(join(SRC, 'platform/storage/lockfile.ts'))})
    const derived = await import(${JSON.stringify(join(SRC, 'platform/config/derived.ts'))})
    const trust = await import(${JSON.stringify(join(SRC, 'platform/config/trust.ts'))})
    const project = await import(${JSON.stringify(join(SRC, 'platform/config/projectConfig.ts'))})
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4, remoteControlAtStartup: true, notAConfigKey: true }))
    const release = lock.lockSync(file, { realpath: false })
    const wait = Atomics.wait
    let waits = 0
    let released = false
    let timer
    Atomics.wait = () => { waits++; throw Object.assign(new Error('unexpected synchronous lock wait'), { code: 'ELOCKED' }) }
    try {
      derived.recordFirstStartTime()
      trust.recordPermissionPosture({ bypassArmed: true, envArmed: true, flagArmed: false, dialogSuppressed: true })
      out.posture = project.getCurrentProjectConfig().permissionPosture?.mode
      out.trusted = trust.checkHasTrustDialogAccepted()
      out.cached = {
        started: typeof g.getGlobalConfig().firstStartTime === 'string',
        remote: g.getGlobalConfig().remoteControlAtStartup,
        output: g.getGlobalConfig().toolOutput,
        undeclared: g.getGlobalConfig().notAConfigKey,
      }
      out.writesBefore = g.getGlobalConfigWriteCount()
      timer = setTimeout(() => { release(); released = true }, 25)
      const flushing = g.flushDeferredGlobalConfigSaves()
      out.pendingWhileLocked = g.hasPendingDeferredGlobalConfigSaves()
      await flushing
      out.released = released
      out.waits = waits
      out.writesAfter = g.getGlobalConfigWriteCount()
      out.disk = readDisk()
      out.diskPosture = out.disk.projects?.[project.getProjectPathForConfig()]?.permissionPosture?.mode
      out.pendingAfter = g.hasPendingDeferredGlobalConfigSaves()
    } finally {
      clearTimeout(timer)
      if (!released) release()
      Atomics.wait = wait
    }
  `)
  const cache = r.cached as { started: boolean; remote: boolean; output: string; undeclared: unknown }
  const disk = r.disk as Record<string, unknown>
  check('startup readers see first-start and the saved settings without a write; an undeclared key is carried as written', cache.started && cache.remote === true && cache.output === 'compact' && cache.undeclared === true && r.writesBefore === 1, JSON.stringify(r), HINT_STARTUP_RECORDS)
  check('the diagnostic posture is cached and persisted without granting trust', r.posture === 'bypass' && r.diskPosture === 'bypass' && r.trusted === false, JSON.stringify(r), 'recordPermissionPosture in src/platform/config/trust.ts must cache and persist the posture without setting trust')
  check('contention yields to the lock-release callback and never uses Atomics.wait', r.pendingWhileLocked === true && r.released === true && r.waits === 0, JSON.stringify(r), 'the lock contention path of flushDeferredGlobalConfigSaves in src/platform/config/globalConfig.ts must wait on the release callback and never call Atomics.wait')
  check('one later publish carries all startup metadata and the undeclared key, and clears the queue', r.writesAfter === 2 && r.pendingAfter === false && typeof disk.firstStartTime === 'string' && disk.remoteControlAtStartup === true && !('toolOutput' in disk) && disk.notAConfigKey === true, JSON.stringify(r), HINT_STARTUP_RECORDS)
}

section('exhausted background retries preserve pending data for a later save')
{
  const r = runIn(`
    const lock = await import(${JSON.stringify(join(SRC, 'platform/storage/lockfile.ts'))})
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    g.saveGlobalConfigDeferred(bump)
    const release = lock.lockSync(file, { realpath: false })
    const schedule = globalThis.setTimeout
    let callbacks = 0
    globalThis.setTimeout = (callback, delay, ...args) => schedule(() => { callbacks++; callback(...args) }, 0)
    try {
      await g.flushDeferredGlobalConfigSaves()
      out.refusals = g.getConfigContentionRefusalCount()
      out.callbacks = callbacks
      out.pending = g.hasPendingDeferredGlobalConfigSaves()
      out.cache = g.getGlobalConfig().numStartups
      out.disk = readDisk()?.numStartups
      out.writes = g.getGlobalConfigWriteCount()
    } finally {
      globalThis.setTimeout = schedule
      release()
    }
    fs.writeFileSync(file, JSON.stringify({ ...readDisk(), theme: 'not-a-theme' }))
    await Promise.all([g.flushDeferredGlobalConfigSaves(), g.flushDeferredGlobalConfigSaves()])
    out.after = readDisk()
    out.pendingAfter = g.hasPendingDeferredGlobalConfigSaves()
    out.writesAfter = g.getGlobalConfigWriteCount()
  `)
  const after = r.after as Record<string, unknown>
  check('exhaustion records a refusal without publishing or discarding the update', r.refusals === 1 && Number(r.callbacks) > 0 && r.pending === true && r.cache === 5 && r.disk === 4 && r.writes === 1, JSON.stringify(r), 'flushDeferredGlobalConfigSaves in src/platform/config/globalConfig.ts must count a contention refusal and keep the update pending when its retries run out')
  check('later flushes publish once and retain an intervening external change', after.numStartups === 5 && after.theme === 'not-a-theme' && r.pendingAfter === false && r.writesAfter === 2, JSON.stringify(r), 'a later flush in src/platform/config/globalConfig.ts must publish the kept update once on top of the external change')
}

section('process exit publishes startup metadata without the background task')
{
  const r = runIn(`
    const derived = await import(${JSON.stringify(join(SRC, 'platform/config/derived.ts'))})
    const trust = await import(${JSON.stringify(join(SRC, 'platform/config/trust.ts'))})
    const project = await import(${JSON.stringify(join(SRC, 'platform/config/projectConfig.ts'))})
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    derived.recordFirstStartTime()
    trust.recordPermissionPosture({ bypassArmed: false, envArmed: false, flagArmed: false, dialogSuppressed: false })
    out.before = readDisk()?.firstStartTime ?? null
    out.pendingBefore = g.hasPendingDeferredGlobalConfigSaves()
    process.once('exit', () => {
      const disk = readDisk()
      out.started = disk?.firstStartTime
      out.posture = disk?.projects?.[project.getProjectPathForConfig()]?.permissionPosture?.mode
      out.trusted = trust.checkHasTrustDialogAccepted()
      out.pendingAfter = g.hasPendingDeferredGlobalConfigSaves()
      process.stdout.write(JSON.stringify(out))
    })
    process.exit(0)
  `)
  check('exit synchronously publishes the first-start and diagnostic records without granting trust', r.before === null && r.pendingBefore === true && typeof r.started === 'string' && r.posture === 'standard' && r.trusted === false && r.pendingAfter === false, JSON.stringify(r), HINT_STARTUP_RECORDS)
}


console.log(failures === 0 ? '\n✅ ALL STARTUP-COUNTER-DEFERRED PROOFS PASS' : `\n❌ ${failures} STARTUP-COUNTER-DEFERRED PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

