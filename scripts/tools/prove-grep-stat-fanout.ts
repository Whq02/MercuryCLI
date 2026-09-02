#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-grep-stat-fanout.ts — Grep's files_with_matches stat
//  walk is bounded.
//
//  THE DEFECT: files_with_matches sorts by mtime, so every hit path is
//  stat'ed BEFORE pagination — through an unbounded Promise.all over the
//  whole hit list. At the ripgrep output ceiling (20 MB of paths) that is
//  hundreds of thousands of stats queued at once against libuv's
//  four-thread pool: memory for the promise wall, a stalled loop, and the
//  head_limit the caller asked for never shortened the walk.
//
//  THE LAW: the walk rides mapWithConcurrency at the disk-metadata pool
//  width — the session-discovery scans' own width, lifted into the pool
//  module so the fact has one owner. Order-preserving, so the sort sees
//  byte-identical input; the per-file catch stays INSIDE the mapper (the
//  pool rejects the whole map on an uncaught throw), so a deleted file still
//  sorts as time zero.
//
//   §1 the pool: in-flight work never exceeds the width, results land in
//      input order, a caught per-item failure yields its fallback in place,
//      and an UNCAUGHT throw rejects the map (the law the mapper respects);
//   §2 the width: one exported owner in concurrency.ts, in [1, 4]; the
//      session-discovery scans import it and keep no local copy;
//   §3 the Grep walk, source-pinned: mapWithConcurrency at the width with
//      the try/catch inside; no Promise.all over the hit list remains;
//   §4 the tool driven over a scratch tree (NODE_ENV=test — filename
//      order): every hit file listed exactly once, none missed, paginated
//      after the walk.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-grep-stat-fanout.ts
// ============================================================================
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')
const j = (v: unknown): string => JSON.stringify(v)

const { mapWithConcurrency, discoveryPoolWidth } = await import('../../src/utils/concurrency.ts')

console.log('§1 the pool bounds the fan-out and keeps the order')
{
  const items = Array.from({ length: 200 }, (_, i) => i)
  let inFlight = 0
  let peak = 0
  const out = await mapWithConcurrency(items, 4, async i => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, (i % 3) + 1))
    inFlight--
    return i * 2
  })
  check('in-flight work never exceeded the width (and the pool did run wide)', peak <= 4 && peak >= 2, `peak=${peak}`)
  check('results land in input order', out.length === 200 && out.every((v, i) => v === i * 2))
  // The Grep mapper's own shape: the catch stays inside, a failed stat sorts as zero.
  const statted = await mapWithConcurrency(['a', 'missing', 'c'], 4, async file => {
    try {
      if (file === 'missing') throw new Error('ENOENT')
      return { file, mtimeMs: 5 }
    } catch {
      return { file, mtimeMs: 0 }
    }
  })
  check('a caught per-item failure yields its fallback in place', statted[0]?.mtimeMs === 5 && statted[1]?.mtimeMs === 0 && statted[2]?.file === 'c', j(statted))
  let rejected = false
  try {
    await mapWithConcurrency([1, 2, 3], 2, async i => {
      if (i === 2) throw new Error('boom')
      return i
    })
  } catch {
    rejected = true
  }
  check('an UNCAUGHT throw rejects the whole map (why the catch must stay inside the mapper)', rejected)
}

console.log('\n§2 the width has one owner')
{
  const width = discoveryPoolWidth()
  check('the width is an integer in [1, 4]', Number.isInteger(width) && width >= 1 && width <= 4, String(width))
  const conc = readFileSync(join(ROOT, 'src/utils/concurrency.ts'), 'utf8')
  check('the owner reads the quota-aware core count, capped at the fs pool', /export function discoveryPoolWidth\(\): number \{\s*\n\s*return Math\.max\(1, Math\.min\(4, availableCores\(\)\)\)/.test(conc))
  const logs = readFileSync(join(ROOT, 'src/utils/sessionStorage/logs.ts'), 'utf8')
  check('the session-discovery scans import the width from the pool module', /import \{[^}]*\bdiscoveryPoolWidth\b[^}]*\} from '\.\.\/concurrency\.js'/.test(logs))
  check('…and keep no local copy', !/function discoveryPoolWidth\(/.test(logs))
  check('…still sizing every scan from it', (logs.match(/mapWithConcurrency\([^,]+, discoveryPoolWidth\(\)/g) ?? []).length >= 6)
}

console.log('\n§3 the Grep walk is the bounded pool')
{
  const src = readFileSync(join(ROOT, 'src/tools/GrepTool/GrepTool.ts'), 'utf8')
  check('the stat walk rides mapWithConcurrency at the discovery width', /const statted = await mapWithConcurrency\(lines, discoveryPoolWidth\(\), async file => \{/.test(src))
  check(
    'the per-file catch stays inside the mapper (time zero on failure)',
    /async file => \{\s*\n\s*try \{\s*\n\s*const stats = await stat\(file\)\s*\n\s*return \{ file, mtimeMs: stats\.mtimeMs \}\s*\n\s*\} catch \{\s*\n\s*return \{ file, mtimeMs: 0 \}/.test(src),
  )
  check('no Promise.all over the hit list remains', !src.includes('Promise.all('))
  check('the pool and the width come from the one module', src.includes("import { discoveryPoolWidth, mapWithConcurrency } from '../../utils/concurrency.js'"))
}

console.log('\n§4 the tool over a scratch tree')
{
  const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'grep-fanout-')))
  const hits: string[] = []
  for (let i = 0; i < 30; i++) {
    const name = `f${String(i).padStart(2, '0')}.txt`
    const hit = i % 3 !== 0
    writeFileSync(join(dir, name), hit ? `line\nneedle ${i}\n` : `line\nnothing ${i}\n`)
    if (hit) hits.push(name)
  }
  const context = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never
  const result = (await GrepTool.call({ pattern: 'needle', path: dir } as never, context)) as {
    data: { mode: string; numFiles: number; filenames: string[]; appliedLimit?: number; incomplete?: string }
  }
  const listed = result.data.filenames.map(f => f.split(/[\\/]/).pop() ?? f)
  check('files_with_matches lists every hit file exactly once', result.data.numFiles === hits.length && listed.length === hits.length && new Set(listed).size === hits.length, j({ numFiles: result.data.numFiles, listed: listed.length }))
  check('…none missed, none invented', hits.every(h => listed.includes(h)) && listed.every(l => hits.includes(l)), j(listed.filter(l => !hits.includes(l))))
  check('the walk finished (no incomplete note)', result.data.incomplete === undefined, String(result.data.incomplete))
  const paged = (await GrepTool.call({ pattern: 'needle', path: dir, head_limit: 5 } as never, context)) as { data: { numFiles: number; filenames: string[]; appliedLimit?: number } }
  check('pagination applies after the walk: five of the sorted hits, the limit reported', paged.data.numFiles === 5 && paged.data.filenames.length === 5 && paged.data.appliedLimit === 5, j(paged.data))
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-grep-stat-fanout: all green' : `\nprove-grep-stat-fanout: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
