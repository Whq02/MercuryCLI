#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-webfetch-cache-hygiene.ts — the WebFetch
//  content cache's retention law: "fifteen-minute self-cleaning" is LITERAL.
//
//  The class (harness-sweep, lane DS parcel 5): lru-cache with a bare
//  `ttl` stops SERVING an expired entry but keeps its bytes until size
//  displacement — page-sized values in a long-lived session are real
//  retention. `ttlAutopurge: true` is the purge timer that makes the prompt
//  copy true.
//
//    §1 the library law itself, both directions (the refutation guard):
//       without autopurge an expired entry's bytes linger; with it they
//       drain on the timer.
//    §2 the source pin: the URL cache carries ttlAutopurge beside its ttl;
//       the domain-verdict cache deliberately does not (128 boolean
//       entries — a timer apiece would outweigh what it frees).
//
//  Run: ~/.bun/bin/bun run scripts/builtin-tools/prove-webfetch-cache-hygiene.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LRUCache } from 'lru-cache'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('prove-webfetch-cache-hygiene — the self-cleaning cache is literal')

// §1 — the library law, demonstrated on this exact lru-cache version.
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
  await sleep(200) // 5× the ttl — generous against a loaded runner
  // Size is read BEFORE any access: get() lazily purges the expired entry,
  // so the retention class is exactly the never-touched-again key.
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

// §2 — the source pin on the one owner.
{
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'WebFetchTool', 'utils.ts'),
    'utf-8',
  )
  const urlCacheBlock = src.slice(src.indexOf('const urlCache'), src.indexOf('const domainCheckCache'))
  check(
    'the URL cache carries ttlAutopurge beside its ttl',
    urlCacheBlock.includes('ttl: 15 * 60 * 1000') && urlCacheBlock.includes('ttlAutopurge: true'),
  )
  const domainBlock = src.slice(src.indexOf('const domainCheckCache'))
  check(
    'the domain-verdict cache deliberately skips the purge timer (boolean entries)',
    !domainBlock.slice(0, domainBlock.indexOf('})')).includes('ttlAutopurge'),
  )
  check(
    'the prompt copy still promises self-cleaning (the pin keeps it honest)',
    readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'WebFetchTool', 'prompt.ts'), 'utf-8').includes(
      'self-cleaning',
    ),
  )
}

console.log('')
if (failures > 0) {
  console.error(`prove-webfetch-cache-hygiene: ${failures} failure(s)`)
  process.exit(1)
}
console.log('prove-webfetch-cache-hygiene: all green')
