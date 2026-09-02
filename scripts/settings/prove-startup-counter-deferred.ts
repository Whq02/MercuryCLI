#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-startup-counter-deferred.ts — FN-020 row 5: the
//  pre-first-frame fsync band moves behind the first paint.
//
//  The class: directly before launchRepl, every interactive boot paid a
//  locked, backed-up, fsync'd whole-config publish (the numStartups
//  increment) plus a read-modify-write-rename (the invocation record) on the
//  cockpit thread — serial disk latency in front of the first paint, every
//  boot, while the disk was about to get busy with the daemon and the warm
//  runner. First-render readers read the config CACHE, so the increment
//  applies there synchronously and the disk publish rides a launch-graph
//  background node (input-live + settle, or the 3 s deadline).
//
//    D1  a deferred save lands in the cache at once with ZERO disk writes;
//        the flush publishes it — exactly one write — and a second flush
//        writes nothing
//    D2  a save of any kind in between FOLDS the pending update into its
//        own write (the disk can never show the other field without the
//        increment); the flush afterwards writes nothing
//    D3  the same-reference law: an updater that changes nothing schedules
//        nothing
//    D4  two deferred updates stack (both apply, once each), one write
//    D5  wiring — the boot band spells the deferred save, the beacon clear
//        stays synchronous beside it, the background node flushes the
//        counter and records the invocation, no synchronous numStartups
//        save remains in main.tsx, the node is registered before the
//        background class arms, and the barrel exports the door
//
//  Each scenario runs in its own fresh bun subprocess against a scratch
//  MERCURY_CONFIG_DIR (the global config memoizes per process); the
//  instrument is the store's own write counter — operation-shaped, never a
//  wall clock.
// ============================================================================
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

/** Run a scenario body in a fresh process against a scratch home; the body
 *  prints ONE JSON line the scenario asserts on. */
function runIn(body: string): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), 'startup-counter-deferred-'))
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const fs = await import('node:fs')
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
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' } })
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
    g.flushDeferredGlobalConfigSaves()
    out.cacheAfterFlush = g.getGlobalConfig().numStartups
    out.diskAfterFlush = readDisk()?.numStartups
    out.writesAfterFlush = g.getGlobalConfigWriteCount()
    out.pendingAfterFlush = g.hasPendingDeferredGlobalConfigSaves()
    g.flushDeferredGlobalConfigSaves()
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
    g.flushDeferredGlobalConfigSaves()
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
    g.flushDeferredGlobalConfigSaves()
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
    g.flushDeferredGlobalConfigSaves()
    const disk = readDisk()
    out.diskCount = disk?.numStartups
    out.diskTheme = disk?.theme
    out.writes = g.getGlobalConfigWriteCount()
  `)
  check('the cache carries both at once', r.cacheCount === 5 && r.cacheTheme === 'light', `count=${String(r.cacheCount)} theme=${String(r.cacheTheme)}`)
  check('one flush publishes both in one write (5, light)', r.diskCount === 5 && r.diskTheme === 'light' && r.writes === 2, `count=${String(r.diskCount)} theme=${String(r.diskTheme)} writes=${String(r.writes)}`)
}

section('D5 wiring — the boot band and the background node')
{
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  check('the boot band spells the deferred save with the increment', /saveGlobalConfigDeferred\(current => \(\{ \.\.\.current, numStartups: \(current\.numStartups \?\? 0\) \+ 1 \}\)\)/.test(main))
  check('no synchronous numStartups save remains in main.tsx', !/saveGlobalConfig\(current => \(\{ \.\.\.current, numStartups/.test(main))
  const bandAt = main.indexOf('saveGlobalConfigDeferred(current =>')
  const band = bandAt >= 0 ? main.slice(bandAt, bandAt + 1800) : ''
  check('the beacon clear stays synchronous right beside the increment (a quit before the node ran is never a failed attempt)', /saveGlobalConfigDeferred\(current =>[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*clearBootAttempts\(\)/.test(band))
  check("the background node 'startup-records' flushes the counter and records the invocation", /registerBackgroundNode\('startup-records', \(\) => \{\n\s*flushDeferredGlobalConfigSaves\(\)\n\s*try \{\n(?:\s*\/\/[^\n]*\n)*\s*recordInvocation\(\)\n/.test(band))
  check('the invocation record has exactly one interactive call site, inside the node', (main.match(/recordInvocation\(\)/g) ?? []).length === 1)
  const nodeAt = main.indexOf("registerBackgroundNode('startup-records'")
  const armAt = main.indexOf('armBackgroundDiscovery();')
  check('the node is registered before the background class arms', nodeAt > 0 && armAt > nodeAt, `${nodeAt},${armAt}`)
  const barrel = readFileSync(join(SRC, 'utils/config.ts'), 'utf8')
  check('the config barrel exports the deferred door and its flush', barrel.includes('saveGlobalConfigDeferred,') && barrel.includes('flushDeferredGlobalConfigSaves,'))
  const store = readFileSync(join(SRC, 'utils/config/globalConfig.ts'), 'utf8')
  check('both save branches fold the pending updates before applying the caller\'s updater', (store.match(/updater\(foldPendingUpdaters\((?:current|currentConfig)\)\)/g) ?? []).length === 2)
  // Two clears — the locked branch and the lockless fallback; the declaration
  // carries a type annotation and does not spell this.
  check('a landed write clears the pending list on both branches', (store.match(/pendingDeferredUpdaters = \[\]/g) ?? []).length === 2)
}

console.log(failures === 0 ? '\n✅ ALL STARTUP-COUNTER-DEFERRED PROOFS PASS' : `\n❌ ${failures} STARTUP-COUNTER-DEFERRED PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
