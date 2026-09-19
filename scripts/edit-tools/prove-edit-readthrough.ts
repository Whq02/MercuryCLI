#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-edit-readthrough')
const KEEP = process.argv.includes('--keep')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'edit-readthrough-'))
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const READ_LINE_CAP = 2000
const READ_TOKEN_CAP = 25_000
const CHARS_PER_TOKEN = 4

const small = join(work, 'forty.ts')
writeFileSync(small, Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1}`).join('\n') + '\n')
const wide = join(work, 'wide.ts')
writeFileSync(wide, Array.from({ length: 1500 }, (_, i) => `export const wide${i + 1} = '${'x'.repeat(100)}' + '${i + 1}'`).join('\n') + '\n')

const knowledgeFile = join(work, 'knowledge.ts')
const knowledgeOriginal = Array.from({ length: 20 }, (_, i) => `const k${i + 1} = ${i + 1}`).join('\n') + '\n'
writeFileSync(knowledgeFile, knowledgeOriginal)
let knowledgeAnchor = ''
const ASK = 'readthrough-probe'
const seen: Record<string, SeenResult> = {}
const smallEdit = { file_path: small, old_string: 'const v20 = 20', new_string: 'const v20 = 2000' }
const wideEdit = { file_path: wide, old_string: "export const wide3 = '", new_string: "export const wideThree = '" }

let stage = 0
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  if (req.step === 0) {
    stage = 1
    return [{ type: 'tool_use', name: 'Read', input: { file_path: small, offset: 1, limit: 5 } }]
  }
  switch (stage) {
    case 1:
      if (last) seen.window = last
      stage = 2
      return [{ type: 'tool_use', name: 'Edit', input: smallEdit }]
    case 2:
      if (seen.first === undefined) {
        if (last) seen.first = last
        if (last?.isError) return [{ type: 'tool_use', name: 'Edit', input: smallEdit }]
      } else if (last) {
        seen.retry = last
      }
      stage = 3
      return [{ type: 'tool_use', name: 'Read', input: { file_path: wide } }]
    case 3:
      if (last) seen.overCap = last
      stage = 4
      return [{ type: 'tool_use', name: 'Edit', input: wideEdit }]
    case 4:
      if (last) seen.wideEdit = last
      stage = 5
      return [{ type: 'tool_use', name: 'Read', input: { file_path: knowledgeFile, offset: 1, limit: 5, line_anchors: true } }]
    case 5:
      knowledgeAnchor = /\(anchor: ([^)]+)\)/.exec(last?.text ?? '')?.[1] ?? ''
      writeFileSync(knowledgeFile, knowledgeOriginal.replace('const k1 = 1', 'const k1 = 1000'))
      const changedAt = new Date(Date.now() + 120_000)
      utimesSync(knowledgeFile, changedAt, changedAt)
      stage = 6
      return [{ type: 'tool_use', name: 'Grep', input: { pattern: '^const k(6|7|8|9|10) =', path: knowledgeFile, output_mode: 'content' } }]
    case 6:
      stage = 7
      return [{ type: 'tool_use', name: 'Edit', input: { file_path: knowledgeFile, expected_anchor: knowledgeAnchor, hunks: [{ lines: '1-10', replace: 'replacement' }] } }]
    default:
      if (stage === 7 && last) seen.knowledge = last
      stage = 8
      return [{ type: 'text', text: 'done' }]
  }
})

let turn: { exitCode: number | null; stderr: string } = { exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base: fixture.base, ask: ASK, timeoutMs: 120_000, extraArgv: ['--dangerously-bypass-permissions'] })
} finally {
  await fixture.close()
}

const show = (label: string, r: SeenResult | undefined, cap = 40): void => {
  console.log(`\n── ${label} ──`)
  if (!r) {
    console.log(`│ (no tool result reached the wire; run exit ${turn.exitCode ?? '?'}: ${turn.stderr.slice(-400)})`)
    return
  }
  console.log(`│ is_error: ${r.isError}`)
  const lines = r.text.split('\n')
  for (const line of lines.slice(0, cap)) console.log(`│ ${line.length > 160 ? `${line.slice(0, 160)}…` : line}`)
  if (lines.length > cap) console.log(`│ … (${lines.length - cap} more lines)`)
}
show('Read(offset: 1, limit: 5) of the forty-line file', seen.window, 8)
show('Edit of line 20, outside the window', seen.first)
if (seen.retry) show('the same Edit again, with no Read between (the refuse-then-retry road)', seen.retry)
show('Read of the wide file, over the token cap', seen.overCap, 6)
show('Edit of line 3 of the wide file, inside the carried window', seen.wideEdit)

const numbered = (n: number, text: string): RegExp => new RegExp(`(^|\\n)\\s*${n}(→|\\t)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`)
const numberedLines = (text: string): number[] => {
  const out: number[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)(?:→|\t)/.exec(line)
    if (m) out.push(Number(m[1]))
  }
  return out
}
const rawCarried = (text: string): string =>
  text
    .split('\n')
    .filter(line => /^\s*\d+(?:→|\t)/.test(line))
    .map(line => line.replace(/^\s*\d+(?:→|\t)/, ''))
    .join('\n')

tally.section('A. an Edit outside a partial Read lands in one call and its result carries the lines it lacked')
tally.check('A1 the windowed Read answered lines 1-5 and no more', seen.window !== undefined && !seen.window.isError && numbered(5, 'const v5 = 5').test(seen.window.text) && !numbered(6, 'const v6 = 6').test(seen.window.text), seen.window?.text.slice(0, 200))
tally.check('A2 the Edit of an unread line beside the window lands in the same call', seen.first !== undefined && !seen.first.isError && /has been updated successfully/.test(seen.first.text), seen.first?.text.slice(0, 200))
tally.check('A3 the result names the line that did not count as read and the lines it carries', seen.first !== undefined && /Line 20 did not count as read before this edit; lines 17-23 as they stand now are below, numbered with their anchor, and count as read:/.test(seen.first.text), seen.first?.text.slice(0, 300))
tally.check('A4 the result carries line 20 as it now stands, numbered the shape a Read returns', seen.first !== undefined && numbered(20, 'const v20 = 2000').test(seen.first.text), seen.first?.text.slice(0, 300))
tally.check('A5 the result carries a small margin around the gap and no more of the file', seen.first !== undefined && numbered(17, 'const v17 = 17').test(seen.first.text) && numbered(23, 'const v23 = 23').test(seen.first.text) && !numbered(16, 'const v16 = 16').test(seen.first.text) && !numbered(24, 'const v24 = 24').test(seen.first.text), seen.first === undefined ? '' : `numbered lines: ${numberedLines(seen.first.text).join(',')}`)
tally.check('A6 the carried block ends in a range anchor', seen.first !== undefined && /\(anchor: ra:[0-9a-f]{12}:L17\+7\)/.test(seen.first.text), seen.first?.text.slice(-120))
tally.check('A7 the result does not send the model to Read the gap', seen.first !== undefined && !/Read\(offset: 20, limit: 1\)/.test(seen.first.text), seen.first?.text.slice(0, 400))
tally.check('A8 no second call was needed: one result, not a refusal and a retry', seen.first !== undefined && seen.retry === undefined, seen.retry === undefined ? '' : `retry: ${seen.retry.text.slice(0, 120)}`)
tally.check('A9 the file on disk carries the change', readFileSync(small, 'utf8').includes('const v20 = 2000'))

tally.section('B. a Read over the token cap answers its first window')
tally.check('B1 the whole-file Read answers as a result, not an error, and says the file is over the cap', seen.overCap !== undefined && !seen.overCap.isError && /^File content \(\d+ tokens\) exceeds maximum allowed tokens \(\d+\):/.test(seen.overCap.text), seen.overCap?.text.slice(0, 200))
const carried = seen.overCap === undefined ? [] : numberedLines(seen.overCap.text)
const carriedRaw = seen.overCap === undefined ? '' : rawCarried(seen.overCap.text)
tally.check('B2 the result carries the first window, numbered from line 1', carried.length > 0 && carried[0] === 1 && seen.overCap !== undefined && numbered(1, "export const wide1 = '" + 'x'.repeat(100) + "' + '1'").test(seen.overCap.text), `numbered lines: ${carried.length}`)
tally.check('B3 the window is contiguous and bounded like a Read window', carried.length > 0 && carried.length <= READ_LINE_CAP && carried.every((n, i) => n === i + 1) && carriedRaw.length / CHARS_PER_TOKEN <= READ_TOKEN_CAP, `lines ${carried.length}, raw chars ${carriedRaw.length}`)
tally.check('B4 the words say the window counts as read and name the Read that continues it', seen.overCap !== undefined && carried.length > 0 && new RegExp(`lines 1-${carried.length} are below and count as read; Read\\(offset: ${carried.length + 1}, limit: ${carried.length}\\) continues from there`).test(seen.overCap.text), seen.overCap?.text.split('\n')[0])
tally.check('B5 an Edit inside the carried window lands with no Read between', seen.wideEdit !== undefined && !seen.wideEdit.isError && /has been updated successfully/.test(seen.wideEdit.text), seen.wideEdit?.text.slice(0, 300))
tally.check('B6 the file on disk carries the change', readFileSync(wide, 'utf8').includes("export const wideThree = '"))

tally.section('C. a same-path change does not merge old and current read knowledge')
show('the anchored Edit after the file changed and Grep showed another range', seen.knowledge)
const knowledge = seen.knowledge?.text ?? ''
tally.check('C1 the actual Read supplied the range anchor and the Edit was refused', knowledgeAnchor.startsWith('ra:') && seen.knowledge?.isError === true)
tally.check('C2 the refusal does not claim every refused line was read', !knowledge.includes('read this session: 1-10;') && knowledge.includes('read this session: 6-10'), knowledge.slice(0, 1200))
tally.check('C3 the words name the failed anchor and generation checks', knowledge.includes('Anchor check failed:') && knowledge.includes('File generation check failed:'), knowledge.slice(0, 1200))
tally.check('C4 the refused edit writes nothing', readFileSync(knowledgeFile, 'utf8') === knowledgeOriginal.replace('const k1 = 1', 'const k1 = 1000'))

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
