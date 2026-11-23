#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

const { mapWithConcurrency, discoveryPoolWidth } = await import('../../src/platform/async/concurrency.ts')

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
  check('in-flight work never exceeded the width (and the pool did run wide)', peak <= 4 && peak >= 2, `peak=${peak} | fix: mapWithConcurrency in src/platform/async/concurrency.ts must run at most limit workers and more than one`)
  check('results land in input order', out.length === 200 && out.every((v, i) => v === i * 2), 'fix: mapWithConcurrency in src/platform/async/concurrency.ts must store each result at its input index')
  const statted = await mapWithConcurrency(['a', 'missing', 'c'], 4, async file => {
    try {
      if (file === 'missing') throw new Error('ENOENT')
      return { file, mtimeMs: 5 }
    } catch {
      return { file, mtimeMs: 0 }
    }
  })
  check('a caught per-item failure yields its fallback in place', statted[0]?.mtimeMs === 5 && statted[1]?.mtimeMs === 0 && statted[2]?.file === 'c', j(statted) + ' | fix: mapWithConcurrency in src/platform/async/concurrency.ts must keep a mapper fallback at its own index')
  let rejected = false
  try {
    await mapWithConcurrency([1, 2, 3], 2, async i => {
      if (i === 2) throw new Error('boom')
      return i
    })
  } catch {
    rejected = true
  }
  check('an UNCAUGHT throw rejects the whole map (why the catch must stay inside the mapper)', rejected, 'fix: mapWithConcurrency in src/platform/async/concurrency.ts must reject when a mapper throws')
}

console.log('\n§2 the width has one owner')
{
  const width = discoveryPoolWidth()
  check('the width is an integer in [1, 4]', Number.isInteger(width) && width >= 1 && width <= 4, String(width) + ' | fix: discoveryPoolWidth in src/platform/async/concurrency.ts must return an integer from 1 to 4')
}


console.log('\n§4 the tool over a scratch tree')
{
  const { GrepTool } = await import('../../src/tools/grep/GrepTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
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
  check('files_with_matches lists every hit file exactly once', result.data.numFiles === hits.length && listed.length === hits.length && new Set(listed).size === hits.length, j({ numFiles: result.data.numFiles, listed: listed.length }) + ' | fix: the files_with_matches walk in src/tools/grep/GrepTool.ts (GrepTool.call) must list each hit file once')
  check('…none missed, none invented', hits.every(h => listed.includes(h)) && listed.every(l => hits.includes(l)), j(listed.filter(l => !hits.includes(l))) + ' | fix: GrepTool.call in src/tools/grep/GrepTool.ts must list every matching file and no other')
  check('the walk finished (no incomplete note)', result.data.incomplete === undefined, String(result.data.incomplete) + ' | fix: GrepTool.call in src/tools/grep/GrepTool.ts must finish the walk and set no incomplete note')
  const paged = (await GrepTool.call({ pattern: 'needle', path: dir, head_limit: 5 } as never, context)) as { data: { numFiles: number; filenames: string[]; appliedLimit?: number } }
  check('pagination applies after the walk: five of the sorted hits, the limit reported', paged.data.numFiles === 5 && paged.data.filenames.length === 5 && paged.data.appliedLimit === 5, j(paged.data) + ' | fix: head_limit in GrepTool.call in src/tools/grep/GrepTool.ts must cut to five after the walk and report appliedLimit')
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-grep-stat-fanout: all green' : `\nprove-grep-stat-fanout: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
