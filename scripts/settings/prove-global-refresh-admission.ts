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
  assert.equal(options.persistent, false)
  assert.equal(options.interval, 1000)
  tick = callback
  return {} as never
})
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
try {
  const config = await import(join(root, 'utils/config/globalConfig.ts'))
  const fsops = await import(join(root, 'utils/fsOperations.ts'))
  config.enableConfigs()
  config.getGlobalConfig()
  config.getGlobalConfig()
  assert.equal(starts, 1)
  let notifications = 0
  const stop = config.subscribeGlobalConfigCache(() => { notifications++ })
  const disk = fsops.getFsImplementation()
  const requests: Array<(content: string) => void> = []
  const reads = spyOn(disk, 'readFile').mockImplementation(() => new Promise<string>(resolve => requests.push(resolve)) as never)
  try {
    let stamp = config.getGlobalConfigCacheStamp()
    tick({ mtimeMs: stamp })
    tick({ mtimeMs: 0 })
    assert.equal(requests.length, 0)
    tick({ mtimeMs: stamp + 1 })
    requests.shift()!('\uFEFF{"theme":"dark"}')
    await settle()
    assert.equal(config.getGlobalConfig().theme, 'dark')
    assert.equal(config.getGlobalConfigCacheStamp(), stamp + 1)
    assert.equal(notifications, 1)
    stamp = config.getGlobalConfigCacheStamp()
    for (const invalid of ['{', 'null', '2', '"text"']) {
      tick({ mtimeMs: stamp + 1 })
      requests.shift()!(invalid)
      await settle()
      assert.equal(config.getGlobalConfigCacheStamp(), stamp)
      assert.equal(notifications, 1)
    }
    tick({ mtimeMs: stamp + 1 })
    const pending = requests.shift()!
    const now = spyOn(Date, 'now').mockReturnValue(stamp + 2)
    config.writeThroughGlobalConfigCache({ ...config.getGlobalConfig(), theme: 'fixture-newer-theme' })
    now.mockRestore()
    pending('{"theme":"dark"}')
    await settle()
    assert.equal(config.getGlobalConfig().theme, 'fixture-newer-theme')
    assert.equal(config.getGlobalConfigCacheStamp(), stamp + 2)
    assert.equal(notifications, 1)
    console.log('PASS global refresh singleton, mtime gates, BOM, torn reads and in-flight write-through race')
  } finally { reads.mockRestore(); stop() }
} finally {
  watcher.mockRestore()
  fs.rmSync(home, { recursive: true, force: true })
}
console.log('PASS global refresh admission')
