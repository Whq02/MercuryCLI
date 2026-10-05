#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mixed-endings-edited-line-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS

const { preserveUntouchedLineEndings } = await import('../../src/utils/file.ts')
const { detectLineEndingsForString } = await import('../../src/utils/fileRead.ts')
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — mixed-endings edited-line proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

type Ctx = { readFileState: Map<string, unknown> }
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
function primeRead(ctx: Ctx, path: string): void {
  ctx.readFileState.set(path, {
    content: readFileSync(path, 'utf8').replaceAll('\r\n', '\n'),
    timestamp: Date.now() + 60_000,
    offset: undefined,
    limit: undefined,
  })
}
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: true } | { ok: false; error: string }> {
  const validation = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  if (validation.result === false) return { ok: false, error: String(validation.message) }
  try {
    await (FileEditTool as { call: Function }).call(input, ctx, null, { uuid: '00000000-0000-0000-0000-000000000014', message: { id: 'msg_fixture' } })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const asBytes = (text: string): string => Buffer.from(text, 'utf8').toString('latin1')
const show = (text: string): string => (text.length > 60 ? `...${JSON.stringify(text.slice(-40))}` : JSON.stringify(text))
let serial = 0
async function through(before: string, input: Record<string, unknown>): Promise<string> {
  const path = join(SCRATCH, `case-${++serial}.txt`)
  writeFileSync(path, before)
  const ctx = makeContext()
  primeRead(ctx, path)
  const anchor = Array.isArray(input.hunks) ? { expected_anchor: mintFileAnchor(before) } : {}
  const result = await edit({ file_path: path, ...input, ...anchor }, ctx)
  return result.ok ? readFileSync(path, 'latin1') : `REFUSED ${result.error}`
}
async function lands(label: string, before: string, input: Record<string, unknown>, after: string): Promise<void> {
  const got = await through(before, input)
  check(label, got === asBytes(after), `want ${show(asBytes(after))} got ${show(got)}`)
}
const preserve = (raw: string, updated: string): string =>
  preserveUntouchedLineEndings(raw, updated, detectLineEndingsForString(raw))
const unit = (label: string, raw: string, updated: string, want: string): void => {
  const got = preserve(raw, updated)
  check(label, got === want, `want ${show(want)} got ${show(got)}`)
}

const TIE = 'a1\r\nb2\nc3\r\nd4\n'
const CRLF_MAJORITY = 'k1\r\nk2\nk3\r\nk4\nk5\r\n'

section('A. the tool, exact string: a one-word edit keeps the ending of the line it changes')
await lands('A1 two CRLF and two LF lines: c3 -> C3 keeps its CRLF', TIE, { old_string: 'c3', new_string: 'C3' }, 'a1\r\nb2\nC3\r\nd4\n')
await lands('A2 two CRLF and two LF lines: the first line a1 -> A1 keeps its CRLF', TIE, { old_string: 'a1', new_string: 'A1' }, 'A1\r\nb2\nc3\r\nd4\n')
await lands('A3 two CRLF and two LF lines: b2 -> B2 keeps its LF', TIE, { old_string: 'b2', new_string: 'B2' }, 'a1\r\nB2\nc3\r\nd4\n')
await lands('A4 CRLF majority: k4 -> K4 keeps its LF', CRLF_MAJORITY, { old_string: 'k4', new_string: 'K4' }, 'k1\r\nk2\nk3\r\nK4\nk5\r\n')
await lands('A5 CRLF majority: k5 -> K5 keeps its CRLF', CRLF_MAJORITY, { old_string: 'k5', new_string: 'K5' }, 'k1\r\nk2\nk3\r\nk4\nK5\r\n')
await lands('A6 CRLF majority: k2 -> K2 keeps its LF', CRLF_MAJORITY, { old_string: 'k2', new_string: 'K2' }, 'k1\r\nK2\nk3\r\nk4\nk5\r\n')

section('B. the tool, anchored hunks and replace_all: the same rule')
await lands('B1 hunks, two CRLF and two LF lines: line 3 -> C3 keeps its CRLF', TIE, { hunks: [{ lines: '3', replace: 'C3' }] }, 'a1\r\nb2\nC3\r\nd4\n')
await lands('B2 hunks, CRLF majority: line 4 -> K4 keeps its LF', CRLF_MAJORITY, { hunks: [{ lines: '4', replace: 'K4' }] }, 'k1\r\nk2\nk3\r\nK4\nk5\r\n')
await lands(
  'B3 two hunks: the LF line between the edited CRLF lines is not restyled',
  'x1\r\nm\ny1\r\nn\r\n',
  { hunks: [{ lines: '1', replace: 'x9' }, { lines: '3', replace: 'y9' }] },
  'x9\r\nm\ny9\r\nn\r\n',
)
await lands(
  'B4 replace_all: the LF line between the replaced CRLF lines is not restyled',
  'x1\r\nm\ny1\r\nn\r\n',
  { old_string: '1', new_string: '9', replace_all: true },
  'x9\r\nm\ny9\r\nn\r\n',
)

section('C. the reconciliation unit')
unit('C1 a two-line block: each new line takes the ending of the line it replaces', 'p\r\nq\nr\r\ns\n', 'p\nQ\nR\ns\n', 'p\r\nQ\nR\r\ns\n')
{
  const shifted = preserve('p\r\nq\nr\nz\n', 'n\np\nq\nz\n')
  check(
    'C2 an insertion and a deletion that cancel out: the new line takes the majority, not the ending of a line that shifted',
    shifted.startsWith('n\n') && shifted.endsWith('q\nz\n'),
    JSON.stringify(shifted),
  )
}
unit('C3 lines added in a CRLF-majority file take the majority', CRLF_MAJORITY, 'k1\nk2\nk3\nK4a\nK4b\nk5\n', 'k1\r\nk2\nk3\r\nK4a\r\nK4b\r\nk5\r\n')
unit('C4 lines added in a two-and-two file take LF', TIE, 'a1\nb2\nC3a\nC3b\nd4\n', 'a1\r\nb2\nC3a\nC3b\nd4\n')
unit('C5 a removed line leaves every other line as it was', CRLF_MAJORITY, 'k1\nk3\nk4\nk5\n', 'k1\r\nk3\r\nk4\nk5\r\n')
unit('C6 a replaced line that had no terminator takes the majority', 'a\r\nb', 'a\nB\n', 'a\r\nB\r\n')
unit('C7 a last line without a terminator stays without one', 'a\r\nb\r\nc', 'a\nb\nC', 'a\r\nb\r\nC')
unit('C8 a no-op returns the raw spelling byte for byte', CRLF_MAJORITY, CRLF_MAJORITY.replaceAll('\r\n', '\n'), CRLF_MAJORITY)

section('D. files the tool already handled well, and line-count changes in a mixed file')
await lands('D1 CRLF file: y2 -> Y2', 'y1\r\ny2\r\ny3\r\n', { old_string: 'y2', new_string: 'Y2' }, 'y1\r\nY2\r\ny3\r\n')
await lands('D2 LF file: x2 -> X2', 'x1\nx2\nx3\n', { old_string: 'x2', new_string: 'X2' }, 'x1\nX2\nx3\n')
await lands('D3 CRLF file without a final newline: the last line n3 -> N3', 'n1\r\nn2\r\nn3', { old_string: 'n3', new_string: 'N3' }, 'n1\r\nn2\r\nN3')
await lands('D4 CRLF file without a final newline: n2 -> N2', 'n1\r\nn2\r\nn3', { old_string: 'n2', new_string: 'N2' }, 'n1\r\nN2\r\nn3')
await lands('D5 CRLF file with a byte order mark: b2 -> B2', '\uFEFFb1\r\nb2\r\n', { old_string: 'b2', new_string: 'B2' }, '\uFEFFb1\r\nB2\r\n')
await lands('D6 CRLF file: a block of two lines becomes three', 'r1\r\nr2\r\nr3\r\nr4\r\n', { old_string: 'r2\nr3', new_string: 'R2\nR3\nR3b' }, 'r1\r\nR2\r\nR3\r\nR3b\r\nr4\r\n')
await lands('D7 CRLF-majority mixed file: k4 becomes two lines, both take the majority', CRLF_MAJORITY, { old_string: 'k4', new_string: 'K4a\nK4b' }, 'k1\r\nk2\nk3\r\nK4a\r\nK4b\r\nk5\r\n')
await lands('D8 two-and-two mixed file: c3 becomes two lines, both take LF', TIE, { old_string: 'c3', new_string: 'C3a\nC3b' }, 'a1\r\nb2\nC3a\nC3b\nd4\n')
await lands('D9 CRLF-majority mixed file: removing k2 leaves k3, k4 and k5 as they were', CRLF_MAJORITY, { old_string: 'k2', new_string: '' }, 'k1\r\nk3\r\nk4\nk5\r\n')

section('E. a file with one ending: every edit shape comes out in that ending')
{
  const eol = { LF: '\n', CRLF: '\r\n' } as const
  const spell = (lines: string[], finalNewline: boolean, ending: 'LF' | 'CRLF'): string =>
    lines.map((line, index) => line + (index < lines.length - 1 || finalNewline ? eol[ending] : '')).join('')
  let cases = 0
  const wrong: string[] = []
  for (const ending of ['LF', 'CRLF'] as const) {
    for (let count = 1; count <= 4; count++) {
      const lines = Array.from({ length: count }, (_, index) => `l${index}`)
      for (const finalNewline of [true, false]) {
        const edits: string[][] = []
        for (let at = 0; at < count; at++) {
          edits.push(lines.map((line, index) => (index === at ? `${line}!` : line)))
          if (count > 1) edits.push(lines.filter((_, index) => index !== at))
          edits.push([...lines.slice(0, at), 'ins', ...lines.slice(at)])
          edits.push([...lines.slice(0, at), 'ins1', 'ins2', ...lines.slice(at + 1)])
          if (at + 1 < count) edits.push([...lines.slice(0, at), 'merged', ...lines.slice(at + 2)])
          for (let later = at + 1; later < count; later++) {
            edits.push(lines.map((line, index) => (index === at || index === later ? `${line}!` : line)))
          }
        }
        edits.push([...lines, 'tail'])
        for (const edited of edits) {
          for (const editedFinal of [finalNewline, !finalNewline]) {
            cases++
            const raw = spell(lines, finalNewline, ending)
            const updated = spell(edited, editedFinal, 'LF')
            const want = spell(edited, editedFinal, ending)
            const got = preserveUntouchedLineEndings(raw, updated, ending)
            if (got !== want && wrong.length < 3) wrong.push(`${ending} ${JSON.stringify(raw)} -> ${JSON.stringify(got)}`)
          }
        }
      }
    }
  }
  check(`E1 ${cases} edit shapes on LF and CRLF files: the result is the edited text in the file's own ending`, wrong.length === 0, wrong.join(' | '))
}

section('F. a CRLF file whose first line is longer than the ending sniff window')
{
  const long = 'x'.repeat(5000)
  await lands('F1 the file reads as LF to the sniff, yet l3 -> L3 keeps its CRLF', `${long}\r\nl2\r\nl3\r\n`, { old_string: 'l3', new_string: 'L3' }, `${long}\r\nl2\r\nL3\r\n`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
