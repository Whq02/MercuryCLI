#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-edit-hunks.ts — the anchored multi-hunk
//  Edit mode, proved against the PRODUCTION FileEditTool with real fs
//  fixtures.
//
//  Laws:
//    P. pure plan math — parse forms · bounds · window · disjointness ·
//       insert constraints · descending apply · final-newline preservation
//    S. schema gating — MERCURY_EDIT_HUNKS=0 ⇒ the exact pre-S2 field set
//       (no hunks), exact-string edits byte-identical ON vs OFF
//    A. atomic multi-hunk apply through the REAL tool — single range,
//       multi-range, insertion, deletion, replacement in ONE call ⇒ one
//       write + one effect; CRLF · UTF-8 multibyte · missing-final-newline
//       fixtures survive exactly
//    Z. zero-write refusals — stale anchor, overlapping/duplicate hunks,
//       out-of-bounds, ra-window violation, structural misuse: the file
//       keeps its EXACT prior bytes and the message names the failing hunk
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-edit-hunks.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'anvil-s2-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS

// self-reexec probe: print the live Edit input-schema keys and exit (the
// schema is lazily built ONCE per process, so gate-shape checks need a
// fresh process per env value)
if (process.argv.includes('--print-schema-keys')) {
  // gate value rides argv — Bun spawnSync drops env-object mutations
  // (the banked router-fabric lesson), argv never lies
  const gateArg = process.argv.find(a => a.startsWith('--gate='))
  if (gateArg) process.env.MERCURY_EDIT_HUNKS = gateArg.slice('--gate='.length)
  const { FileEditTool: tool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
  const shape = (tool as { inputSchema: { shape?: Record<string, unknown> } }).inputSchema.shape ?? {}
  console.log(JSON.stringify(Object.keys(shape)))
  process.exit(0)
}

const { planHunks, applyHunks, countLines } = await import(
  '../../src/services/changeTransaction/hunks.ts'
)
const { mintFileAnchor, mintRangeAnchor } = await import(
  '../../src/services/changeTransaction/snapshotAnchor.ts'
)
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
  console.log('\nTIMEOUT — hunks proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'anvil-s2-fixture-'))

type Ctx = ReturnType<typeof makeContext>
function makeContext() {
  const readFileState = new Map<string, unknown>()
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
  } as never as { readFileState: Map<string, unknown> }
}

function primeRead(ctx: Ctx, path: string): void {
  ctx.readFileState.set(path, {
    content: readFileSync(path, 'utf8').replaceAll('\r\n', '\n'),
    timestamp: Date.now() + 60_000,
    offset: undefined,
    limit: undefined,
  })
}

async function editViaTool(
  input: Record<string, unknown>,
  ctx: Ctx,
): Promise<
  | { ok: true; data: Record<string, unknown>; effect: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const validation = await (FileEditTool as { validateInput: Function }).validateInput(
    input,
    ctx,
  )
  if (validation.result === false) {
    return { ok: false, error: String(validation.message) }
  }
  try {
    const result = await (FileEditTool as { call: Function }).call(input, ctx, null, {
      uuid: '00000000-0000-0000-0000-000000000002',
      message: { id: 'msg_fixture' },
    })
    return { ok: true, data: result.data, effect: result.effect }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── P. pure plan math ───────────────────────────────────────────────────────
section('P. pure plan + apply math')
{
  const content = 'l1\nl2\nl3\nl4\nl5\n'
  check('P1 line count (final newline not a line)', countLines(content) === 5 && countLines('a') === 1 && countLines('') === 0)
  const single = planHunks(content, [{ lines: '2', replace: 'L2' }])
  check('P2 single line plan', single.ok)
  const range = planHunks(content, [{ lines: '2-4', replace: 'X' }])
  check('P3 range plan', range.ok)
  const multi = planHunks(content, [
    { lines: '4', replace: 'L4' },
    { lines: '1-2', replace: 'HEAD' },
  ])
  check('P4 multi plan sorts spans', multi.ok && multi.ok === true && multi.spans[0]!.start === 1)
  if (multi.ok) {
    check('P5 descending apply', applyHunks(content, multi) === 'HEAD\nl3\nL4\nl5\n')
  }
  const del = planHunks(content, [{ lines: '2-3', replace: '' }])
  check('P6 deletion', del.ok && applyHunks(content, del as never) === 'l1\nl4\nl5\n')
  const insB = planHunks(content, [{ lines: '3', replace: 'NEW', insert: 'before' }])
  check('P7 insert before', insB.ok && applyHunks(content, insB as never) === 'l1\nl2\nNEW\nl3\nl4\nl5\n')
  const insA = planHunks(content, [{ lines: '5', replace: 'TAIL', insert: 'after' }])
  check('P8 insert after preserves final newline', insA.ok && applyHunks(content, insA as never) === 'l1\nl2\nl3\nl4\nl5\nTAIL\n')
  const noNl = 'a\nb'
  const p9 = planHunks(noNl, [{ lines: '2', replace: 'B' }])
  check('P9 missing final newline preserved', p9.ok && applyHunks(noNl, p9 as never) === 'a\nB')
  check('P10 overlap named with both hunks', (() => {
    const p = planHunks(content, [{ lines: '1-3', replace: 'x' }, { lines: '3', replace: 'y' }])
    return !p.ok && p.message.includes('hunk 1') && p.message.includes('hunk 2') && p.message.includes('overlap')
  })())
  check('P11 duplicate = overlap', !planHunks(content, [{ lines: '2', replace: 'x' }, { lines: '2', replace: 'y' }]).ok)
  check('P12 out of bounds names the count', (() => {
    const p = planHunks(content, [{ lines: '9', replace: 'x' }])
    return !p.ok && p.message.includes('5 line(s)')
  })())
  check('P13 unparseable form refused', !planHunks(content, [{ lines: '2..3', replace: 'x' }]).ok)
  check('P14 insert with range refused', !planHunks(content, [{ lines: '2-3', replace: 'x', insert: 'after' }]).ok)
  check('P15 ra window enforced', (() => {
    const ra = mintRangeAnchor('l2\nl3', 2, 2)
    const inWindow = planHunks(content, [{ lines: '3', replace: 'x' }], ra)
    const outWindow = planHunks(content, [{ lines: '5', replace: 'x' }], ra)
    return inWindow.ok && !outWindow.ok && outWindow.message.includes('L2-L3')
  })())
}

// ── S. schema gating + exact-string byte-compat ────────────────────────────
section('S. gating — OFF is the exact pre-S2 surface')
{
  // the schema latches at first in-process access — probe each gate value
  // in a FRESH process (the same boot-selection semantics the expected_anchor
  // gate has always had)
  const { spawnSync } = await import('node:child_process')
  const probe = (envValue: string | undefined): string[] => {
    const args = [import.meta.path, '--print-schema-keys']
    if (envValue !== undefined) args.push(`--gate=${envValue}`)
    const r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 60_000,
    })
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]') as string[]
    } catch {
      return []
    }
  }
  const offKeys = probe('0')
  check('S1 OFF drops hunks from the schema (fresh process)', !offKeys.includes('hunks') && offKeys.includes('expected_anchor'), offKeys.join(','))
  const onKeys = Object.keys(((FileEditTool as { inputSchema: { shape?: Record<string, unknown> } }).inputSchema.shape) ?? {})
  check('S2 ON carries hunks', onKeys.includes('hunks'))
  process.env.MERCURY_EDIT_HUNKS = '1'

  // exact-string edit byte-compat ON vs OFF
  const fileOn = join(fixtures, 'compat-on.txt')
  const fileOff = join(fixtures, 'compat-off.txt')
  for (const f of [fileOn, fileOff]) writeFileSync(f, 'alpha\nbeta\ngamma\n')
  const ctxOn = makeContext()
  primeRead(ctxOn, fileOn)
  const rOn = await editViaTool({ file_path: fileOn, old_string: 'beta', new_string: 'BETA' }, ctxOn)
  process.env.MERCURY_EDIT_HUNKS = '0'
  const ctxOff = makeContext()
  primeRead(ctxOff, fileOff)
  const rOff = await editViaTool({ file_path: fileOff, old_string: 'beta', new_string: 'BETA' }, ctxOff)
  process.env.MERCURY_EDIT_HUNKS = '1'
  check('S3 exact-string edit result bytes identical ON vs OFF',
    rOn.ok && rOff.ok && readFileSync(fileOn, 'utf8') === readFileSync(fileOff, 'utf8'))
  const ctxMissing = makeContext()
  const rMissing = await editViaTool({ file_path: fileOn, new_string: 'x' }, ctxMissing)
  check('S4 omitted old_string WITHOUT hunks refuses (never silent creation)',
    !rMissing.ok && rMissing.error.includes('required unless hunks'))
}

// ── A. atomic multi-hunk apply through the REAL tool ───────────────────────
section('A. atomic apply — one call, one write, one effect')
{
  const file = join(fixtures, 'multi.ts')
  writeFileSync(file, 'function add(a, b) {\n  return a - b\n}\n\nfunction max(a, b) {\n  return a < b ? a : b\n}\n')
  const anchor = mintFileAnchor(readFileSync(file, 'utf8'))
  const ctx = makeContext()
  primeRead(ctx, file)
  const r = await editViaTool(
    {
      file_path: file,
      expected_anchor: anchor,
      hunks: [
        { lines: '2', replace: '  return a + b' },
        { lines: '6', replace: '  return a < b ? b : a' },
        { lines: '1', replace: '// calc primitives', insert: 'before' },
      ],
    },
    ctx,
  )
  check('A1 three-hunk call applies', r.ok, r.ok ? '' : r.error)
  const after = readFileSync(file, 'utf8')
  check('A2 all hunks landed + unrelated bytes exact',
    after === '// calc primitives\nfunction add(a, b) {\n  return a + b\n}\n\nfunction max(a, b) {\n  return a < b ? b : a\n}\n')
  check('A3 ONE effect names the hunk count', r.ok && String((r as { effect: { evidence: string } }).effect.evidence).includes('3 anchored hunk(s)'))
  check('A4 effect carries the exact path', r.ok && JSON.stringify((r as { effect: { changedPaths: string[] } }).effect.changedPaths) === JSON.stringify([file]))

  // CRLF fixture — endings + multibyte survive the LF-domain engine
  const crlf = join(fixtures, 'crlf.txt')
  writeFileSync(crlf, 'héllo\r\nwörld\r\ntail\r\n')
  const crlfAnchor = mintFileAnchor(readFileSync(crlf, 'utf8'))
  const ctx2 = makeContext()
  primeRead(ctx2, crlf)
  const r2 = await editViaTool(
    { file_path: crlf, expected_anchor: crlfAnchor, hunks: [{ lines: '2', replace: 'wörld²' }] },
    ctx2,
  )
  check('A5 CRLF + multibyte survive exactly', r2.ok && readFileSync(crlf, 'utf8') === 'héllo\r\nwörld²\r\ntail\r\n', r2.ok ? readFileSync(crlf, 'utf8') : r2.error)

  // empty file: hunks refuse (0 lines), old-path creation semantics untouched
  const empty = join(fixtures, 'empty.txt')
  writeFileSync(empty, '')
  const ctx3 = makeContext()
  primeRead(ctx3, empty)
  const r3 = await editViaTool(
    { file_path: empty, expected_anchor: mintFileAnchor(''), hunks: [{ lines: '1', replace: 'x' }] },
    ctx3,
  )
  check('A6 empty file: hunk out of bounds refused', !r3.ok && r3.error.includes('0 line(s)'))
}

// ── Z. zero-write refusals ──────────────────────────────────────────────────
section('Z. refusals write nothing and name the failure')
{
  const file = join(fixtures, 'guarded.txt')
  const original = 'one\ntwo\nthree\nfour\n'
  writeFileSync(file, original)
  const anchor = mintFileAnchor(original)

  // stale anchor: file drifts after the read
  const ctx = makeContext()
  primeRead(ctx, file)
  writeFileSync(file, 'one\nTWO\nthree\nfour\n')
  ctx.readFileState.set(file, {
    content: 'one\nTWO\nthree\nfour\n',
    timestamp: Date.now() + 60_000,
    offset: undefined,
    limit: undefined,
  })
  const stale = await editViaTool(
    { file_path: file, expected_anchor: anchor, hunks: [{ lines: '2', replace: 'zwei' }] },
    ctx,
  )
  check('Z1 stale anchor refused with reread pointer', !stale.ok && stale.error.includes('Stale anchor') && stale.error.includes('Reread:'))
  check('Z2 stale refusal wrote nothing', readFileSync(file, 'utf8') === 'one\nTWO\nthree\nfour\n')

  writeFileSync(file, original)
  const ctx2 = makeContext()
  primeRead(ctx2, file)
  const partial = await editViaTool(
    {
      file_path: file,
      expected_anchor: anchor,
      hunks: [
        { lines: '1', replace: 'ONE' }, // valid
        { lines: '99', replace: 'NOPE' }, // invalid
      ],
    },
    ctx2,
  )
  check('Z3 partially-valid set refused naming hunk 2', !partial.ok && partial.error.includes('hunk 2'))
  check('Z4 partially-valid set wrote ZERO bytes', readFileSync(file, 'utf8') === original)

  const ctx3 = makeContext()
  primeRead(ctx3, file)
  const mixed = await editViaTool(
    { file_path: file, old_string: 'one', new_string: 'x', expected_anchor: anchor, hunks: [{ lines: '1', replace: 'y' }] },
    ctx3,
  )
  check('Z5 mixed modes refused', !mixed.ok && mixed.error.includes('mutually exclusive'))
  const ctx4 = makeContext()
  primeRead(ctx4, file)
  const noAnchor = await editViaTool(
    { file_path: file, hunks: [{ lines: '1', replace: 'y' }] },
    ctx4,
  )
  check('Z6 hunks without expected_anchor refused', !noAnchor.ok && noAnchor.error.includes('expected_anchor'))
  check('Z7 refusals left the file untouched', readFileSync(file, 'utf8') === original)
}

console.log('')
if (failures > 0) {
  console.error(`prove-edit-hunks: ${failures} RED`)
  process.exit(1)
}
console.log('prove-edit-hunks: GREEN')
