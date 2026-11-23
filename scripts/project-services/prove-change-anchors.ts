#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-anchor-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_CHANGE_RECEIPTS

const {
  checkAnchor,
  mintFileAnchor,
  mintRangeAnchor,
  parseAnchor,
  sliceRange,
} = await import('../../src/tools/engines/change-transaction/snapshotAnchor.ts')
const { FileReadTool } = await import('../../src/tools/read/ReadTool.ts')
const { FileEditTool } = await import('../../src/tools/edit/EditTool.ts')
const { FileWriteTool } = await import('../../src/tools/write/WriteTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — anchor proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

type ReadStamp = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
}
function makeContext(readFileState: Map<string, ReadStamp>) {
  return {
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as never
}

async function readViaTool(
  path: string,
  ctx: ReturnType<typeof makeContext>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await (FileReadTool as { call: Function }).call(
    { file_path: path, ...extra },
    ctx,
    null,
    { uuid: '00000000-0000-0000-0000-000000000001', message: { id: 'msg_fixture' } },
  )
  const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function })
    .mapToolResultToToolResultBlockParam(result.data, 'toolu_read')
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}

function extractAnchor(readText: string): string | null {
  const m = readText.match(/\(anchor: ([^)]+)\)/)
  return m ? m[1]! : null
}

const dir = mkdtempSync(join(tmpdir(), 'vanguard-anchor-fixture-'))

section('P. pure anchor math')
{
  const a = mintFileAnchor('hello\nworld\n')
  check('P1 full anchor shape', /^fa:[0-9a-f]{12}$/.test(a), `minted ${a} · mintFileAnchor in src/tools/engines/change-transaction/snapshotAnchor.ts must return fa: plus 12 hex digits`)
  check('P2 parse round-trip', parseAnchor(a)?.kind === 'full', `parsed ${JSON.stringify(parseAnchor(a))} · parseAnchor in src/tools/engines/change-transaction/snapshotAnchor.ts must read an fa: anchor as kind full`)
  check('P3 CRLF normalizes — same logical content, same anchor',
    mintFileAnchor('hello\r\nworld\r\n') === a,
    'mintFileAnchor in src/tools/engines/change-transaction/snapshotAnchor.ts must normalize CRLF before it digests')
  check('P4 unicode is content — é ≠ é anchors differ',
    mintFileAnchor('café') !== mintFileAnchor('café'))
  const r = mintRangeAnchor('line2\nline3', 2, 2)
  const pr = parseAnchor(r)
  check('P5 range anchor shape + parse',
    /^ra:[0-9a-f]{12}:L2\+2$/.test(r) && pr?.kind === 'range' && pr.startLine === 2 && pr.lineCount === 2,
    `minted ${r} · mintRangeAnchor and parseAnchor in src/tools/engines/change-transaction/snapshotAnchor.ts must agree on the ra:digest:Lstart+count shape`)
  check('P6 sliceRange 1-based', sliceRange('a\nb\nc\nd', 2, 2) === 'b\nc', `got ${JSON.stringify(sliceRange('a\nb\nc\nd', 2, 2))} · sliceRange in src/tools/engines/change-transaction/snapshotAnchor.ts must count lines from 1`)
  check('P7 malformed parse refused',
    parseAnchor('fa:xyz') === null && parseAnchor('ra:abcdefabcdef:L0+1') === null,
    'parseAnchor in src/tools/engines/change-transaction/snapshotAnchor.ts must return null for a bad digest and for a range starting at line 0')
  const full = 'a\nb\nc\nd\n'
  const okCheck = checkAnchor(r, 'x\nline2\nline3\nz', 'f.txt')
  check('P8 range check re-digests the same range of current content', okCheck.ok === true, `${JSON.stringify(okCheck)} · checkAnchor in src/tools/engines/change-transaction/snapshotAnchor.ts must digest the same line range of the current content`)
  const staleCheck = checkAnchor(a, full, 'f.txt')
  check('P9 stale check returns current anchor + reread hint',
    staleCheck.ok === false && staleCheck.reason === 'stale' &&
    staleCheck.currentAnchor === mintFileAnchor(full) &&
    staleCheck.rereadHint.includes('f.txt'),
    `${JSON.stringify(staleCheck)} · checkAnchor in src/tools/engines/change-transaction/snapshotAnchor.ts must answer stale with the current anchor and a reread hint naming the file`)
}

section('R. FileRead mints anchors')
const target = join(dir, 'anchored.ts')
const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
writeFileSync(target, body)
let fullAnchor = ''
{
  const ctx = makeContext(new Map())
  const text = await readViaTool(target, ctx)
  const anchor = extractAnchor(text)
  check('R1 full read appends the fa: anchor', anchor !== null && anchor.startsWith('fa:'), `anchor ${anchor} · a full read must end with (anchor: fa:...) , see src/tools/read/call/call.ts`)
  check('R2 the minted anchor matches the file content', anchor === mintFileAnchor(body), `read ${anchor} · expected ${mintFileAnchor(body)} · FileRead in src/tools/read/call/call.ts must mint the anchor from the file content`)
  fullAnchor = anchor ?? ''

  const rangeText = await readViaTool(target, makeContext(new Map()), { offset: 10, limit: 5 })
  const rangeAnchor = extractAnchor(rangeText)
  check('R3 range read appends the ra: anchor with the 1-based range',
    rangeAnchor !== null && /^ra:[0-9a-f]{12}:L10\+5$/.test(rangeAnchor),
    `anchor ${rangeAnchor} · a read with offset and limit must end with an ra: anchor, see src/tools/read`)

  process.env.MERCURY_CHANGE_RECEIPTS = '0'
  const offText = await readViaTool(target, makeContext(new Map()))
  check('R4 gate OFF ⇒ no anchor line (byte-identical read)', extractAnchor(offText) === null, `anchor ${extractAnchor(offText)} · FileRead in src/tools/read/call/call.ts must add no anchor when MERCURY_CHANGE_RECEIPTS is 0`)
  delete process.env.MERCURY_CHANGE_RECEIPTS
}

section('E. FileEdit enforces anchors (the full stale→reread→success journey)')
{
  const freshStamp = () => new Map<string, ReadStamp>([[target, {
    content: readFileSync(target, 'utf8'),
    timestamp: statSync(target).mtimeMs + 1,
    offset: undefined,
    limit: undefined,
  }]])

  const okValidate = await FileEditTool.validateInput!(
    { file_path: target, old_string: 'line 5', new_string: 'line five', expected_anchor: fullAnchor } as never,
    makeContext(freshStamp()),
  )
  check('E1 matching anchor passes', okValidate.result === true, `${JSON.stringify(okValidate)} · FileEditTool validateInput in src/tools/FileEditTool must accept an anchor that matches the file`)

  writeFileSync(target, body.replace('line 20', 'line twenty (concurrent)'))
  const staleValidate = await FileEditTool.validateInput!(
    { file_path: target, old_string: 'line 5', new_string: 'line five', expected_anchor: fullAnchor } as never,
    makeContext(freshStamp()),
  )
  const msg = (staleValidate as { message?: string }).message ?? ''
  check('E2 stale anchor refuses with errorCode 11',
    staleValidate.result === false && (staleValidate as { errorCode?: number }).errorCode === 11,
    `${JSON.stringify(staleValidate)} · FileEditTool validateInput in src/tools/FileEditTool must refuse a stale anchor with errorCode 11`)
  check('E3 refusal is typed: the expected anchor and the Reread line, no current anchor to paste',
    msg.includes(`expected_anchor: ${fullAnchor}`) &&
    !/current_anchor/.test(msg) &&
    !msg.includes(mintFileAnchor(readFileSync(target, 'utf8'))) &&
    /Reread: re-read .*\(full file\) to refresh the anchor/.test(msg),
    `message ${JSON.stringify(msg)} · the stale refusal from FileEditTool validateInput (src/tools/FileEditTool) must carry the expected anchor and the Reread line, and no current anchor`)

  const rereadCtx = makeContext(freshStamp())
  const rereadText = await readViaTool(target, rereadCtx)
  const freshAnchor = extractAnchor(rereadText)
  check('E4a reread mints the current anchor',
    freshAnchor !== null && freshAnchor === mintFileAnchor(readFileSync(target, 'utf8')),
    `anchor ${freshAnchor} · FileRead in src/tools/read/call/call.ts must mint the anchor of the current file content`)
  const okEdit = await (FileEditTool as { call: Function }).call(
    { file_path: target, old_string: 'line 5', new_string: 'line five', expected_anchor: freshAnchor },
    rereadCtx,
    null,
    { uuid: '00000000-0000-0000-0000-000000000002' },
  )
  check('E4b anchored edit lands', readFileSync(target, 'utf8').includes('line five'), 'FileEditTool call in src/tools/edit/call/call.ts must apply an edit whose expected_anchor matches the reread')
  check('E4c effect records the anchor was checked',
    okEdit.effect?.details?.anchorChecked === true,
    `details ${JSON.stringify(okEdit.effect?.details)} · the effect built in src/tools/edit/call/callParts.ts must carry anchorChecked true`)

  let threw: Error | null = null
  try {
    await (FileEditTool as { call: Function }).call(
      { file_path: target, old_string: 'line 6', new_string: 'line six', expected_anchor: fullAnchor },
      makeContext(freshStamp()),
      null,
      { uuid: '00000000-0000-0000-0000-000000000003' },
    )
  } catch (e) {
    threw = e as Error
  }
  check('E5 in-call recheck throws the typed stale error (nothing written)',
    threw !== null && threw.message.includes('Stale anchor') &&
    !readFileSync(target, 'utf8').includes('line six'),
    `threw ${threw?.message ?? 'nothing'} · the anchor recheck in src/tools/edit/call/call.ts must throw a Stale anchor error before it writes`)

  const malformed = await FileEditTool.validateInput!(
    { file_path: target, old_string: 'line 7', new_string: 'line seven', expected_anchor: 'not-an-anchor' } as never,
    makeContext(freshStamp()),
  )
  check('E6 malformed anchor refuses with errorCode 12',
    malformed.result === false && (malformed as { errorCode?: number }).errorCode === 12,
    `${JSON.stringify(malformed)} · FileEditTool validateInput in src/tools/FileEditTool must refuse a malformed anchor with errorCode 12`)

  process.env.MERCURY_CHANGE_RECEIPTS = '0'
  const offValidate = await FileEditTool.validateInput!(
    { file_path: target, old_string: 'line 7', new_string: 'line seven', expected_anchor: fullAnchor } as never,
    makeContext(freshStamp()),
  )
  check('E7 gate OFF ⇒ stale anchor is ignored (pre-slice behavior)',
    offValidate.result === true,
    `${JSON.stringify(offValidate)} · FileEditTool in src/tools/FileEditTool must skip the anchor check when MERCURY_CHANGE_RECEIPTS is 0`)
  delete process.env.MERCURY_CHANGE_RECEIPTS
}

section('W. FileWrite typed-effect honesty')
{
  const wpath = join(dir, 'written.txt')
  const wctx = makeContext(new Map())
  const create = await (FileWriteTool as { call: Function }).call(
    { file_path: wpath, content: 'alpha\n' },
    wctx,
    null,
    { uuid: '00000000-0000-0000-0000-000000000004' },
  )
  check('W1 create ⇒ succeeded + exact path',
    create.effect?.outcome === 'succeeded' && create.effect.changedPaths[0] === wpath,
    `effect ${JSON.stringify(create.effect)} · FileWrite in src/tools/write/call/call.ts must report a created file as succeeded with its path`)

  const stamp = new Map<string, ReadStamp>([[wpath, {
    content: 'alpha\n',
    timestamp: statSync(wpath).mtimeMs + 1,
    offset: undefined,
    limit: undefined,
  }]])
  const identical = await (FileWriteTool as { call: Function }).call(
    { file_path: wpath, content: 'alpha\n' },
    makeContext(stamp),
    null,
    { uuid: '00000000-0000-0000-0000-000000000005' },
  )
  check('W2 byte-identical overwrite ⇒ no-change effect, empty changedPaths',
    identical.effect?.outcome === 'no-change' && identical.effect.changedPaths.length === 0,
    `effect ${JSON.stringify(identical.effect)} · FileWrite in src/tools/write must report a byte-identical overwrite as no-change with no changedPaths`)

  const stamp2 = new Map<string, ReadStamp>([[wpath, {
    content: 'alpha\n',
    timestamp: statSync(wpath).mtimeMs + 1,
    offset: undefined,
    limit: undefined,
  }]])
  const real = await (FileWriteTool as { call: Function }).call(
    { file_path: wpath, content: 'beta\n' },
    makeContext(stamp2),
    null,
    { uuid: '00000000-0000-0000-0000-000000000006' },
  )
  check('W3 real overwrite ⇒ succeeded + exact path',
    real.effect?.outcome === 'succeeded' && real.effect.changedPaths[0] === wpath,
    `effect ${JSON.stringify(real.effect)} · FileWrite in src/tools/write/call/call.ts must report a real overwrite as succeeded with its path`)
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ change anchors: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ change anchors: every law holds')
