#!/usr/bin/env bun
import { existsSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'clipped-read-'))
const realHome = realpathSync(home)
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
process.env.MERCURY_CHANGESET_DIR = join(home, 'changesets')
process.env.MERCURY_BARE = '1'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.ANTHROPIC_API_KEY = 'fixture-token-count-key'
delete process.env.MERCURY_HOME
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { FileReadTool: Read } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileEditTool: Edit } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { GrepTool: Grep } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { toolErrorReason } = await import('../../src/utils/toolErrorReason.ts')
const parent = { uuid: '00000000-0000-0000-0000-000000000003', message: { id: 'fixture' } } as any
function context(): any { return { readFileState: new Map(), abortController: new AbortController(), options: { tools: [], commands: [], engineModel: 'fixture-model' }, getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }), dynamicSkillDirTriggers: new Set(), nestedMemoryAttachmentTriggers: new Set(), updateFileHistoryState() {} } }
let failures = 0
function check(label: string, ok: boolean, detail?: unknown) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok ? ` ${JSON.stringify(detail)}` : ''}`); if (!ok) failures++ }
const line = 'prefix_' + 'x'.repeat(2986) + '_suffix'
async function read(input: any, ctx: any) { const result = await Read.call(input, ctx, null as any, parent); return { data: result.data, text: String(Read.mapToolResultToToolResultBlockParam(result.data, 'r').content) } }
try {
  for (const mode of ['ordinary', 'ranges', 'grep']) {
    const file = join(home, `${mode}.txt`); writeFileSync(file, line + '\nshort\n')
    const ctx = context()
    let anchor: string | undefined
    if (mode === 'grep') await Grep.call({ pattern: 'prefix_', path: file, output_mode: 'content' }, ctx)
    else {
      const r = await read({ file_path: file, ...(mode === 'ranges' ? { ranges: ['1', '2'] } : {}), line_anchors: true }, ctx)
      check(`${mode}: long line is clipped`, !r.text.includes('_suffix') && r.text.includes('truncated'))
      anchor = (r.data as any).file?.anchor
    }
    const input = { file_path: file, old_string: line, new_string: 'replacement', ...(anchor ? { expected_anchor: anchor } : {}) }
    const refused = await Edit.validateInput(input, ctx)
    const exact = `Read(file_path: ${JSON.stringify(file)}, offset: 1, limit: 1, lossless: true)`
    check(`${mode}: whole-line replacement refuses with the exact lossless read`, refused.result === false && String((refused as any).message).includes(exact), refused)
    if (mode === 'ordinary' && process.env.PROOF_RESULT_DIR) writeFileSync(join(process.env.PROOF_RESULT_DIR, 'clipped-read.json'), JSON.stringify({ error: (refused as any).message }))
    if (mode !== 'grep') {
      const prefix = { file_path: file, old_string: 'prefix_', new_string: 'PREFIX_' }
      check(`${mode}: observed substring remains editable`, (await Edit.validateInput(prefix, ctx)).result === true)
    }
    if (mode === 'ordinary') {
      utimesSync(file, new Date(), new Date(Date.now() + 2000))
      await read({ file_path: file, offset: 2, limit: 1 }, ctx)
      check('touching identical bytes and reading another line cannot erase the cut', (await Edit.validateInput(input, ctx)).result === false)
    }
    const lossless = Read.inputSchema.safeParse({ file_path: file, offset: 1, limit: 1, lossless: true })
    check(`${mode}: lossless ranged option exists`, lossless.success)
    if (!lossless.success) continue
    const r = await read(lossless.data, ctx)
    check(`${mode}: lossless result shows the suffix`, r.text.includes('_suffix') && !r.text.includes('truncated'))
    const ready = await Edit.validateInput(input, ctx)
    check(`${mode}: whole-line replacement succeeds after lossless read`, ready.result === true, ready)
    if (ready.result) { await Edit.call(input, ctx, null as any, parent); check(`${mode}: replacement landed`, readFileSync(file, 'utf8') === 'replacement\nshort\n') }
  }
  const chained = join(home, 'chained.txt')
  const long = 'prefix_' + 'x'.repeat(9000) + '_suffix'
  writeFileSync(chained, long + '\nshort\n')
  const chainedCtx = context()
  const initial = await read({ file_path: chained, line_anchors: true }, chainedCtx)
  const tagged = /^(1#[0-9a-f]+)/m.exec(initial.text)![1]!
  check('a line anchor cannot authorise a clipped whole-line hunk', (await Edit.validateInput({ file_path: chained, hunks: [{ lines: tagged, replace: 'replacement' }] }, chainedCtx)).result === false)
  let directRefused = false
  try { await Edit.call({ file_path: chained, old_string: long, new_string: 'replacement' }, chainedCtx, null as any, parent) } catch (e) { directRefused = String(e).includes('lossless: true') }
  check('execution rechecks a clipped whole-line edit', directRefused && readFileSync(chained, 'utf8').startsWith(long))
  writeFileSync(chained, long + '\nshort\n')
  await read({ file_path: chained, line_anchors: true }, chainedCtx)
  const prefixEdit = { file_path: chained, old_string: 'prefix_', new_string: 'new\nprefix_' }
  check('observed prefix edit validates', (await Edit.validateInput(prefixEdit, chainedCtx)).result === true)
  await Edit.call(prefixEdit, chainedCtx, null as any, parent)
  check('an unshown suffix remains protected after a prefix edit shifts it', (await Edit.validateInput({ file_path: chained, old_string: long, new_string: 'replacement' }, chainedCtx)).result === false)
  const multiLossless = await read({ file_path: chained, ranges: ['1', '2'], lossless: true }, chainedCtx)
  check('lossless multi-range read shows complete lines', multiLossless.text.includes('_suffix'))
  check('lossless multi-range read supplies complete evidence', (await Edit.validateInput({ file_path: chained, old_string: long, new_string: 'replacement' }, chainedCtx)).result === true)
  const huge = join(home, 'huge.txt'); writeFileSync(huge, 'x'.repeat(600_000))
  const ctx = context()
  let error = ''
  try { await read({ file_path: huge, offset: 1, limit: 1, lossless: true }, ctx) } catch (e) { error = String(e) }
  check('one line beyond the existing budget is refused honestly', /exceeds.*budget.*single line cannot be split/i.test(error), error)
  check('over-budget lossless read grants no whole-line knowledge', (await Edit.validateInput({ file_path: huge, old_string: 'x'.repeat(600_000), new_string: 'replacement' }, ctx)).result === false)
  const { FileWriteTool: Write } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
  const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
  const siblingContext = (): any => { const c = context(); c.userModified = false; c.getAppState = () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), additionalWorkingDirectories: new Map([[realHome, { source: 'session' }]]) } }); return c }
  const written = join(realHome, 'written.txt'); writeFileSync(written, line + '\nshort\n')
  const writeCtx = siblingContext()
  await read({ file_path: written }, writeCtx)
  let writeRefusal = ''
  try { await Write.call({ file_path: written, content: 'rewritten\n' }, writeCtx, null as any, parent) } catch (e) { writeRefusal = String(e) }
  check('Write refuses to overwrite a file whose read clipped a line, naming the lossless read', writeRefusal.includes(`Line 1 was clipped; Read(file_path: ${JSON.stringify(written)}, offset: 1, limit: 1, lossless: true)`) && readFileSync(written, 'utf8').startsWith(line), writeRefusal)
  await read({ file_path: written, offset: 1, limit: 1, lossless: true }, writeCtx)
  await Write.call({ file_path: written, content: 'rewritten\n' }, writeCtx, null as any, parent)
  check('Write lands once the clipped line was read lossless', readFileSync(written, 'utf8') === 'rewritten\n')
  const set = join(realHome, 'set.txt'); writeFileSync(set, line + '\nshort\n')
  const setCtx = siblingContext()
  const setRead = await read({ file_path: set }, setCtx)
  const member = { file_path: set, expected_anchor: (setRead.data as any).file.anchor, hunks: [{ lines: '1', replace: 'replacement' }] }
  const refusedSet = await (ChangeSetTool as any).call({ op: 'apply', changes: [member] }, setCtx, null, parent)
  check('ChangeSet refuses a hunk over a clipped line, naming the lossless read', String(refusedSet.data?.result).includes('[not-read] Line 1 was clipped; Read(') && readFileSync(set, 'utf8').startsWith(line), refusedSet.data?.result)
  await read({ file_path: set, offset: 1, limit: 1, lossless: true }, setCtx)
  await (ChangeSetTool as any).call({ op: 'apply', changes: [member] }, setCtx, null, parent)
  check('ChangeSet lands once the clipped line was read lossless', readFileSync(set, 'utf8') === 'replacement\nshort\n')
  for (const [name, total, window, missing] of [
    ['window', 50, { offset: 1, limit: 10 }, '11-50'],
    ['default', 3000, {}, '2001-3000'],
    ['tail', 50, { offset: -10 }, '1-40'],
  ] as const) {
    const file = join(home, `${name}-write.txt`)
    const original = Array.from({ length: total }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
    writeFileSync(file, original)
    const ctx = context()
    await read({ file_path: file, ...window }, ctx)
    let refusal = ''
    try { await Write.call({ file_path: file, content: 'replacement\n' }, ctx, null as any, parent) } catch (error) { refusal = (error as Error).message }
    check(`${name}: Write refuses the unread range without changing the file`, refusal.includes(missing) && readFileSync(file, 'utf8') === original, refusal)
    check(`${name}: the error row names the unread lines and nothing else`, toolErrorReason(refusal, '') === `Lines ${missing} were not read`, toolErrorReason(refusal, ''))
    await read({ file_path: file, offset: name === 'default' ? 2001 : name === 'tail' ? 1 : 11, limit: name === 'tail' ? 40 : total }, ctx)
    await Write.call({ file_path: file, content: 'replacement\n' }, ctx, null as any, parent)
    check(`${name}: complete window coverage permits Write`, readFileSync(file, 'utf8') === 'replacement\n')
  }
  const numbered = join(home, 'numbered.txt')
  for (const mode of ['write', 'exact', 'hunks', 'append', 'hashed']) {
    writeFileSync(numbered, 'alpha\nbeta\n')
    const ctx = context()
    const before = await read({ file_path: numbered }, ctx)
    const body = mode === 'hashed' ? '1#ab3f\tALPHA\n2#12ad\tBETA' : '1\tALPHA\n2\tBETA'
    if (mode === 'write' || mode === 'hashed') await Write.call({ file_path: numbered, content: body }, ctx, null as any, parent)
    else {
      const input = { file_path: numbered, ...(mode === 'exact' ? { old_string: '1\talpha\n2\tbeta', new_string: body } : mode === 'append' ? { append: body } : { expected_anchor: (before.data as any).file.anchor, hunks: [{ lines: '1-2', replace: body }] }) }
      const verdict = await Edit.validateInput(input, ctx)
      check(`${mode}: copied prefixes validate`, verdict.result === true, verdict)
      if (verdict.result) await Edit.call(input, ctx, null as any, parent)
    }
    check(`${mode}: sequential Read prefixes never reach disk`, readFileSync(numbered, 'utf8') === (mode === 'append' ? 'alpha\nbeta\nALPHA\nBETA\n' : 'ALPHA\nBETA\n'), readFileSync(numbered, 'utf8'))
  }
  for (const body of ['1\tALPHA\nBETA', '1\tALPHA\n3\tBETA', '1\tALPHA']) {
    writeFileSync(numbered, 'alpha\nbeta\n')
    const ctx = context()
    const before = await read({ file_path: numbered }, ctx)
    const input = { file_path: numbered, expected_anchor: (before.data as any).file.anchor, hunks: [{ lines: '1-2', replace: body }] }
    check(`Edit keeps ${JSON.stringify(body)} literal: Read numbers every line, counting up by one`, (await Edit.validateInput(input, ctx)).result === true)
    await Edit.call(input, ctx, null as any, parent)
    check(`Edit writes ${JSON.stringify(body)} as given`, readFileSync(numbered, 'utf8') === `${body}\n`, readFileSync(numbered, 'utf8'))
    writeFileSync(numbered, 'alpha\nbeta\n')
    const writeCtx = context()
    await read({ file_path: numbered }, writeCtx)
    await Write.call({ file_path: numbered, content: body }, writeCtx, null as any, parent)
    check(`Write writes ${JSON.stringify(body)} as given`, readFileSync(numbered, 'utf8') === `${body}\n`, readFileSync(numbered, 'utf8'))
  }
  const { stripSequentialReadPrefixes } = await import('../../src/tools/FileEditTool/utils.ts')
  for (const body of ['1. alpha\n2. beta', '00000010  61 62\n00000020  63 64', '12:00\talpha\n12:01\tbeta', '12\tAlice\n47\tBob', 'cat <<EOF\n1\tAlice\n2\tBob\nEOF']) {
    check(`numbered lists, hex dumps, timestamps, gapped IDs and heredoc rows stay literal: ${JSON.stringify(body)}`, stripSequentialReadPrefixes(body, '') === body && stripSequentialReadPrefixes(body, 'code\n') === body)
  }
  writeFileSync(numbered, '1\talpha\n2\tbeta\n')
  const tableCtx = context()
  await read({ file_path: numbered }, tableCtx)
  await Write.call({ file_path: numbered, content: '1\tALPHA\n2\tbeta\n' }, tableCtx, null as any, parent)
  const tableEdit = { file_path: numbered, old_string: '1\tALPHA\n2\tbeta', new_string: '1\tALPHA\n2\tBETA' }
  check('a literal numbered TSV edit validates', (await Edit.validateInput(tableEdit, tableCtx)).result === true)
  await Edit.call(tableEdit, tableCtx, null as any, parent)
  check('Write and Edit preserve existing numbered TSV fields', readFileSync(numbered, 'utf8') === '1\tALPHA\n2\tBETA\n')
  const table = join(home, 'new-table.txt')
  let ambiguous = ''
  try { await Write.call({ file_path: table, content: '1\talpha\n2\tbeta\n' }, context(), null as any, parent) } catch (error) { ambiguous = (error as Error).message }
  check('a new file whose every line is numbered is refused with the reason and nothing is written', toolErrorReason(ambiguous, '') === 'Every line starts with a line number and a tab' && !existsSync(table), ambiguous)
  const tableCtx2 = context()
  await Write.call({ file_path: table, content: '1\talpha\n' }, tableCtx2, null as any, parent)
  const appendRest = { file_path: table, append: '2\tbeta' }
  check('the second numbered line appends as given', (await Edit.validateInput(appendRest, tableCtx2)).result === true)
  await Edit.call(appendRest, tableCtx2, null as any, parent)
  check('numbered data still lands: the first line alone, then the rest appended', readFileSync(table, 'utf8') === '1\talpha\n2\tbeta\n', readFileSync(table, 'utf8'))
  const emptyFile = join(home, 'empty-table.txt')
  writeFileSync(emptyFile, '')
  const emptyCtx = context()
  await read({ file_path: emptyFile }, emptyCtx)
  const create = { file_path: emptyFile, old_string: '', new_string: '1\talpha\n2\tbeta' }
  const createVerdict = await Edit.validateInput(create, emptyCtx)
  check('Edit refuses the same text into an empty file at validation', createVerdict.result === false && String((createVerdict as any).message).startsWith('Every line starts with a line number and a tab;'), createVerdict)
  let createRefused = false
  try { await Edit.call(create, emptyCtx, null as any, parent) } catch (error) { createRefused = String(error).includes('line number and a tab') }
  check('Edit rechecks it at execution and writes nothing', createRefused && readFileSync(emptyFile, 'utf8') === '')
} finally { rmSync(home, { recursive: true, force: true }) }
process.exit(failures ? 1 : 0)
