#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'write-ranges-anchor-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.MERCURY_EDIT_LEDGER
delete process.env.NODE_ENV

const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 700 ? `${detail.slice(0, 700)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the write/ranges anchor proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

type Entry = { content: string; timestamp: number; offset?: number; limit?: number; isPartialView?: boolean }
type Ctx = { readFileState: Map<string, Entry> }
function makeContext(): Ctx {
  return {
    readFileState: new Map<string, Entry>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    options: { tools: [], isNonInteractiveSession: true },
  } as never as Ctx
}
const PARENT = { uuid: '00000000-0000-0000-0000-000000000041', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string } | { ok: false; message: string }
async function run(tool: unknown, input: Record<string, unknown>, ctx: Ctx, id: string): Promise<Verdict> {
  const t = tool as { validateInput?: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  if (t.validateInput) {
    const verdict = await t.validateInput(input, ctx)
    if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  }
  try {
    const out = await t.call(input, ctx, null, PARENT)
    const block = t.mapToolResultToToolResultBlockParam(out.data, id)
    const content = block.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : ''
    return block.is_error === true ? { ok: false, message: text } : { ok: true, text }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const edit = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileEditTool, input, ctx, 'toolu_edit')
const read = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileReadTool, input, ctx, 'toolu_read')
const write = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileWriteTool, input, ctx, 'toolu_write')
const changeSet = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(ChangeSetTool, input, ctx, 'toolu_cs')
const textOf = (v: Verdict): string => (v.ok ? v.text : v.message)
const anchorTail = (text: string): string | null => {
  const match = /\(anchor: ((?:fa|ra):[^)]+)\)\s*$/m.exec(text)
  return match === null ? null : match[1]!
}

const fixtures = mkdtempSync(join(tmpdir(), 'write-ranges-anchor-fixture-'))

console.log('============================================================')
console.log(' Write and Read(ranges) hand back the anchor the next Edit needs; a stale anchor names the Read, never a value to paste')
console.log('============================================================')

section('§1 a Write that creates a file ends with the whole-file anchor, and the next Edit carries it without a Read in between (the Heroes L134→L222 road)')
{
  const ctx = makeContext()
  const file = join(fixtures, 'roadmap.md')
  const content = '# Roadmap\n\n## Wave 0 — active\n- lane A\n- lane B\n'
  const w = await write({ file_path: file, content }, ctx)
  const text = textOf(w)
  check('the Write landed', w.ok, text.slice(0, 200))
  const anchor = anchorTail(text)
  check('the result ends with a whole-file anchor', anchor !== null && anchor.startsWith('fa:'), text)
  check('the anchor is the one the file content mints', anchor === mintFileAnchor(content), `${anchor} vs ${mintFileAnchor(content)}`)
  check('the result still says the lines count as read', text.includes('no Read is needed before the next edit'), text)
  const e = await edit({ file_path: file, old_string: '## Wave 0 — active', new_string: '## Wave 0 — complete', expected_anchor: anchor }, ctx)
  check('an Edit carrying that anchor is admitted and lands with no Read between', e.ok && /updated successfully/.test(textOf(e)), textOf(e).slice(0, 300))
  check('the file carries the change', readFileSync(file, 'utf8').includes('## Wave 0 — complete'))
}

section('§2 a Write over an existing file ends with the anchor of the new content')
{
  const ctx = makeContext()
  const file = join(fixtures, 'gitignore')
  writeFileSync(file, '/target/\nCargo.lock\n')
  const first = await read({ file_path: file }, ctx)
  check('the Read landed', first.ok, textOf(first).slice(0, 120))
  const next = '/target/\n**/*.rs.bk\n'
  const w = await write({ file_path: file, content: next }, ctx)
  const text = textOf(w)
  check('the overwrite landed', w.ok, text.slice(0, 200))
  check('the result ends with the anchor of what was written, not of what stood before', anchorTail(text) === mintFileAnchor(next) && anchorTail(text) !== mintFileAnchor('/target/\nCargo.lock\n'), text)
  const e = await edit({ file_path: file, old_string: '**/*.rs.bk', new_string: '**/*.rs.bk\n.DS_Store', expected_anchor: anchorTail(text) }, ctx)
  check('the next Edit carries it and lands', e.ok, textOf(e).slice(0, 300))
}

section('§3 a Read with ranges ends with the whole-file anchor (the Heroes L1536→L1540 road)')
{
  const ctx = makeContext()
  const file = join(fixtures, 'lanes.md')
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)
  const content = `${lines.join('\n')}\n`
  writeFileSync(file, content)
  const r = await read({ file_path: file, ranges: ['10-14', '30-30', '58-60'] }, ctx)
  const text = textOf(r)
  check('the ranged Read landed', r.ok, text.slice(0, 200))
  check('it shows the ranges and nothing else', text.includes('10\tline 10') && text.includes('30\tline 30') && text.includes('60\tline 60') && !text.includes('20\tline 20'), text.slice(0, 600))
  const anchor = anchorTail(text)
  check('the result ends with a whole-file anchor', anchor !== null && anchor.startsWith('fa:'), text.slice(-200))
  check('the anchor is the one the file content mints', anchor === mintFileAnchor(content), `${anchor} vs ${mintFileAnchor(content)}`)
  const cs = await changeSet({ op: 'apply', changes: [{ file_path: file, expected_anchor: anchor, hunks: [{ lines: '30', replace: 'line thirty' }] }] }, ctx)
  check('a ChangeSet carrying that anchor passes preflight and applies', cs.ok && /Applied plan/.test(textOf(cs)), textOf(cs).slice(0, 400))
  check('the file carries the change', readFileSync(file, 'utf8').includes('line thirty'))
  const lossless = await read({ file_path: file, ranges: ['1-3'], lossless: true }, ctx)
  check('a lossless ranged Read carries the fresh anchor too', anchorTail(textOf(lossless)) === mintFileAnchor(readFileSync(file, 'utf8')), textOf(lossless).slice(-200))
}

section('§4 a stale anchor refuses by naming the Read to do; no current anchor rides the refusal (Edit and ChangeSet alike)')
{
  const ctx = makeContext()
  const file = join(fixtures, 'drift.md')
  const content = 'alpha\nbeta\ngamma\n'
  writeFileSync(file, content)
  const r = await read({ file_path: file, ranges: ['1-3'] }, ctx)
  const anchor = anchorTail(textOf(r))
  check('the ranged Read handed an anchor', anchor === mintFileAnchor(content))
  writeFileSync(file, 'alpha\nBETA\ngamma\n')
  const current = mintFileAnchor('alpha\nBETA\ngamma\n')
  const e = await edit({ file_path: file, old_string: 'gamma', new_string: 'delta', expected_anchor: anchor }, ctx)
  const et = textOf(e)
  check('the Edit is refused', !e.ok, et.slice(0, 200))
  check('the Edit refusal names the Read to do', /Read it again before editing it|re-read .*\(full file\) to refresh the anchor/.test(et), et)
  check("the Edit refusal carries no anchor value: not the file's current anchor, no current_anchor line", !et.includes(current) && !et.includes('current_anchor'), et)
  const cs = await changeSet({ op: 'apply', changes: [{ file_path: file, expected_anchor: anchor, hunks: [{ lines: '3', replace: 'delta' }] }] }, ctx)
  const ct = textOf(cs)
  check('the ChangeSet is refused', !cs.ok || /refused/.test(ct), ct.slice(0, 200))
  check('the ChangeSet refusal names the Read that refreshes the anchor', /stale anchor — re-read .*\(full file\) to refresh the anchor/.test(ct), ct)
  check('the ChangeSet refusal carries no anchor value', !ct.includes(current) && !/\(current: /.test(ct), ct)
  check('nothing was written', readFileSync(file, 'utf8') === 'alpha\nBETA\ngamma\n')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'write-and-ranges-anchor: ALL LAWS HOLD' : `write-and-ranges-anchor: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
