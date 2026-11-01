import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { COMPILE_CACHE_MAX_BYTES, COMPILE_CACHE_MAX_FILES, COMPILE_CACHE_PRUNE_INTERVAL_MS, pruneCompileCache } from '../../src/utils/runtime/compileCachePrune.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
assert.ok(process.env.MERCURY_CONFIG_DIR, 'the proof needs a scratch config home')
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'compile-bound-'))
const bucketName = 'v24.22.1-arm64-1234abcd-501'
const makeHome = (name: string): string => { const home = join(scratch, name); mkdirSync(join(home, 'compile-cache'), { recursive: true }); return home }
const bucketOf = (home: string, name = bucketName): string => { const path = join(home, 'compile-cache', name); mkdirSync(path, { recursive: true }); return path }
const sparse = (path: string, bytes: number): void => { writeFileSync(path, ''); truncateSync(path, bytes) }
try {
  const huge = makeHome('huge')
  const hugeBucket = bucketOf(huge)
  sparse(join(hugeBucket, '00000001'), COMPILE_CACHE_MAX_BYTES + 1)
  assert.equal((await pruneCompileCache(huge, { NODE_COMPILE_CACHE: join(huge, 'compile-cache') })).state, 'complete')
  assert.deepEqual(readdirSync(hugeBucket), [])
  writeFileSync(join(hugeBucket, 'new-cache'), 'kept')
  assert.equal((await pruneCompileCache(huge, {})).state, 'fresh')
  assert.equal(readFileSync(join(hugeBucket, 'new-cache'), 'utf8'), 'kept')
  console.log('PASS oversized cache evicted, its writable directory restored, hourly repeat skipped')

  const many = makeHome('many')
  const manyBucket = bucketOf(many)
  for (let i = 0; i <= COMPILE_CACHE_MAX_FILES; i++) writeFileSync(join(manyBucket, i.toString(16).padStart(8, '0')), '')
  assert.equal((await pruneCompileCache(many, {})).state, 'complete')
  assert.deepEqual(readdirSync(manyBucket), [])
  console.log('PASS file-count cap bounds tiny-file growth too')

  const combined = makeHome('combined')
  const older = bucketOf(combined)
  const newer = bucketOf(combined, 'v24.22.2-x64-abcdef12')
  sparse(join(older, '00000001'), COMPILE_CACHE_MAX_BYTES / 2 + 1)
  sparse(join(newer, '00000001'), COMPILE_CACHE_MAX_BYTES / 2 + 1)
  utimesSync(join(older, '00000001'), 1, 1)
  assert.deepEqual((await pruneCompileCache(combined, {})).removed, [bucketName])
  assert.deepEqual(readdirSync(older), [])
  assert.deepEqual(readdirSync(newer), ['00000001'])
  console.log('PASS aggregate byte cap keeps the newer bucket')

  const preserved = makeHome('preserved')
  const own = bucketOf(preserved)
  sparse(join(own, '00000001'), COMPILE_CACHE_MAX_BYTES + 1)
  assert.equal((await pruneCompileCache(preserved, { NODE_COMPILE_CACHE: join(scratch, 'operator-cache') })).state, 'skipped')
  assert.equal((await pruneCompileCache(preserved, { NODE_DISABLE_COMPILE_CACHE: '1' })).state, 'skipped')
  assert.deepEqual(readdirSync(own), ['00000001'])
  const foreign = bucketOf(preserved, 'not-a-node-cache')
  writeFileSync(join(foreign, 'keep'), 'untouched')
  if (process.platform !== 'win32') {
    const linked = makeHome('linked')
    rmSync(join(linked, 'compile-cache'), { recursive: true })
    symlinkSync(join(preserved, 'compile-cache'), join(linked, 'compile-cache'))
    assert.equal((await pruneCompileCache(linked, {})).state, 'skipped')
    symlinkSync(foreign, join(preserved, 'compile-cache', 'v24.23.0-x64-1234abcd'))
  }
  const results = await Promise.all([pruneCompileCache(preserved, {}), pruneCompileCache(preserved, {})])
  assert.equal(results.filter(result => result.state === 'complete').length, 1)
  assert.ok(results.every(result => ['complete', 'busy', 'fresh'].includes(result.state)))
  assert.equal(readFileSync(join(foreign, 'keep'), 'utf8'), 'untouched')
  console.log('PASS opt-out, external pin, foreign folders, symlinks and concurrent boots are respected')

  const tomb = join(huge, 'compile-cache', `.prune-${bucketName}-00000000-0000-4000-8000-000000000000`)
  mkdirSync(tomb)
  writeFileSync(join(tomb, 'left-on-exit'), 'cache')
  const old = new Date(Date.now() - COMPILE_CACHE_PRUNE_INTERVAL_MS - 1000)
  utimesSync(join(huge, 'compile-cache', '.last-prune'), old, old)
  assert.equal((await pruneCompileCache(huge, {})).state, 'complete')
  assert.ok(!readdirSync(join(huge, 'compile-cache')).includes(tomb.split(/[\\/]/).pop()!))
  console.log('PASS the next pass finishes an interrupted retired-directory removal')

  const live = makeHome('node')
  const cache = join(live, 'compile-cache')
  const entry = join(live, 'fixture.mjs')
  writeFileSync(entry, 'export const answer = 42; console.log(answer)\n')
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_COMPILE_CACHE: cache }
  delete env.NODE_DISABLE_COMPILE_CACHE
  const node = nodeBinPath()
  const run = () => { const result = spawnSync(node, [entry], { env, encoding: 'utf8', timeout: 30_000 }); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '42') }
  run()
  const nodeBucket = readdirSync(cache).find(name => name.startsWith('v'))!
  assert.ok(nodeBucket)
  sparse(join(cache, nodeBucket, 'oversized'), COMPILE_CACHE_MAX_BYTES + 1)
  assert.deepEqual((await pruneCompileCache(live, env)).removed, [nodeBucket])
  run()
  assert.ok(readdirSync(join(cache, nodeBucket)).length > 0)
  const boot = readFileSync(new URL('../../src/entrypoints/cli.tsx', import.meta.url), 'utf8')
  assert.ok(boot.includes("void import('../utils/runtime/compileCachePrune.js')") && boot.includes('pruneCompileCache(cacheHome)'))
  console.log('PASS Node runs and repopulates after eviction; boot schedules the pruner without awaiting it')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
