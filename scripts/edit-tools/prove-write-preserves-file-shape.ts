#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'file-shape-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'file-shape-cs-'))

const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { _resetSeenLinesForTesting } = await import('../../src/services/changeTransaction/seenLines.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const budgetMs = vshotBudgetMs(120_000)
const guard = setTimeout(() => {
  console.log(`\nTIMEOUT — file shape proof exceeded ${budgetMs / 1000}s`)
  process.exit(1)
}, budgetMs)
guard.unref?.()

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'file-shape-repo-')))
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
git('init', '-q')
git('config', 'user.email', 'proof@example.invalid')
git('config', 'user.name', 'proof')
git('config', 'core.autocrlf', 'false')

const BOM = '\uFEFF'
type Kind = {
  id: string
  file: string
  bytes: string
  oldWord: string
  newWord: string
  line: number
}
const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} of the big file`).join('\n') + '\n'
const KINDS: Kind[] = [
  { id: 'crlf', file: 'crlf.txt', bytes: 'alpha\r\nbeta\r\ngamma\r\ndelta\r\nepsilon\r\n', oldWord: 'beta', newWord: 'BETA', line: 2 },
  { id: 'nonl', file: 'nonl.txt', bytes: 'first line\nsecond line\nlast line without newline', oldWord: 'second line', newWord: 'SECOND LINE', line: 2 },
  { id: 'empty', file: 'empty.txt', bytes: '', oldWord: '', newWord: 'now not empty', line: 1 },
  { id: 'unicode', file: 'unicode.txt', bytes: 'café ünïcode\nemoji: 🛸 🎉 👩‍💻 🇬🇧\nnaïve résumé — “quoted”\n', oldWord: 'naïve', newWord: 'NAÏVE', line: 3 },
  { id: 'tabs', file: 'tabs.txt', bytes: '\tindented with a tab\n\t\tdouble tab\nplain line\n\tlast tab\n', oldWord: 'double tab', newWord: 'DOUBLE TAB', line: 2 },
  { id: 'big', file: 'big.txt', bytes: big, oldWord: 'line 1500 of the big file', newWord: 'LINE 1500 of the big file', line: 1500 },
  { id: 'bom', file: 'bom.txt', bytes: `${BOM}hello bom\nworld line\nthird\n`, oldWord: 'world line', newWord: 'WORLD LINE', line: 2 },
  { id: 'mixed', file: 'mixed.txt', bytes: 'mixed one\r\nmixed two\nmixed three\r\nmixed four\nmixed five\r\n', oldWord: 'mixed three', newWord: 'MIXED THREE', line: 3 },
]
for (const kind of KINDS) writeFileSync(join(repo, kind.file), kind.bytes)
git('add', '--', ...KINDS.map(k => k.file))
git('commit', '-q', '-m', 'the eight kinds')

const owner = processMainOwner()
function makeContext() {
  const empty = getEmptyToolPermissionContext()
  const permCtx = { ...empty, additionalWorkingDirectories: new Map([[repo, { source: 'session' }]]) }
  return {
    owner,
    readFileState: new Map<string, unknown>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: permCtx }),
    options: { tools: [], mcpClients: [], isNonInteractiveSession: true },
  } as never as { readFileState: Map<string, unknown> }
}
type Ctx = ReturnType<typeof makeContext>
const PARENT = { uuid: '00000000-0000-0000-0000-00000000f00d', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string } | { ok: false; message: string }
async function run(tool: unknown, input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> {
  const t = tool as { validateInput?: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  if (t.validateInput) {
    const verdict = await t.validateInput(input, ctx)
    if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  }
  try {
    const out = await t.call(input, ctx, null, PARENT)
    const block = t.mapToolResultToToolResultBlockParam(out.data, 'toolu_shape')
    return { ok: true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const textOf = (v: Verdict): string => (v.ok ? v.text : v.message)
const anchorOf = (text: string): string => /\(anchor: ([^)]+)\)/.exec(text)?.[1] ?? ''

type Shape = { crlf: number; lf: number; endsWithNewline: boolean; bom: boolean; perLine: string[] }
function shapeOf(bytes: string): Shape {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes.charCodeAt(i) === 10) {
      if (i > 0 && bytes.charCodeAt(i - 1) === 13) crlf++
      else lf++
    }
  }
  const perLine = bytes.split(/(?<=\n)/).map(line => (line.endsWith('\r\n') ? 'CRLF' : line.endsWith('\n') ? 'LF' : 'none'))
  return { crlf, lf, endsWithNewline: bytes.endsWith('\n'), bom: bytes.charCodeAt(0) === 0xfeff, perLine }
}
function numstat(file: string): { added: number; removed: number } {
  const out = git('diff', '--numstat', '--', file)
  if (out === '') return { added: 0, removed: 0 }
  const [added, removed] = out.split('\t')
  return { added: Number(added), removed: Number(removed) }
}
const restore = (file: string): void => {
  git('checkout', '--', file)
  _resetSeenLinesForTesting()
}
const disk = (file: string): string => readFileSync(join(repo, file), 'utf8')
const normalized = (bytes: string): string => bytes.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')

function sameShapeWhereUntouched(before: string, after: string, label: string, touchedLines: number[]): void {
  const a = shapeOf(before)
  const b = shapeOf(after)
  check(`${label}: the trailing-newline state is kept (${a.endsWithNewline ? 'ends with a newline' : 'no newline at the end'})`, a.endsWithNewline === b.endsWithNewline, `before ${a.endsWithNewline} after ${b.endsWithNewline}`)
  check(`${label}: the byte-order mark is kept (${a.bom ? 'present' : 'absent'})`, a.bom === b.bom, `before ${a.bom} after ${b.bom}`)
  const untouched = a.perLine.map((ending, i) => ({ ending, line: i + 1 })).filter(row => !touchedLines.includes(row.line) && row.ending !== 'none')
  const kept = untouched.every(row => b.perLine[row.line - 1] === row.ending)
  check(`${label}: every untouched line keeps its own terminator (${a.crlf} CRLF, ${a.lf} LF before)`, kept, `before ${a.perLine.join(',')} after ${b.perLine.join(',')}`)
}

for (const kind of KINDS) {
  section(`${kind.id} — ${kind.file} (${kind.bytes.length} characters, ${shapeOf(kind.bytes).crlf} CRLF, ${shapeOf(kind.bytes).lf} LF${shapeOf(kind.bytes).bom ? ', BOM' : ''}${kind.bytes.endsWith('\n') || kind.bytes === '' ? '' : ', no trailing newline'})`)
  const path = join(repo, kind.file)
  const hasWord = kind.oldWord !== ''

  {
    restore(kind.file)
    const ctx = makeContext()
    const read = await run(FileReadTool, { file_path: path }, ctx)
    const body = hasWord ? normalized(kind.bytes).replace(kind.oldWord, kind.newWord) : `${kind.newWord}\n`
    const modelContent = body === '' || body.endsWith('\n') ? body : `${body}\n`
    const wrote = await run(FileWriteTool, { file_path: path, content: modelContent }, ctx)
    const after = disk(kind.file)
    check(`Write: the read landed and the write landed`, read.ok && wrote.ok, `${textOf(read).slice(0, 120)} | ${textOf(wrote).slice(0, 200)}`)
    check(`Write: the word changed`, after.includes(kind.newWord) && (!hasWord || !after.includes(kind.oldWord)), after.slice(0, 120))
    const stat = numstat(kind.file)
    if (hasWord) {
      check(`Write: git diff --numstat shows the one line and no other (RED on the base for CRLF, mixed and no-trailing-newline files)`, stat.added === 1 && stat.removed === 1, `+${stat.added} -${stat.removed}`)
      sameShapeWhereUntouched(kind.bytes, after, 'Write', [kind.line])
    } else {
      check(`Write: an empty file takes the content as given`, after === modelContent && stat.added === 1 && stat.removed === 0, `+${stat.added} -${stat.removed}: ${JSON.stringify(after)}`)
    }
  }

  if (hasWord) {
    restore(kind.file)
    const ctx = makeContext()
    await run(FileReadTool, { file_path: path }, ctx)
    const edited = await run(FileEditTool, { file_path: path, old_string: kind.oldWord, new_string: kind.newWord }, ctx)
    const after = disk(kind.file)
    const stat = numstat(kind.file)
    check(`Edit: the one-word edit landed`, edited.ok && after.includes(kind.newWord), textOf(edited).slice(0, 200))
    check(`Edit: git diff --numstat shows the one line and no other`, stat.added === 1 && stat.removed === 1, `+${stat.added} -${stat.removed}`)
    sameShapeWhereUntouched(kind.bytes, after, 'Edit', [kind.line])
  }

  {
    restore(kind.file)
    const ctx = makeContext()
    const appended = await run(FileEditTool, { file_path: path, append: 'appended line' }, ctx)
    const after = disk(kind.file)
    const stat = numstat(kind.file)
    const before = shapeOf(kind.bytes)
    check(`Edit append: the append landed`, appended.ok && after.includes('appended line'), textOf(appended).slice(0, 200))
    if (kind.bytes === '') {
      check(`Edit append: an empty file gains its first line, newline-terminated`, after === 'appended line\n' && stat.added === 1 && stat.removed === 0, JSON.stringify(after))
    } else if (!before.endsWithNewline) {
      check(`Edit append: a file with no trailing newline keeps none — the appended line ends the file without one (RED on the base: the file gained a trailing newline)`, after === `${kind.bytes}\nappended line`, JSON.stringify(after.slice(-40)))
      check(`Edit append: git counts the old last line (it gained a terminator) and the new line, nothing else`, stat.added === 2 && stat.removed === 1, `+${stat.added} -${stat.removed}`)
    } else {
      check(`Edit append: git diff --numstat shows the one added line and nothing else`, stat.added === 1 && stat.removed === 0, `+${stat.added} -${stat.removed}`)
      const lastLineEnding = before.perLine.filter(e => e !== 'none').at(-1)
      const majority = before.crlf > before.lf ? 'CRLF' : 'LF'
      check(`Edit append: the appended line takes the file's majority terminator (${majority}) and the file still ends with a newline`, after.endsWith(majority === 'CRLF' ? 'appended line\r\n' : 'appended line\n'), `last ${lastLineEnding}; tail ${JSON.stringify(after.slice(-20))}`)
      sameShapeWhereUntouched(kind.bytes, after, 'Edit append', [])
    }
  }

  if (hasWord) {
    restore(kind.file)
    const ctx = makeContext()
    const read = await run(FileReadTool, { file_path: path }, ctx)
    const anchor = anchorOf(textOf(read))
    const lineText = normalized(kind.bytes).split('\n')[kind.line - 1] ?? ''
    const applied = await run(
      ChangeSetTool,
      { op: 'apply', changes: [{ file_path: path, expected_anchor: anchor, hunks: [{ lines: String(kind.line), replace: lineText.replace(kind.oldWord, kind.newWord) }] }] },
      ctx,
    )
    const after = disk(kind.file)
    const stat = numstat(kind.file)
    check(`ChangeSet: the one-hunk set landed`, applied.ok && after.includes(kind.newWord), textOf(applied).slice(0, 300))
    check(`ChangeSet: git diff --numstat shows the one line and no other (RED on the base for the mixed file)`, stat.added === 1 && stat.removed === 1, `+${stat.added} -${stat.removed}`)
    sameShapeWhereUntouched(kind.bytes, after, 'ChangeSet', [kind.line])
  }
}

section('the first line of a file with a byte-order mark: the mark survives a hunk, an edit and a write that change that line')
{
  const kind = KINDS.find(k => k.id === 'bom')!
  const path = join(repo, kind.file)
  restore(kind.file)
  const ctx = makeContext()
  const read = await run(FileReadTool, { file_path: path }, ctx)
  const applied = await run(ChangeSetTool, { op: 'apply', changes: [{ file_path: path, expected_anchor: anchorOf(textOf(read)), hunks: [{ lines: '1', replace: 'HELLO BOM' }] }] }, ctx)
  check('ChangeSet: a hunk on line 1 lands and the mark is kept (RED on the base: the mark was glued to line 1 and went with it)', applied.ok && disk(kind.file) === `${BOM}HELLO BOM\nworld line\nthird\n`, `${textOf(applied).slice(0, 200)} | ${JSON.stringify(disk(kind.file).slice(0, 12))}`)
  check('ChangeSet: git counts the one line', numstat(kind.file).added === 1 && numstat(kind.file).removed === 1, JSON.stringify(numstat(kind.file)))
  restore(kind.file)
  const ctx2 = makeContext()
  await run(FileReadTool, { file_path: path }, ctx2)
  const edited = await run(FileEditTool, { file_path: path, old_string: 'hello bom', new_string: 'HELLO BOM' }, ctx2)
  check('Edit: a change on line 1 keeps the mark', edited.ok && disk(kind.file) === `${BOM}HELLO BOM\nworld line\nthird\n`, textOf(edited).slice(0, 200))
  restore(kind.file)
  const ctx3 = makeContext()
  await run(FileReadTool, { file_path: path }, ctx3)
  const wrote = await run(FileWriteTool, { file_path: path, content: 'HELLO BOM\nworld line\nthird\n' }, ctx3)
  check('Write: the whole file again with line 1 changed keeps the mark', wrote.ok && disk(kind.file) === `${BOM}HELLO BOM\nworld line\nthird\n`, textOf(wrote).slice(0, 200))
  check('Write: git counts the one line', numstat(kind.file).added === 1 && numstat(kind.file).removed === 1, JSON.stringify(numstat(kind.file)))
}

section('the whole-file Write of the same text over a CRLF file changes nothing: the endings are the file\'s')
{
  const kind = KINDS[0]!
  restore(kind.file)
  const ctx = makeContext()
  await run(FileReadTool, { file_path: join(repo, kind.file) }, ctx)
  const same = await run(FileWriteTool, { file_path: join(repo, kind.file), content: normalized(kind.bytes) }, ctx)
  check('the LF spelling of the same lines settles as no change and the file keeps every CRLF (RED on the base: a 5-line rewrite to LF)', same.ok && /No changes were made/.test(textOf(same)) && disk(kind.file) === kind.bytes, textOf(same).slice(0, 200))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
