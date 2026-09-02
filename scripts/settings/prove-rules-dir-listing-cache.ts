#!/usr/bin/env bun
// prove-rules-dir-listing-cache — the instruction rules-dir readdir cache
// (FN-014 row 2: the per-touched-file loop re-walked the SAME ancestor
// ladders for every file the agent touched — O(files × levels) real seeks,
// mostly for rules dirs that DON'T exist).
//
//   §1 a repeat traversal of the same rules dir inside the TTL pays ZERO
//      further readdirs and composes the same entries;
//   §2 the ABSENT-dir answer is cached too (the common case IS the win:
//      one attempted listing, every later probe free);
//   §3 the cache keys per injected fs implementation — one fake's listings
//      never serve another's (the prover-isolation law);
//   §4 the knobs stay pinned in source: 5 s TTL (the refresh-floor
//      precedent), bounded LRU, negative-as-null wrapped so a cached null
//      is never a miss.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rules-cache-home-'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { getFsImplementation, setFsImplementation } = await import('../../src/utils/fsOperations.ts')
const { processRulesDir } = await import('../../src/services/instructions/discovery.ts')
const { mercuryNativeConvention } = await import('../../src/services/instructions/adapters/mercuryNative.ts')

const real = getFsImplementation()
const scratch = mkdtempSync(join(tmpdir(), 'rules-cache-dir-'))
const rulesDir = join(scratch, 'rules')
mkdirSync(rulesDir, { recursive: true })
writeFileSync(join(rulesDir, 'one.md'), '# a rule\nplain body, no globs\n')

function countingFs(): { fs: typeof real; count: () => number } {
  let readdirs = 0
  const fs = {
    ...real,
    readdir: (p: string) => {
      readdirs++
      return real.readdir(p)
    },
  }
  return { fs, count: () => readdirs }
}

const drive = (dir: string): Promise<unknown[]> =>
  processRulesDir({
    convention: mercuryNativeConvention,
    rulesDir: dir,
    type: 'Project',
    processedPaths: new Set<string>(),
    includeExternal: false,
    conditionalRule: false,
  })

try {
  console.log('§1 repeat traversal serves the cached listing')
  {
    const { fs, count } = countingFs()
    setFsImplementation(fs)
    const first = await drive(rulesDir)
    const afterFirst = count()
    const second = await drive(rulesDir)
    check('the first traversal lists the dir', afterFirst >= 1 && first.length === 1, `readdirs=${afterFirst} entries=${first.length}`)
    check('the repeat traversal pays ZERO further readdirs', count() === afterFirst, `readdirs=${count()}`)
    check('the repeat composes the same entries', second.length === first.length)
  }

  console.log('§2 the absent dir caches its negative answer')
  {
    const { fs, count } = countingFs()
    setFsImplementation(fs)
    const missing = join(scratch, 'no-such', 'rules')
    const a = await drive(missing)
    const afterFirst = count()
    const b = await drive(missing)
    check('an absent rules dir answers empty', a.length === 0 && b.length === 0)
    check('one attempted listing, every later probe free', afterFirst === 1 && count() === 1, `first=${afterFirst} total=${count()}`)
  }

  console.log('§3 per-implementation keying')
  {
    const { fs, count } = countingFs()
    setFsImplementation(fs)
    await drive(rulesDir)
    check("a fresh fs implementation pays its OWN first listing (no cross-impl serve)", count() >= 1, `readdirs=${count()}`)
  }

  console.log('§4 the knobs stay pinned')
  {
    const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'instructions', 'discovery.ts'), 'utf8')
    check('5 s TTL (the refresh-floor precedent)', src.includes('RULES_DIR_LISTING_TTL_MS = 5000'))
    check('bounded LRU, per-impl WeakMap, negative-as-null wrapped', src.includes('new LRUCache({ max: 500, ttl: RULES_DIR_LISTING_TTL_MS })') && src.includes('rulesDirListingCaches = new WeakMap') && src.includes('cache.set(dir, { entries: null })'))
    check('the traversal rides the cache (no bare readdir in processRulesDir)', /const entries = await cachedRulesDirListing\(fs, resolvedRulesDir\)/.test(src))
  }
} finally {
  setFsImplementation(real)
}

console.log(`\n${failures === 0 ? '✅ RULES-DIR LISTING CACHE: green' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
