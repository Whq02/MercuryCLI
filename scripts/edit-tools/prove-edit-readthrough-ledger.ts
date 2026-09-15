#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-readthrough-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.NODE_ENV

const { fileGeneration, seenLinesOf, _resetSeenLinesForTesting } = await import('../../src/services/changeTransaction/seenLines.ts')
const { checkAnchor, mintRangeAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { READ_THROUGH_MARGIN, planReadThrough } = await import('../../src/tools/FileEditTool/readThrough.ts')
const { FileReadTool, MaxFileReadTokenExceededError } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { DEFAULT_MAX_OUTPUT_TOKENS } = await import('../../src/tools/FileReadTool/limits.ts')
const { MAX_LINES_TO_READ } = await import('../../src/tools/FileReadTool/prompt.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — read-through ledger proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'edit-readthrough-fixture-'))
type Ctx = { readFileState: Map<string, { content: string; timestamp: number; offset?: number; limit?: number; isPartialView?: boolean }> }
function makeContext(): Ctx {
  return {
    readFileState: new Map<string, unknown>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never as Ctx
}
function primeRead(ctx: Ctx, path: string, window: { offset: number; limit: number }): void {
  const full = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  const content = full.split('\n').slice(window.offset - 1, window.offset - 1 + window.limit).join('\n')
  ctx.readFileState.set(path, { content, timestamp: Date.now() + 60_000, offset: window.offset, limit: window.limit })
}
type Verdict = { ok: true } | { ok: false; message: string }
async function validate(input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> {
  const verdict = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  return verdict.result === false ? { ok: false, message: String(verdict.message) } : { ok: true }
}
const PARENT = { uuid: '00000000-0000-0000-0000-000000000003', message: { id: 'msg_fixture' } }
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> {
  const verdict = await validate(input, ctx)
  if (!verdict.ok) return verdict
  try {
    await (FileEditTool as { call: Function }).call(input, ctx, null, PARENT)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
async function readViaTool(input: Record<string, unknown>, ctx: Ctx, own: boolean): Promise<{ data?: unknown; error?: unknown }> {
  try {
    const result = own
      ? await (FileReadTool as { call: Function }).call(input, ctx, null, PARENT)
      : await (FileReadTool as { call: Function }).call(input, ctx)
    return { data: result.data }
  } catch (err) {
    return { error: err }
  }
}
const lines = (n: number, width = 0): string => Array.from({ length: n }, (_, i) => (width > 0 ? `const w${i + 1} = '${'y'.repeat(width)}'` : `const v${i + 1} = ${i + 1}`)).join('\n') + '\n'
const messageOf = (v: Verdict): string => (v.ok ? '(edited)' : v.message)
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
const anchorsIn = (text: string): string[] => [...text.matchAll(/\(anchor: (ra:[0-9a-f]{12}:L\d+\+\d+)\)/g)].map(m => m[1]!)
const LAW = 'Read the file before editing it'
const owner = processMainOwner()
const contentOf = (p: string): string => readFileSync(p, 'utf8').replaceAll('\r\n', '\n')

section('C. the refusal carries the unread lines, records them, and the same edit then lands')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'forty.ts')
  writeFileSync(file, lines(40))
  const ctx = makeContext()
  primeRead(ctx, file, { offset: 1, limit: 5 })
  const input = { file_path: file, old_string: 'const v20 = 20', new_string: 'const v20 = 2000' }
  const refused = await validate(input, ctx)
  check('C1 the edit of an unread line is refused by the law', !refused.ok && refused.message.includes(LAW), messageOf(refused))
  const text = refused.ok ? '' : refused.message
  check('C2 the words name the read window, the touched line and the lines below', text.includes(`Lines of ${file} read this session: 1-5; the edit touches line 20 — lines 17-23 are below and count as read: edit again without a Read.`), text.slice(0, 400))
  check('C3 the carried block is the gap widened by the margin, numbered as a Read numbers', JSON.stringify(numberedLines(text)) === JSON.stringify([17, 18, 19, 20, 21, 22, 23]) && READ_THROUGH_MARGIN === 3 && /\n20\tconst v20 = 20\n/.test(text), `numbered: ${numberedLines(text).join(',')}`)
  const anchors = anchorsIn(text)
  check('C4 the block carries a range anchor that verifies against the current content', anchors.length === 1 && anchors[0] === mintRangeAnchor(rawCarried(text), 17, 7) && checkAnchor(anchors[0]!, contentOf(file), file).ok, anchors.join(' '))
  const ledger = seenLinesOf(owner, file)
  check('C5 the ledger records the carried lines for the current generation', ledger !== undefined && ledger.generation === fileGeneration(file) && ledger.ranges.some(r => r.start <= 17 && r.end >= 23), JSON.stringify(ledger))
  const entry = ctx.readFileState.get(file)
  check('C6 the read entry of the windowed Read is untouched by the carry', entry !== undefined && entry.offset === 1 && entry.limit === 5, JSON.stringify({ offset: entry?.offset, limit: entry?.limit }))
  const landed = await edit(input, ctx)
  check('C7 the same edit, with no Read between, lands', landed.ok && contentOf(file).includes('const v20 = 2000'), messageOf(landed))
}

section('H. a hunks edit outside its range anchor retries with the carried anchor')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'hunks.ts')
  writeFileSync(file, lines(40))
  const ctx = makeContext()
  primeRead(ctx, file, { offset: 1, limit: 5 })
  const windowAnchor = mintRangeAnchor(contentOf(file).split('\n').slice(0, 5).join('\n'), 1, 5)
  const refused = await validate({ file_path: file, expected_anchor: windowAnchor, hunks: [{ lines: '30', replace: 'const v30 = 3000' }] }, ctx)
  const text = refused.ok ? '' : refused.message
  check('H1 the hunks edit of an unread line is refused with the carry', !refused.ok && text.includes(LAW) && text.includes('the edit touches line 30 — lines 27-33 are below and count as read: edit again without a Read.'), text.slice(0, 400))
  const carriedAnchor = anchorsIn(text)[0]
  const retried = await edit({ file_path: file, expected_anchor: carriedAnchor ?? windowAnchor, hunks: [{ lines: '30', replace: 'const v30 = 3000' }] }, ctx)
  check('H2 the retry with the carried anchor lands', retried.ok && contentOf(file).includes('const v30 = 3000'), messageOf(retried))
}

section('B. the carry is bounded like a Read window and never carries the whole of a large file')
{
  _resetSeenLinesForTesting()
  const tall = join(fixtures, 'tall.ts')
  writeFileSync(tall, lines(5000))
  const span = contentOf(tall).split('\n').slice(0, 2500).join('\n')
  const refused = await validate({ file_path: tall, old_string: span, new_string: 'x' }, makeContext())
  const text = refused.ok ? '' : refused.message
  const carried = numberedLines(text)
  check('B1 a gap taller than the line budget carries the budget and no more', carried.length === MAX_LINES_TO_READ && carried[0] === 1 && carried[carried.length - 1] === MAX_LINES_TO_READ, `carried ${carried.length}`)
  check('B2 …and the words name the Read that covers the rest of the gap', text.includes(`lines 1-${MAX_LINES_TO_READ} are below and count as read; Read(offset: ${MAX_LINES_TO_READ + 1}, limit: 500) covers the rest, then edit again.`), text.slice(0, 200))
  const ledger = seenLinesOf(owner, tall)
  check('B3 the ledger records only what was carried', ledger !== undefined && ledger.ranges.every(r => r.end <= MAX_LINES_TO_READ), JSON.stringify(ledger))

  const fat = join(fixtures, 'fat.ts')
  writeFileSync(fat, lines(300, 1000))
  const fatSpan = contentOf(fat).split('\n').slice(0, 150).join('\n')
  const fatRefused = await validate({ file_path: fat, old_string: fatSpan, new_string: 'x' }, makeContext())
  const fatText = fatRefused.ok ? '' : fatRefused.message
  const fatCarried = numberedLines(fatText)
  const fatRaw = rawCarried(fatText)
  const nextLine = contentOf(fat).split('\n')[fatCarried.length] ?? ''
  check('B4 a gap heavier than the token cap carries up to the cap and no more', fatCarried.length > 0 && fatCarried.length < 150 && Math.round(fatRaw.length / 4) <= DEFAULT_MAX_OUTPUT_TOKENS && Math.round((fatRaw.length + 1 + nextLine.length) / 4) > DEFAULT_MAX_OUTPUT_TOKENS, `carried ${fatCarried.length}, raw ${fatRaw.length}`)
  check('B5 …naming the Read that covers the rest', fatText.includes(`Read(offset: ${fatCarried.length + 1}, limit: ${150 - fatCarried.length}) covers the rest, then edit again.`), fatText.slice(0, 200))

  const one = await validate({ file_path: tall, old_string: 'const v4000 = 4000', new_string: 'x' }, makeContext())
  const oneText = one.ok ? '' : one.message
  check('B6 a one-line edit in a tall file carries seven lines, never the file', JSON.stringify(numberedLines(oneText)) === JSON.stringify([3997, 3998, 3999, 4000, 4001, 4002, 4003]), `numbered ${numberedLines(oneText).length}`)
  const plan = planReadThrough(contentOf(tall), [{ start: 1, end: 5000 }], tall)
  check('B7 the planner itself never exceeds the Read window', plan.lineCount === MAX_LINES_TO_READ && plan.cut && plan.windows.length === 1 && plan.windows[0]!.end === MAX_LINES_TO_READ)
}

section('G. a file that changed on disk after the carry refuses again')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'moving.ts')
  writeFileSync(file, lines(30))
  const input = { file_path: file, old_string: 'const v20 = 20', new_string: 'const v20 = 2000' }
  const first = await validate(input, makeContext())
  check('G1 the first edit is refused with the carry', !first.ok && first.message.includes('lines 17-23 are below and count as read'), messageOf(first))
  writeFileSync(file, lines(30) + 'const v31 = 31\n')
  const later = new Date(Date.now() + 120_000)
  utimesSync(file, later, later)
  const again = await validate(input, makeContext())
  check('G2 after the file changed, the same edit is refused again, not admitted on the old carry', !again.ok && again.message.includes(LAW) && again.message.includes('were of the file before it last changed'), messageOf(again))
  check('G3 …and carries the lines of the new state', !again.ok && again.message.includes('lines 17-23 are below and count as read'), messageOf(again))
  const landed = await edit(input, makeContext())
  check('G4 the retry after the fresh carry lands', landed.ok && contentOf(file).includes('const v20 = 2000'), messageOf(landed))
}

section('P. the probes that re-check knowledge after admission never carry')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'pure.ts')
  writeFileSync(file, lines(10))
  const ctx = makeContext()
  primeRead(ctx, file, { offset: 2, limit: 3 })
  const landed = await edit({ file_path: file, old_string: 'const v3 = 3', new_string: 'const v3 = 33' }, ctx)
  check('P1 an edit inside the read window lands', landed.ok && contentOf(file).includes('const v3 = 33'), messageOf(landed))
  check('P2 …and the ledger is untouched by the admission probes', seenLinesOf(owner, file) === undefined, JSON.stringify(seenLinesOf(owner, file)))
  const ctxUnknown = makeContext()
  primeRead(ctxUnknown, file, { offset: 2, limit: 3 })
  const unknown = await validate({ file_path: file, old_string: 'const nowhere = 0', new_string: 'x' }, ctxUnknown)
  check('P3 an old_string absent from the file carries nothing', !unknown.ok && unknown.message.includes('so the lines the edit touches are unknown') && numberedLines(unknown.message).length === 0, messageOf(unknown))
}

section('R. a Read over the token cap answers its first window and records it')
{
  _resetSeenLinesForTesting()
  const wide = join(fixtures, 'wide.ts')
  writeFileSync(wide, Array.from({ length: 1500 }, (_, i) => `export const wide${i + 1} = '${'x'.repeat(100)}' + '${i + 1}'`).join('\n') + '\n')
  const ctx = makeContext()
  const read = await readViaTool({ file_path: wide }, ctx, true)
  const data = read.data as { type?: string; file?: { content?: string; numLines?: number; startLine?: number; overCap?: { tokens: number; maxTokens: number } } } | undefined
  check('R1 the whole-file Read answers a text result carrying the over-cap note, not an error', read.error === undefined && data?.type === 'text' && data.file?.overCap !== undefined && data.file.overCap.tokens > data.file.overCap.maxTokens, String(read.error ?? JSON.stringify(data).slice(0, 200)))
  const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(read.data, 'toolu_wide')
  const text = typeof block.content === 'string' ? block.content : ''
  const carried = numberedLines(text)
  check('R2 the result carries the first window from line 1, contiguous', carried.length > 0 && carried[0] === 1 && carried.every((n, i) => n === i + 1) && data?.file?.startLine === 1 && data.file.numLines === carried.length, `carried ${carried.length}`)
  const wideLines = contentOf(wide).split('\n')
  const raw = rawCarried(text)
  check('R3 the window is the cap\'s worth: within the line and token caps, and the next line would not fit', carried.length <= MAX_LINES_TO_READ && Math.round(raw.length / 4) <= DEFAULT_MAX_OUTPUT_TOKENS && Math.round((raw.length + 1 + (wideLines[carried.length] ?? '').length) / 4) > DEFAULT_MAX_OUTPUT_TOKENS, `lines ${carried.length}, raw ${raw.length}`)
  check('R4 the words name the size, the lines returned and the Read that continues', /^File content \(\d+ tokens\) exceeds maximum allowed tokens \(\d+\): /.test(text) && text.includes(`lines 1-${carried.length} are below and count as read; Read(offset: ${carried.length + 1}, limit: ${carried.length}) continues from there`), text.split('\n')[0])
  const entry = ctx.readFileState.get(wide)
  check('R5 the read state holds the window as a windowed read', entry !== undefined && entry.offset === 1 && entry.limit === carried.length && entry.content === rawCarried(text), JSON.stringify({ offset: entry?.offset, limit: entry?.limit }))
  const ledger = seenLinesOf(owner, wide)
  check('R6 the ledger records the window for the current generation', ledger !== undefined && ledger.generation === fileGeneration(wide) && ledger.ranges.some(r => r.start === 1 && r.end === carried.length), JSON.stringify(ledger))
  const anchors = anchorsIn(text)
  check('R7 the window carries a range anchor that verifies', anchors.length === 1 && checkAnchor(anchors[0]!, contentOf(wide), wide).ok, anchors.join(' '))
  const again = await readViaTool({ file_path: wide, offset: 1, limit: carried.length }, ctx, true)
  check('R8 a Read of exactly the carried window answers the unchanged stub', (again.data as { type?: string } | undefined)?.type === 'file_unchanged', JSON.stringify(again.data ?? String(again.error)).slice(0, 120))
  const outsideLine = carried.length + 10
  const outside = await validate({ file_path: wide, old_string: `export const wide${outsideLine} = '`, new_string: 'x' }, ctx)
  check('R9 an edit past the window is refused, naming the window as read', !outside.ok && outside.message.includes(`read this session: 1-${carried.length};`) && outside.message.includes(`the edit touches line ${outsideLine}`), messageOf(outside))
  const inside = await edit({ file_path: wide, old_string: "export const wide3 = '", new_string: "export const wideThree = '" }, ctx)
  check('R10 an edit inside the window lands with no Read between', inside.ok && contentOf(wide).includes("export const wideThree = '"), messageOf(inside))
}

section('A. an automatic attachment read that overflows records nothing')
{
  _resetSeenLinesForTesting()
  const wide = join(fixtures, 'attached.ts')
  writeFileSync(wide, Array.from({ length: 1500 }, (_, i) => `export const wide${i + 1} = '${'x'.repeat(100)}' + '${i + 1}'`).join('\n') + '\n')
  const ctx = makeContext()
  const read = await readViaTool({ file_path: wide }, ctx, false)
  const err = read.error
  check('A1 the bare read is refused by the same class', err instanceof MaxFileReadTokenExceededError, String(err))
  const text = err instanceof Error ? err.message : ''
  check('A2 …with the bare words and no window', numberedLines(text).length === 0 && text.endsWith('instead of reading the whole file.'), text.slice(0, 200))
  check('A3 …and nothing is recorded as read', ctx.readFileState.get(wide) === undefined && seenLinesOf(owner, wide) === undefined)
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
