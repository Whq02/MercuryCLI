#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
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
    const env = await import(${JSON.stringify(join(SRC, 'utils/env.ts'))})
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
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
  check('the seed landed with one write', r.writesSeeded === 1, `writes=${String(r.writesSeeded)}`)
  check('the deferred save lands in the cache at once (first-render readers see 5)', r.cacheAfterDeferred === 5, `cache=${String(r.cacheAfterDeferred)}`)
  check('…with ZERO disk writes (the disk still reads 4)', r.writesAfterDeferred === 1 && r.diskAfterDeferred === 4, `writes=${String(r.writesAfterDeferred)} disk=${String(r.diskAfterDeferred)}`)
  check('the update is pending until published', r.pendingAfterDeferred === true)
  check('the flush publishes it — exactly one write, disk and cache agree at 5', r.writesAfterFlush === 2 && r.diskAfterFlush === 5 && r.cacheAfterFlush === 5, `writes=${String(r.writesAfterFlush)} disk=${String(r.diskAfterFlush)}`)
  check('…and clears the pending list; a second flush writes nothing', r.pendingAfterFlush === false && r.writesAfterSecondFlush === 2, `writes=${String(r.writesAfterSecondFlush)}`)
  console.log('  BEFORE: 1 locked + backed-up + fsync\'d whole-config publish in front of the first paint, every boot · AFTER: 0 before the paint; the same one publish rides the background class')
}

section('D2 a save in between folds the pending update into its own write')
{
  const r = runIn(`
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    g.saveGlobalConfigDeferred(bump)
    // A NON-default value: the store persists only non-default fields, so a
    // default theme would never reach the disk and prove nothing.
    g.saveGlobalConfig(c => ({ ...c, theme: 'light' }))
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
  check('the intermediate save carried the increment with its own field (disk: light, 5)', r.diskTheme === 'light' && r.diskCount === 5, `theme=${String(r.diskTheme)} count=${String(r.diskCount)}`)
  check('the cache agrees', r.cacheCount === 5, `cache=${String(r.cacheCount)}`)
  check('two writes in total (seed + the intermediate save) and nothing left pending', r.writes === 2 && r.pending === false, `writes=${String(r.writes)} pending=${String(r.pending)}`)
  check('the flush afterwards writes nothing (the increment is not applied twice)', r.writesAfterFlush === 2 && r.diskCountAfterFlush === 5, `writes=${String(r.writesAfterFlush)} disk=${String(r.diskCountAfterFlush)}`)
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
  check('nothing pending, nothing written on flush, the disk untouched', r.pending === false && r.writes === 1 && r.disk === 4, `pending=${String(r.pending)} writes=${String(r.writes)} disk=${String(r.disk)}`)
}

section('D4 two deferred updates stack — both apply once, one write')
{
  const r = runIn(`
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    g.saveGlobalConfigDeferred(bump)
    g.saveGlobalConfigDeferred(c => ({ ...c, theme: 'light' }))
    out.cacheCount = g.getGlobalConfig().numStartups
    out.cacheTheme = g.getGlobalConfig().theme
    await g.flushDeferredGlobalConfigSaves()
    const disk = readDisk()
    out.diskCount = disk?.numStartups
    out.diskTheme = disk?.theme
    out.writes = g.getGlobalConfigWriteCount()
  `)
  check('the cache carries both at once', r.cacheCount === 5 && r.cacheTheme === 'light', `count=${String(r.cacheCount)} theme=${String(r.cacheTheme)}`)
  check('one flush publishes both in one write (5, light)', r.diskCount === 5 && r.diskTheme === 'light' && r.writes === 2, `count=${String(r.diskCount)} theme=${String(r.diskTheme)} writes=${String(r.writes)}`)
}

section('pending global changes survive a project-config save')
for (const fallback of [false, true]) for (const changed of [false, true]) {
  const r = runIn(`
    const p = await import(${JSON.stringify(join(SRC, 'utils/config/projectConfig.ts'))})
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
    mock.module(${JSON.stringify(join(SRC, 'utils/lockfile.ts'))}, () => ({ lockSync() { throw Object.assign(new Error('fixture lock unavailable'), { code: 'ENOTSUP' }) } }))
  ` : '')
  const label = `${fallback ? 'fallback' : 'locked'} / ${changed ? 'changed project' : 'unchanged project'}`
  check(`${label}: the project write carries the pending global update`, r.diskCount === 5 && r.cacheCount === 5 && (r.project === true) === changed && r.projectExists === changed, JSON.stringify(r))
  check(`${label}: the project publish clears pending changes without applying them twice`, r.pending === false && r.writes === 2 && r.writesAfterFlush === 2 && r.afterFlush === 5, JSON.stringify(r))
  check(`${label}: the intended publication path was exercised`, fallback ? Number(r.fallbacks) >= 2 : r.fallbacks === 0, JSON.stringify(r))
}

section('another process refresh preserves the pending cached view')
{
  const r = runIn(`
    const io = await import(${JSON.stringify(join(SRC, 'utils/fsOperations.ts'))})
    g.getGlobalConfig()
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4 }))
    g.saveGlobalConfigDeferred(bump)
    const external = { ...readDisk(), theme: 'light' }
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
  check('a fresh disk view includes the pending update for cache readers', r.theme === 'light' && r.cacheCount === 5 && r.pending === true && r.writes === 1, JSON.stringify(r))
  check('the later flush applies it once to the external write', r.diskCount === 5 && r.diskTheme === 'light' && r.writesAfterFlush === 2, JSON.stringify(r))
}

section('deferred flush preserves project-history cleanup')
{
  const r = runIn(`
    fs.writeFileSync(file, JSON.stringify({ numStartups: 4, projects: { fixture: { history: ['old result'] } } }))
    g.saveGlobalConfigDeferred(bump)
    out.cacheHistory = g.getGlobalConfig().projects.fixture.history ?? null
    await g.flushDeferredGlobalConfigSaves()
    out.diskHistory = readDisk()?.projects.fixture.history ?? null
    out.diskCount = readDisk()?.numStartups
  `)
  check('history remains outside both the deferred cache and the published config', r.cacheHistory === null && r.diskHistory === null && r.diskCount === 5, JSON.stringify(r))
}

section('startup metadata remains usable while another process holds the config lock')
{
  const r = runIn(`
    const lock = await import(${JSON.stringify(join(SRC, 'utils/lockfile.ts'))})
    const derived = await import(${JSON.stringify(join(SRC, 'utils/config/derived.ts'))})
    const trust = await import(${JSON.stringify(join(SRC, 'utils/config/trust.ts'))})
    const project = await import(${JSON.stringify(join(SRC, 'utils/config/projectConfig.ts'))})
    const bridge = await import(${JSON.stringify(join(SRC, 'migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts'))})
    const verbose = await import(${JSON.stringify(join(SRC, 'migrations/migrateVerboseToToolOutput.ts'))})
    const updates = await import(${JSON.stringify(join(SRC, 'migrations/migrateAutoUpdatesToSettings.ts'))})
    g.saveGlobalConfig(c => ({ ...c, numStartups: 4, replBridgeEnabled: true, verbose: true, autoUpdates: false }))
    const release = lock.lockSync(file, { realpath: false })
    const wait = Atomics.wait
    let waits = 0
    let released = false
    let timer
    Atomics.wait = () => { waits++; throw Object.assign(new Error('unexpected synchronous lock wait'), { code: 'ELOCKED' }) }
    try {
      derived.recordFirstStartTime()
      bridge.migrateReplBridgeEnabledToRemoteControlAtStartup()
      verbose.migrateVerboseToToolOutput()
      out.migration = updates.migrateAutoUpdatesToSettings()
      trust.recordPermissionPosture({ bypassArmed: true, envArmed: true, flagArmed: false, dialogSuppressed: true })
      out.posture = project.getCurrentProjectConfig().permissionPosture?.mode
      out.trusted = trust.checkHasTrustDialogAccepted()
      out.cached = {
        started: typeof g.getGlobalConfig().firstStartTime === 'string',
        remote: g.getGlobalConfig().remoteControlAtStartup,
        output: g.getGlobalConfig().toolOutput,
        oldUpdates: 'autoUpdates' in g.getGlobalConfig(),
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
  const cache = r.cached as { started: boolean; remote: boolean; output: string; oldUpdates: boolean }
  const disk = r.disk as Record<string, unknown>
  check('startup readers see first-start and migrated settings without a write', cache.started && cache.remote === true && cache.output === 'full' && !cache.oldUpdates && r.migration === true && r.writesBefore === 1, JSON.stringify(r))
  check('the diagnostic posture is cached and persisted without granting trust', r.posture === 'bypass' && r.diskPosture === 'bypass' && r.trusted === false, JSON.stringify(r))
  check('contention yields to the lock-release callback and never uses Atomics.wait', r.pendingWhileLocked === true && r.released === true && r.waits === 0, JSON.stringify(r))
  check('one later publish carries all startup metadata and clears the queue', r.writesAfter === 2 && r.pendingAfter === false && typeof disk.firstStartTime === 'string' && disk.remoteControlAtStartup === true && disk.toolOutput === 'full' && !('verbose' in disk) && !('replBridgeEnabled' in disk) && !('autoUpdates' in disk), JSON.stringify(r))
}

section('exhausted background retries preserve pending data for a later save')
{
  const r = runIn(`
    const lock = await import(${JSON.stringify(join(SRC, 'utils/lockfile.ts'))})
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
    fs.writeFileSync(file, JSON.stringify({ ...readDisk(), theme: 'light' }))
    await Promise.all([g.flushDeferredGlobalConfigSaves(), g.flushDeferredGlobalConfigSaves()])
    out.after = readDisk()
    out.pendingAfter = g.hasPendingDeferredGlobalConfigSaves()
    out.writesAfter = g.getGlobalConfigWriteCount()
  `)
  const after = r.after as Record<string, unknown>
  check('exhaustion records a refusal without publishing or discarding the update', r.refusals === 1 && Number(r.callbacks) > 0 && r.pending === true && r.cache === 5 && r.disk === 4 && r.writes === 1, JSON.stringify(r))
  check('later flushes publish once and retain an intervening external change', after.numStartups === 5 && after.theme === 'light' && r.pendingAfter === false && r.writesAfter === 2, JSON.stringify(r))
}

section('process exit publishes startup metadata without the background task')
{
  const r = runIn(`
    const derived = await import(${JSON.stringify(join(SRC, 'utils/config/derived.ts'))})
    const trust = await import(${JSON.stringify(join(SRC, 'utils/config/trust.ts'))})
    const project = await import(${JSON.stringify(join(SRC, 'utils/config/projectConfig.ts'))})
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
  check('exit synchronously publishes the first-start and diagnostic records without granting trust', r.before === null && r.pendingBefore === true && typeof r.started === 'string' && r.posture === 'standard' && r.trusted === false && r.pendingAfter === false, JSON.stringify(r))
}

section('D5 wiring — the boot band and the background node')
{
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  check('the boot band spells the deferred save with the increment', /saveGlobalConfigDeferred\(current => \(\{ \.\.\.current, numStartups: \(current\.numStartups \?\? 0\) \+ 1 \}\)\)/.test(main))
  check('no synchronous numStartups save remains in main.tsx', !/saveGlobalConfig\(current => \(\{ \.\.\.current, numStartups/.test(main))
  const bandAt = main.indexOf('saveGlobalConfigDeferred(current => ({ ...current, numStartups:')
  const band = bandAt >= 0 ? main.slice(bandAt, bandAt + 1800) : ''
  check('the beacon clear stays synchronous right beside the increment (a quit before the node ran is never a failed attempt)', /saveGlobalConfigDeferred\(current =>[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*clearBootAttempts\(\)/.test(band))
  check("the background node 'startup-records' awaits the flush before recording the invocation", band.includes("registerBackgroundNode('startup-records', async () => {") && band.includes('await flushDeferredGlobalConfigSaves()') && band.indexOf('await flushDeferredGlobalConfigSaves()') < band.indexOf('recordInvocation()'))
  check('the invocation record has exactly one interactive call site, inside the node', (main.match(/recordInvocation\(\)/g) ?? []).length === 1)
  const nodeAt = main.indexOf("registerBackgroundNode('startup-records'")
  const armAt = main.indexOf('armBackgroundDiscovery();')
  check('the node is registered before the background class arms', nodeAt > 0 && armAt > nodeAt, `${nodeAt},${armAt}`)
  const barrel = readFileSync(join(SRC, 'utils/config.ts'), 'utf8')
  check('the config barrel exports the deferred door and its flush', barrel.includes('saveGlobalConfigDeferred,') && barrel.includes('flushDeferredGlobalConfigSaves,'))
  const store = readFileSync(join(SRC, 'utils/config/globalConfig.ts'), 'utf8')
  check('both save branches fold the pending updates before applying the caller\'s updater', store.includes('mergeFn(file === getGlobalMercuryFile()') && store.includes('foldPendingUpdaters(currentConfig as GlobalConfig)') && store.includes('updater(foldPendingUpdaters(currentConfig))'))
  check('a landed write clears the pending list on both branches', (store.match(/pendingDeferredUpdaters = \[\]/g) ?? []).length === 2)
}

console.log(failures === 0 ? '\n✅ ALL STARTUP-COUNTER-DEFERRED PROOFS PASS' : `\n❌ ${failures} STARTUP-COUNTER-DEFERRED PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
