#!/usr/bin/env bun
// gate-watch: src/utils/fileStateCache.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

const { cacheKeys, cloneFileStateCache, createFileStateCacheWithSizeLimit, FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const state = (content: string) => ({ content, timestamp: 1, offset: undefined, limit: undefined })

console.log('keys are normalised paths; recency orders them')
{
  const cache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  cache.set('a/./b/../c.ts', state('one'))
  check('a redundant spelling reads back through its folded key', cache.get('a/c.ts')?.content === 'one' && cache.has('a//c.ts'))
  check('a relative and an absolute spelling stay two keys', !cache.has('/a/c.ts'))
  cache.set('d.ts', state('two'))
  cache.get('a/c.ts')
  check('keys answer most recently used first', j(cacheKeys(cache)) === j(['a/c.ts', 'd.ts']), j(cacheKeys(cache)))
  check('set answers the cache itself', cache.set('e.ts', state('three')) === cache)
  check('delete answers whether a key left', cache.delete('e.ts') === true && cache.delete('e.ts') === false)
  check('entries walk the same order', [...cache.entries()].map(([k]) => k).join(',') === 'a/c.ts,d.ts')
  cache.clear()
  check('clear empties the cache', cache.size === 0 && cache.calculatedSize === 0)
}

console.log('the two bounds: entries and bytes')
{
  const byCount = new FileStateCache(2, 1024)
  byCount.set('1', state('a')).set('2', state('b')).set('3', state('c'))
  check('the entry bound evicts the least recently used', j(cacheKeys(byCount)) === j(['3', '2']) && !byCount.has('1'))
  const byBytes = new FileStateCache(100, 10)
  byBytes.set('x', state('12345678')).set('y', state('123'))
  check('the byte bound evicts by UTF-8 weight', !byBytes.has('x') && byBytes.has('y') && byBytes.calculatedSize === 3, j(cacheKeys(byBytes)))
  byBytes.set('empty', state(''))
  check('an empty content weighs one byte', byBytes.calculatedSize === 4)
  check('the limits read back', byCount.max === 2 && byCount.maxSize === 1024)
}

console.log('a clone keeps both limits and every entry')
{
  const cache = new FileStateCache(3, 2048)
  cache.set('p.ts', state('p')).set('q.ts', state('q'))
  const clone = cloneFileStateCache(cache)
  check('the clone is a separate cache with the same limits', clone !== cache && clone.max === 3 && clone.maxSize === 2048)
  check('the clone carries the entries in order', j(cacheKeys(clone)) === j(cacheKeys(cache)) && clone.get('p.ts')?.content === 'p')
  clone.set('r.ts', state('r'))
  check('a write to the clone leaves the original alone', !cache.has('r.ts') && clone.has('r.ts'))
}

console.log(failures === 0 ? '\nprove-read-cache-bounds: ALL PASS' : `\nprove-read-cache-bounds: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
