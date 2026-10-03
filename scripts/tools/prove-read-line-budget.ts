#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-read-line-budget')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'read-line-budget-'))
const work = join(scratch, 'work')
mkdirSync(work)
const sixty = JSON.stringify({ kind: 'roster', payload: 'a'.repeat(60 * 1024), end: 'sixty-end' })
const twoHundred = JSON.stringify({ kind: 'image', payload: 'b'.repeat(200 * 1024), end: 'two-hundred-end' })
const file = join(work, 'records.output')
const jsonl = join(work, 'records.jsonl')
const fixtureContent = [sixty, twoHundred, ...Array.from({ length: 400 }, (_, i) => JSON.stringify({ i, text: 'c'.repeat(1500) }))].join('\n')
writeFileSync(file, fixtureContent)
writeFileSync(jsonl, fixtureContent)
const cases = [
  { label: 'plain 60 KB', offset: 1, limit: 1, line_anchors: false },
  { label: 'plain 200 KB', offset: 2, limit: 1, line_anchors: false },
  { label: 'anchored 60 KB', offset: 1, limit: 1, line_anchors: true },
  { label: 'anchored 200 KB', offset: 2, limit: 1, line_anchors: true },
  { label: 'plain recovery', offset: 1, limit: 2000, line_anchors: false },
  { label: 'anchored recovery', offset: 1, limit: 2000, line_anchors: true },
  { label: 'JSONL recovery', file_path: jsonl, offset: 1, limit: 2000, line_anchors: false },
  { label: 'JSONL anchored recovery', file_path: jsonl, offset: 1, limit: 2000, line_anchors: true },
].map((entry, index) => {
  const file_path = join(work, `records-${index}.${entry.file_path ? 'jsonl' : 'output'}`)
  writeFileSync(file_path, fixtureContent)
  return { ...entry, file_path }
})
const seen: SeenResult[] = []
let next = 0
const fixture = await startScriptedFixture(req => {
  if (req.opening !== 'read-line-budget') return [{ type: 'text', text: 'done' }]
  if (req.results.length) seen.push(req.results.at(-1)!)
  const entry = cases[next++]
  if (!entry) return [{ type: 'text', text: 'done' }]
  const { label, ...window } = entry
  return [{ type: 'tool_use', name: 'Read', input: { file_path: file, ...window } }]
})
console.log(`build under proof: ${DIST}`)
try {
  const turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base: fixture.base, ask: 'read-line-budget', timeoutMs: 120_000, extraArgv: ['--sovereign'] })
  tally.check('the Read journeys settle', turn.exitCode === 0 && seen.length === cases.length, turn.stderr.slice(-500))
  for (let i = 0; i < cases.length; i++) {
    const entry = cases[i]!
    const result = seen[i]
    const rows = (result?.text ?? '').split('\n').filter(line => /^\d+(?:#[0-9a-f]+)?\t/.test(line))
    const content = rows.map(line => line.slice(line.indexOf('\t') + 1))
    const detail = JSON.stringify({ error: result?.isError, chars: result?.text.length, rowLengths: content.slice(0, 3).map(line => line.length), lead: result?.text.slice(0, 240) })
    tally.check(`${entry.label}: text rows are returned`, result !== undefined && !result.isError && rows.length > 0, detail)
    tally.check(`${entry.label}: oversized rows are clipped and marked`, content.length > 0 && content.every(line => line.length <= 2050) && content[0]!.includes('truncated') && !(result?.text.includes('sixty-end') || result?.text.includes('two-hundred-end')), detail)
    tally.check(`${entry.label}: the returned text stays within the output budget`, result !== undefined && result.text.length <= 101_000, detail)
    if (entry.line_anchors) {
      const raw = entry.offset === 2 ? twoHundred : sixty
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 4)
      tally.check(`${entry.label}: the anchor still identifies the complete source line`, rows[0]?.startsWith(`${entry.offset}#${hash}\t`) === true, detail)
    }
    if (entry.limit > 1) {
      tally.check(`${entry.label}: the token recovery returns a bounded prefix with a continuation`, /^File content \(\d+ tokens\) exceeds maximum allowed tokens \(25000\):/.test(result?.text ?? '') && (result?.text.includes('Read(offset:') ?? false) && content[1]?.includes('truncated') === true, detail)
    }
  }
} finally {
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()
