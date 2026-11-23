import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spyOn } from 'bun:test'

const home = fs.mkdtempSync(join(tmpdir(), 'global-refresh-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
let tick: (current: { mtimeMs: number }) => void = () => { throw new Error('watcher not started') }
let starts = 0
const watcher = spyOn(fs, 'watchFile').mockImplementation((_file: any, options: any, callback: any) => {
  starts++
  assert.equal(options.persistent, false, 'the config watcher must be non-persistent: fix the watchFile options in configRefreshListener setup in src/platform/config/globalConfig.ts')
  assert.equal(options.interval, 1000, 'the config watcher must poll every 1000 ms: fix CONFIG_FRESHNESS_POLL_MS in src/platform/config/globalConfig.ts')
  tick = callback
  return {} as never
})
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
try {
  const config = await import(join(root, 'platform/config/globalConfig.ts'))
  const fsops = await import(join(root, 'platform/files/fsOperations.ts'))
  config.enableConfigs()
  config.getGlobalConfig()
  config.getGlobalConfig()
  assert.equal(starts, 1, `repeated getGlobalConfig calls must start one watcher, saw ${starts}: fix the watcher start in src/platform/config/globalConfig.ts`)
  let notifications = 0
  const stop = config.subscribeGlobalConfigCache(() => { notifications++ })
  const disk = fsops.getFsImplementation()
  const requests: Array<(content: string) => void> = []
  const reads = spyOn(disk, 'readFile').mockImplementation(() => new Promise<string>(resolve => requests.push(resolve)) as never)
  try {
    let stamp = config.getGlobalConfigCacheStamp()
    tick({ mtimeMs: stamp })
    tick({ mtimeMs: 0 })
    assert.equal(requests.length, 0, `a tick whose mtime is not newer than the cache stamp must not read the file, saw ${requests.length} reads: fix the mtime gate in configRefreshListener in src/platform/config/globalConfig.ts`)
    tick({ mtimeMs: stamp + 1 })
    requests.shift()!('\uFEFF{"theme":"dark"}')
    await settle()
    assert.equal(config.getGlobalConfig().theme, 'dark', 'a newer mtime must refresh the cache from the file text, BOM stripped: fix acceptConfigRefresh in src/platform/config/globalConfig.ts')
    assert.equal(config.getGlobalConfigCacheStamp(), stamp + 1, 'an accepted refresh must advance the cache stamp to the new mtime: fix acceptConfigRefresh in src/platform/config/globalConfig.ts')
    assert.equal(notifications, 1, `an accepted refresh must notify subscribers once, saw ${notifications}: fix subscribeGlobalConfigCache notification in src/platform/config/globalConfig.ts`)
    stamp = config.getGlobalConfigCacheStamp()
    for (const invalid of ['{', 'null', '2', '"text"']) {
      tick({ mtimeMs: stamp + 1 })
      requests.shift()!(invalid)
      await settle()
      assert.equal(config.getGlobalConfigCacheStamp(), stamp, `a torn or non-object read (${invalid}) must leave the cache stamp unchanged: fix acceptConfigRefresh in src/platform/config/globalConfig.ts`)
      assert.equal(notifications, 1, `a torn or non-object read (${invalid}) must not notify subscribers, saw ${notifications}: fix acceptConfigRefresh in src/platform/config/globalConfig.ts`)
    }
    tick({ mtimeMs: stamp + 1 })
    const pending = requests.shift()!
    const now = spyOn(Date, 'now').mockReturnValue(stamp + 2)
    config.writeThroughGlobalConfigCache({ ...config.getGlobalConfig(), theme: 'fixture-newer-theme' })
    now.mockRestore()
    pending('{"theme":"dark"}')
    await settle()
    assert.equal(config.getGlobalConfig().theme, 'fixture-newer-theme', 'a read that finishes after a newer write-through must be dropped: fix acceptConfigRefresh and writeThroughGlobalConfigCache in src/platform/config/globalConfig.ts')
    assert.equal(config.getGlobalConfigCacheStamp(), stamp + 2, 'the stale in-flight read must not move the cache stamp back: fix acceptConfigRefresh in src/platform/config/globalConfig.ts')
    assert.equal(notifications, 1, `the dropped in-flight read must not notify subscribers, saw ${notifications}: fix acceptConfigRefresh in src/platform/config/globalConfig.ts`)
    console.log('PASS global refresh singleton, mtime gates, BOM, torn reads and in-flight write-through race')
  } finally { reads.mockRestore(); stop() }
} finally {
  watcher.mockRestore()
  fs.rmSync(home, { recursive: true, force: true })
}
console.log('PASS global refresh admission')
