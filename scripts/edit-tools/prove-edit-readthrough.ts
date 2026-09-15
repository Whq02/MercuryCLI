#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const ASK = 'readthrough-probe'
const seen: Record<string, SeenResult> = {}
const smallEdit = { file_path: small, old_string: 'const v20 = 20', new_string: 'const v20 = 2000' }
const wideEdit = { file_path: wide, old_string: "export const wide3 = '", new_string: "export const wideThree = '" }

const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'Read', input: { file_path: small, offset: 1, limit: 5 } }]
    case 1:
      if (last) seen.window = last
      return [{ type: 'tool_use', name: 'Edit', input: smallEdit }]
    case 2:
      if (last) seen.refusal = last
      return [{ type: 'tool_use', name: 'Edit', input: smallEdit }]
    case 3:
      if (last) seen.retry = last
      return [{ type: 'tool_use', name: 'Read', input: { file_path: wide } }]
    case 4:
      if (last) seen.overCap = last
      return [{ type: 'tool_use', name: 'Edit', input: wideEdit }]
    default:
      if (req.step === 5 && last) seen.wideEdit = last
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
show('Edit of line 20, outside the window', seen.refusal)
show('the same Edit again, with no Read between', seen.retry)
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

tally.section('A. an Edit outside a partial Read carries the lines it lacked')
tally.check('A1 the windowed Read answered lines 1-5 and no more', seen.window !== undefined && !seen.window.isError && numbered(5, 'const v5 = 5').test(seen.window.text) && !numbered(6, 'const v6 = 6').test(seen.window.text), seen.window?.text.slice(0, 200))
tally.check('A2 the Edit of an unread line is still refused by the law', seen.refusal !== undefined && seen.refusal.isError && /Read the file before editing it/.test(seen.refusal.text), seen.refusal?.text.slice(0, 200))
tally.check('A3 the refusal names the lines read and the line the edit touches', seen.refusal !== undefined && /read this session: 1-5;/.test(seen.refusal.text) && /the edit touches line 20/.test(seen.refusal.text), seen.refusal?.text.slice(0, 300))
tally.check('A4 the refusal carries line 20 numbered, the shape a Read returns', seen.refusal !== undefined && numbered(20, 'const v20 = 20').test(seen.refusal.text), seen.refusal?.text.slice(0, 300))
tally.check('A5 the refusal carries a small margin around the gap and no more of the file', seen.refusal !== undefined && numbered(17, 'const v17 = 17').test(seen.refusal.text) && numbered(23, 'const v23 = 23').test(seen.refusal.text) && !numbered(16, 'const v16 = 16').test(seen.refusal.text) && !numbered(24, 'const v24 = 24').test(seen.refusal.text), seen.refusal === undefined ? '' : `numbered lines: ${numberedLines(seen.refusal.text).join(',')}`)
tally.check('A6 the refusal says the lines below count as read and to edit again', seen.refusal !== undefined && /lines 17-23 are below and count as read/.test(seen.refusal.text) && /edit again/.test(seen.refusal.text), seen.refusal?.text.slice(0, 400))
tally.check('A7 the refusal no longer sends the model to Read the gap', seen.refusal !== undefined && !/Read\(offset: 20, limit: 1\)/.test(seen.refusal.text), seen.refusal?.text.slice(0, 400))
tally.check('A8 the same Edit, repeated with no Read between, lands', seen.retry !== undefined && !seen.retry.isError && /has been updated successfully/.test(seen.retry.text), seen.retry?.text.slice(0, 300))
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

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
