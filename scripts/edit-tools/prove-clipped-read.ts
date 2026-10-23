#!/usr/bin/env bun
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'clipped-read-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
process.env.MERCURY_BARE = '1'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.ANTHROPIC_API_KEY = 'fixture-token-count-key'
delete process.env.MERCURY_HOME
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { FileReadTool: Read } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileEditTool: Edit } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { GrepTool: Grep } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
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
} finally { rmSync(home, { recursive: true, force: true }) }
process.exit(failures ? 1 : 0)
