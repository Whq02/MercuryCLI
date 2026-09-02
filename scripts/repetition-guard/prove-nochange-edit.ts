#!/usr/bin/env bun
// ============================================================================
//  scripts/repetition-guard/prove-nochange-edit.ts — FileEdit laws,
//  proved against the PRODUCTION FileEditTool with real fs fixtures:
//
//    R. refusals preserved — exact old===new stays refused (errorCode 1);
//       quote/style normalization that collapses to identity ERRORS and
//       writes nothing (never a false successful mutation)
//    N. identical hunk result ⇒ honest no-change — ZERO writes (digest +
//       mtime), empty changedPaths, receipt-shaped no-change effect,
//       truthful model text (never "updated"/"created"), readFileState
//       untouched, CRLF disk bytes untouched (no eol-uniformization side
//       write)
//    E. real edits unchanged — writes land, effect succeeded + exact path,
//       readFileState refreshed, CRLF/encoding preserved
//
//  Deterministic: fs digest + mtimeMs counters — no sleeps.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stillpoint-edit-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — nochange-edit proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import(
  '../../src/services/changeTransaction/snapshotAnchor.ts'
)
const { isReceiptShaped } = await import(
  '../../src/services/changeTransaction/contracts.ts'
)
const { _resetRepetitionPolicyForTesting } = await import(
  '../../src/services/changeTransaction/repetitionPolicy.ts'
)

const fixtures = mkdtempSync(join(tmpdir(), 'stillpoint-edit-fix-'))

function makeContext(owner = 'stillpoint-edit-owner') {
  const readFileState = new Map<string, unknown>()
  return {
    owner,
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as never as { readFileState: Map<string, unknown> }
}
type Ctx = ReturnType<typeof makeContext>

function primeRead(ctx: Ctx, path: string): void {
  ctx.readFileState.set(path, {
    content: readFileSync(path, 'utf8').replaceAll('\r\n', '\n'),
    timestamp: Date.now() + 60_000,
    offset: undefined,
    limit: undefined,
  })
}

async function editViaTool(input: Record<string, unknown>, ctx: Ctx) {
  const validation = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  if (validation.result === false) {
    return { ok: false as const, error: String(validation.message), errorCode: validation.errorCode as number }
  }
  try {
    const result = await (FileEditTool as { call: Function }).call(input, ctx, null, {
      uuid: '00000000-0000-0000-0000-0000000000e1',
      message: { id: 'msg_fixture' },
    })
    return {
      ok: true as const,
      data: result.data as Record<string, unknown>,
      effect: result.effect as { outcome: string; operation: string; changedPaths: string[] },
    }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err), errorCode: -1 }
  }
}

function mapResult(data: Record<string, unknown>) {
  return (FileEditTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(
    data,
    'toolu_fixture',
  ) as { content: string; is_error?: boolean }
}

function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
function mtimeOf(path: string): number {
  return statSync(path).mtimeMs
}

// ── R. refusals preserved ───────────────────────────────────────────────────
console.log('── R. refusals preserved ──')
{
  _resetRepetitionPolicyForTesting()
  const p = join(fixtures, 'refuse.ts')
  writeFileSync(p, 'const a = 1\nconst b = 2\n')
  const ctx = makeContext()
  primeRead(ctx, p)
  const before = digestOf(p)

  const r1 = await editViaTool({ file_path: p, old_string: 'const a = 1', new_string: 'const a = 1' }, ctx)
  check('R1 exact old===new refused (errorCode 1)', !r1.ok && r1.errorCode === 1, r1.ok ? 'succeeded' : String(r1.errorCode))
  check('R2 refusal wrote nothing', digestOf(p) === before)
}
{
  // Quote normalization collapsing to identity: the file holds curly quotes;
  // old_string is the straight-quote spelling (matched via normalization);
  // new_string is the CURLY spelling — different from old_string, but
  // preserveQuoteStyle maps it onto the exact original text.
  const p = join(fixtures, 'quotes.md')
  const original = 'He said “hello” to the crowd.\n'
  writeFileSync(p, original)
  const ctx = makeContext()
  primeRead(ctx, p)
  const before = digestOf(p)
  const beforeMtime = mtimeOf(p)

  const r = await editViaTool(
    { file_path: p, old_string: 'said "hello" to', new_string: 'said “hello” to' },
    ctx,
  )
  check('R3 normalized-identity edit does NOT succeed', !r.ok, r.ok ? 'claimed success' : '')
  check('R4 normalized-identity edit wrote ZERO bytes', digestOf(p) === before && mtimeOf(p) === beforeMtime)
  check(
    'R5 error never claims an update',
    !r.ok && !/updated|has been updated/i.test(r.error),
    r.ok ? '' : r.error,
  )
}

// ── N. identical hunk ⇒ honest no-change ───────────────────────────────────
console.log('── N. identical hunk result ⇒ honest no-change ──')
{
  _resetRepetitionPolicyForTesting()
  const p = join(fixtures, 'same.ts')
  const original = 'l1\nl2\nl3\n'
  writeFileSync(p, original)
  const ctx = makeContext()
  primeRead(ctx, p)
  const primedEntry = ctx.readFileState.get(p)
  const before = digestOf(p)
  const beforeMtime = mtimeOf(p)

  const r = await editViaTool(
    {
      file_path: p,
      expected_anchor: mintFileAnchor(original),
      hunks: [{ lines: '2', replace: 'l2' }],
    },
    ctx,
  )
  check('N1 identical single hunk resolves (not an error)', r.ok, r.ok ? '' : r.error)
  if (r.ok) {
    check('N2 ZERO writes (digest + mtime unchanged)', digestOf(p) === before && mtimeOf(p) === beforeMtime)
    check('N3 effect outcome no-change + empty changedPaths', r.effect.outcome === 'no-change' && r.effect.changedPaths.length === 0)
    check('N4 effect stays receipt-shaped (file.edit no-change mints a receipt)', r.effect.operation === 'file.edit' && isReceiptShaped(r.effect as never))
    check('N5 data carries noChange + empty structuredPatch', Boolean((r.data as { noChange?: unknown }).noChange) && Array.isArray(r.data.structuredPatch) && (r.data.structuredPatch as unknown[]).length === 0)
    const mapped = mapResult(r.data)
    check('N6 model text is a truthful no-change', /^No changes made to /.test(mapped.content) && /byte-identical/.test(mapped.content))
    check('N7 model text never says updated/created', !/updated|created/i.test(mapped.content), mapped.content)
    check('N8 first no-change is recoverable (no is_error)', mapped.is_error !== true)
    check('N9 readFileState untouched (same primed entry)', ctx.readFileState.get(p) === primedEntry)
  }

  // multi-hunk identity composes to identity
  const r2 = await editViaTool(
    {
      file_path: p,
      expected_anchor: mintFileAnchor(original),
      hunks: [
        { lines: '1', replace: 'l1' },
        { lines: '3', replace: 'l3' },
      ],
    },
    ctx,
  )
  check('N10 multi-hunk identity is a no-change too', r2.ok && r2.effect.outcome === 'no-change' && digestOf(p) === before)
}
{
  // CRLF file: identical hunk must not rewrite the file's bytes (no silent
  // eol-uniformization side write).
  _resetRepetitionPolicyForTesting()
  const p = join(fixtures, 'crlf.ts')
  writeFileSync(p, 'a\r\nb\r\n')
  const ctx = makeContext()
  primeRead(ctx, p)
  const before = digestOf(p)
  const beforeMtime = mtimeOf(p)
  const r = await editViaTool(
    {
      file_path: p,
      expected_anchor: mintFileAnchor('a\nb\n'),
      hunks: [{ lines: '1', replace: 'a' }],
    },
    ctx,
  )
  check('N11 CRLF identical hunk is a no-change', r.ok && r.effect.outcome === 'no-change', r.ok ? '' : r.error)
  check('N12 CRLF disk bytes untouched', digestOf(p) === before && mtimeOf(p) === beforeMtime)
}

// ── E. real edits unchanged ─────────────────────────────────────────────────
console.log('── E. real edits unchanged ──')
{
  _resetRepetitionPolicyForTesting()
  const p = join(fixtures, 'real.ts')
  writeFileSync(p, 'x1\nx2\nx3\n')
  const ctx = makeContext()
  primeRead(ctx, p)

  const r = await editViaTool(
    {
      file_path: p,
      expected_anchor: mintFileAnchor('x1\nx2\nx3\n'),
      hunks: [{ lines: '2', replace: 'X2' }],
    },
    ctx,
  )
  check('E1 real hunk edit still writes', r.ok && readFileSync(p, 'utf8') === 'x1\nX2\nx3\n', r.ok ? readFileSync(p, 'utf8') : r.error)
  if (r.ok) {
    check('E2 effect succeeded with the exact path', r.effect.outcome === 'succeeded' && r.effect.changedPaths.length === 1)
    check('E3 readFileState refreshed to the new content', (ctx.readFileState.get(p) as { content?: string })?.content === 'x1\nX2\nx3\n')
    check('E4 data has no noChange marker', (r.data as { noChange?: unknown }).noChange === undefined)
    const mapped = mapResult(r.data)
    check('E5 real edit still reads as an update', /has been updated/.test(mapped.content) && mapped.is_error !== true)
  }

  // exact-string real edit unchanged
  const r2 = await editViaTool({ file_path: p, old_string: 'x3', new_string: 'x33' }, ctx)
  check('E6 exact-string real edit still works', r2.ok && readFileSync(p, 'utf8') === 'x1\nX2\nx33\n')

  // CRLF real edit preserves CRLF
  const pc = join(fixtures, 'crlf-real.ts')
  writeFileSync(pc, 'a\r\nb\r\n')
  const ctx2 = makeContext()
  primeRead(ctx2, pc)
  const r3 = await editViaTool(
    { file_path: pc, expected_anchor: mintFileAnchor('a\nb\n'), hunks: [{ lines: '2', replace: 'B' }] },
    ctx2,
  )
  check('E7 real CRLF edit preserves CRLF endings', r3.ok && readFileSync(pc, 'utf8') === 'a\r\nB\r\n')
}

clearTimeout(guard)
console.log(failures === 0 ? '\nprove-nochange-edit: GREEN' : `\nprove-nochange-edit: RED (${failures} failure${failures === 1 ? '' : 's'})`)
process.exit(failures === 0 ? 0 : 1)
