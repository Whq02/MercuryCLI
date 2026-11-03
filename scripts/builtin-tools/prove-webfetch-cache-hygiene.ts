#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LRUCache } from 'lru-cache'
import { getPrompt } from '../../src/tools/WebFetchTool/prompt.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('prove-webfetch-cache-hygiene — the self-cleaning cache is literal')

{
  const mk = (ttlAutopurge: boolean): LRUCache<string, string> =>
    new LRUCache<string, string>({
      ttl: 40,
      ...(ttlAutopurge ? { ttlAutopurge: true } : {}),
      maxSize: 1024 * 1024,
      sizeCalculation: entry => Math.max(1, entry.length),
    })
  const bare = mk(false)
  const purged = mk(true)
  const page = 'x'.repeat(64 * 1024)
  bare.set('u', page)
  purged.set('u', page)
  await sleep(200)
  const lingering = bare.calculatedSize
  check(
    'WITHOUT autopurge the expired page is unservable yet its bytes linger (the class is real)',
    lingering > 0 && bare.get('u') === undefined,
    `calculatedSize=${lingering}`,
  )
  check(
    'WITH autopurge the expired page drains on the timer',
    purged.get('u') === undefined && purged.calculatedSize === 0,
    `calculatedSize=${purged.calculatedSize}`,
  )
}

{
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'WebFetchTool', 'utils.ts'),
    'utf-8',
  )
  const urlCacheBlock = src.slice(src.indexOf('const urlCache'), src.indexOf('export function clearWebFetchCache'))
  check(
    'the URL cache carries ttlAutopurge beside its ttl',
    urlCacheBlock.includes('ttl: 15 * 60 * 1000') && urlCacheBlock.includes('ttlAutopurge: true'),
  )
  check('the URL cache is the module\'s one cache (no domain-verdict cache remains)', !src.includes('domainCheckCache'))
  const prompt = getPrompt()
  check(
    'the prompt discloses the fifteen-minute repeat-fetch lifetime once',
    prompt.split('Repeat pulls ride a fifteen-minute cache.').length === 2,
  )
  check('the disclosure stays in one paragraph under 300 bytes', !prompt.includes('\n') && Buffer.byteLength(prompt) <= 300, String(Buffer.byteLength(prompt)))
}

console.log('')
if (failures > 0) {
  console.error(`prove-webfetch-cache-hygiene: ${failures} failure(s)`)
  process.exit(1)
}
console.log('prove-webfetch-cache-hygiene: all green')
