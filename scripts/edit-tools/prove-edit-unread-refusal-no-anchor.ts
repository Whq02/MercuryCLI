#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-unread-anchor-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.MERCURY_EDIT_LEDGER
delete process.env.NODE_ENV

const { mintFileAnchor, mintRangeAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
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
  console.log('\nTIMEOUT — the unread-anchor proof exceeded 60s')
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
    return { ok: true, text: typeof block.content === 'string' ? block.content : '' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const edit = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileEditTool, input, ctx, 'toolu_edit')
const read = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileReadTool, input, ctx, 'toolu_read')
const textOf = (v: Verdict): string => (v.ok ? v.text : v.message)

const CANARY = 'canary-7f3a9-medic'
const CONTENT = `API_KEY=${CANARY}\nDB_PASS=second-canary\nOTHER=plain\nMORE=plain\n`
const fixtures = mkdtempSync(join(tmpdir(), 'edit-unread-anchor-fixture-'))
const file = join(fixtures, 'secret.env')
writeFileSync(file, CONTENT)
const trueFileAnchor = mintFileAnchor(CONTENT)
const trueRangeAnchor = mintRangeAnchor(CONTENT, 1, 3)
const fileDigest = trueFileAnchor.slice(3)
const rangeDigest = trueRangeAnchor.split(':')[1]!
const WRONG_FILE = 'fa:000000000000'
const WRONG_RANGE = 'ra:000000000000:L1+3'

const carriesDigest = (text: string): string | null => {
  for (const needle of [fileDigest, rangeDigest, 'current_anchor', 'Reread:', 'the read that produced this anchor', CANARY]) {
    if (text.includes(needle)) return needle
  }
  return null
}

console.log('============================================================')
console.log(" Edit's refusal for a file this session never read carries nothing of the file, an anchor over it included")
console.log('============================================================')
console.log(` fixture: ${file}`)
console.log(` the file's own anchors (never to appear in a refusal of the unread file): ${trueFileAnchor} · ${trueRangeAnchor}`)

section('§1 an unread file with a wrong whole-file anchor (RED on 015ac050c0: current_anchor named the file\'s digest)')
{
  const ctx = makeContext()
  const v = await edit({ file_path: file, old_string: 'OTHER=plain', new_string: 'OTHER=changed', expected_anchor: WRONG_FILE }, ctx)
  const text = textOf(v)
  check('the edit is refused', !v.ok)
  check('the refusal leads with the read law', text.startsWith('Read the file before editing it'), text.slice(0, 160))
  check("the refusal carries no anchor over the file: no current_anchor, no digest, no reread window, no claim of a read that produced the anchor", carriesDigest(text) === null, `carried: ${carriesDigest(text)} — ${text}`)
  check('the refusal still says the anchor is not from a Read of this file', /[Aa]nchor check failed/.test(text) && /not from a Read/.test(text), text)
  const same = await edit({ file_path: file, old_string: 'NOT=present', new_string: 'x', expected_anchor: WRONG_FILE }, ctx)
  check('an old_string the file does not hold gets the very same words (no oracle on the content)', textOf(same) === text, textOf(same))
}

section('§2 an unread file with a wrong range anchor (RED on 015ac050c0: current_anchor named the digest of lines 1-3 and the reread named their window)')
{
  const ctx = makeContext()
  const v = await edit({ file_path: file, old_string: 'OTHER=plain', new_string: 'OTHER=changed', expected_anchor: WRONG_RANGE }, ctx)
  const text = textOf(v)
  check('the edit is refused', !v.ok)
  check('the refusal carries no anchor over the lines', carriesDigest(text) === null, `carried: ${carriesDigest(text)} — ${text}`)
}

section('§3 an unread file addressed by hunks with a wrong anchor (RED on 015ac050c0)')
{
  const ctx = makeContext()
  const v = await edit({ file_path: file, hunks: [{ lines: '3', replace: 'OTHER=changed' }], expected_anchor: WRONG_FILE }, ctx)
  const text = textOf(v)
  check('the edit is refused', !v.ok)
  check('the refusal carries no anchor over the file', carriesDigest(text) === null, `carried: ${carriesDigest(text)} — ${text}`)
}

section('§4 the same wrong anchor on a file this session HAS read: the refusal names the Read to do and hands no anchor value to paste')
{
  const ctx = makeContext()
  const r = await read({ file_path: file }, ctx)
  check('the Read landed', r.ok, textOf(r).slice(0, 120))
  const v = await edit({ file_path: file, old_string: 'OTHER=plain', new_string: 'OTHER=changed', expected_anchor: WRONG_FILE }, ctx)
  const text = textOf(v)
  check('the edit is refused on the stale anchor', !v.ok, text.slice(0, 160))
  check('the refusal names the Read that refreshes the anchor', /Reread: re-read .*\(full file\) to refresh the anchor/.test(text), text)
  check("the refusal carries no anchor value: not the file's current anchor, no current_anchor line", !text.includes(trueFileAnchor) && !text.includes('current_anchor'), text)
}

section('§5 the file is untouched')
{
  const { readFileSync } = await import('node:fs')
  check('the fixture still holds its bytes', readFileSync(file, 'utf8') === CONTENT)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'edit-unread-refusal-no-anchor: ALL LAWS HOLD' : `edit-unread-refusal-no-anchor: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
