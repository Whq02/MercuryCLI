#!/usr/bin/env bun
// ============================================================================
//  scripts/repetition-guard/prove-nochange-write.ts — FileWrite laws,
//  proved against the PRODUCTION FileWriteTool with real fs fixtures:
//
//    N. byte-identical overwrite ⇒ honest no-change — non-empty AND EMPTY
//       existing files (the old create-branch truthiness bug), ZERO writes
//       (digest + mtime), never classified 'create'/'update', truthful
//       "content already matches" text, readFileState untouched
//    L. create/update lanes unchanged — creation still creates, a real
//       overwrite still updates (bytes land, effect succeeded, read state
//       refreshed), read-first staleness law intact
//
//  Deterministic: fs digest + mtimeMs counters — no sleeps.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stillpoint-write-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_CHANGE_RECEIPTS

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — nochange-write proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { _resetRepetitionPolicyForTesting } = await import(
  '../../src/services/changeTransaction/repetitionPolicy.ts'
)

const fixtures = mkdtempSync(join(tmpdir(), 'stillpoint-write-fix-'))

function makeContext(owner = 'stillpoint-write-owner') {
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

async function writeViaTool(input: Record<string, unknown>, ctx: Ctx) {
  const validation = await (FileWriteTool as { validateInput: Function }).validateInput(input, ctx)
  if (validation.result === false) {
    return { ok: false as const, error: String(validation.message), errorCode: validation.errorCode as number }
  }
  try {
    const result = await (FileWriteTool as { call: Function }).call(input, ctx, null, {
      uuid: '00000000-0000-0000-0000-0000000000f1',
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
  return (FileWriteTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(
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

// ── N. byte-identical overwrite ⇒ honest no-change ─────────────────────────
console.log('── N. byte-identical overwrite ⇒ honest no-change ──')
{
  _resetRepetitionPolicyForTesting()
  const p = join(fixtures, 'same.txt')
  const original = 'alpha\nbeta\ngamma\n'
  writeFileSync(p, original)
  const ctx = makeContext()
  primeRead(ctx, p)
  const primedEntry = ctx.readFileState.get(p)
  const before = digestOf(p)
  const beforeMtime = mtimeOf(p)

  const r = await writeViaTool({ file_path: p, content: original }, ctx)
  check('N1 identical non-empty overwrite resolves', r.ok, r.ok ? '' : r.error)
  if (r.ok) {
    check('N2 ZERO writes (digest + mtime unchanged)', digestOf(p) === before && mtimeOf(p) === beforeMtime)
    check('N3 classified no-change (never update)', r.data.type === 'no-change', String(r.data.type))
    check('N4 effect outcome no-change + empty changedPaths', r.effect.outcome === 'no-change' && r.effect.changedPaths.length === 0 && r.effect.operation === 'file.write')
    check('N5 originalFile carried (mutation-shaped no-change contract)', r.data.originalFile === original)
    const mapped = mapResult(r.data)
    check('N6 model text says content already matches', /content already matches/.test(mapped.content))
    check('N7 model text never says updated/created', !/updated|created/i.test(mapped.content), mapped.content)
    check('N8 first no-change is recoverable (no is_error)', mapped.is_error !== true)
    check('N9 readFileState untouched (same primed entry)', ctx.readFileState.get(p) === primedEntry)
  }
}
{
  // The EMPTY existing file: falling into the create branch via
  // oldContent truthiness is the guarded class — must be a no-change with zero writes, never
  // "created".
  _resetRepetitionPolicyForTesting()
  const p = join(fixtures, 'empty.txt')
  writeFileSync(p, '')
  const ctx = makeContext()
  primeRead(ctx, p)
  const beforeMtime = mtimeOf(p)

  const r = await writeViaTool({ file_path: p, content: '' }, ctx)
  check('N10 identical EMPTY overwrite resolves', r.ok, r.ok ? '' : r.error)
  if (r.ok) {
    check('N11 empty file classified no-change (never create)', r.data.type === 'no-change', String(r.data.type))
    check('N12 ZERO writes on the empty file', readFileSync(p, 'utf8') === '' && mtimeOf(p) === beforeMtime)
    check('N13 effect no-change + empty changedPaths', r.effect.outcome === 'no-change' && r.effect.changedPaths.length === 0)
    const mapped = mapResult(r.data)
    check('N14 empty-file text truthful (no created/updated)', /content already matches/.test(mapped.content) && !/updated|created/i.test(mapped.content), mapped.content)
  }
}

// ── L. create/update lanes unchanged ───────────────────────────────────────
console.log('── L. create/update lanes unchanged ──')
{
  _resetRepetitionPolicyForTesting()
  const ctx = makeContext()

  const pNew = join(fixtures, 'new.txt')
  const rCreate = await writeViaTool({ file_path: pNew, content: 'fresh\n' }, ctx)
  check('L1 creation still creates', rCreate.ok && rCreate.data.type === 'create' && readFileSync(pNew, 'utf8') === 'fresh\n')
  if (rCreate.ok) {
    check('L2 create effect succeeded with the path', rCreate.effect.outcome === 'succeeded' && rCreate.effect.changedPaths.length === 1)
    const mapped = mapResult(rCreate.data)
    check('L3 create text unchanged', /^File created successfully at: /.test(mapped.content))
  }

  const pUp = join(fixtures, 'up.txt')
  writeFileSync(pUp, 'v1\n')
  primeRead(ctx, pUp)
  const rUpdate = await writeViaTool({ file_path: pUp, content: 'v2\n' }, ctx)
  check('L4 real overwrite still updates', rUpdate.ok && rUpdate.data.type === 'update' && readFileSync(pUp, 'utf8') === 'v2\n')
  if (rUpdate.ok) {
    check('L5 update effect succeeded with the path', rUpdate.effect.outcome === 'succeeded' && rUpdate.effect.changedPaths.length === 1)
    check('L6 readFileState refreshed after a real write', (ctx.readFileState.get(pUp) as { content?: string })?.content === 'v2\n')
    check('L7 update data has no noChange marker', (rUpdate.data as { noChange?: unknown }).noChange === undefined)
    const mapped = mapResult(rUpdate.data)
    check('L8 update text unchanged', /has been updated successfully/.test(mapped.content))
  }

  // an EXISTING empty file overwritten with content is an
  // UPDATE (originalFile '', a real diff, honest accounting) — the old
  // oldContent-truthiness classification called it a creation.
  const pEmpty = join(fixtures, 'empty-to-content.txt')
  writeFileSync(pEmpty, '')
  primeRead(ctx, pEmpty)
  const rFill = await writeViaTool({ file_path: pEmpty, content: 'filled\n' }, ctx)
  check('L9 empty→content write still lands', rFill.ok && readFileSync(pEmpty, 'utf8') === 'filled\n' && rFill.effect.outcome === 'succeeded')
  check(
    'L9b empty→content classifies UPDATE with originalFile "" (WR-29/30)',
    rFill.ok && rFill.data.type === 'update' && rFill.data.originalFile === '',
    rFill.ok ? String(rFill.data.type) : rFill.error,
  )
}

// ── W.: the anchored non-mutating disposition ────────────────
// The read-knowledge rules moved AFTER the one current-state snapshot and
// its exact-bytes equality: an UNREAD identical body settles no-change on
// its FIRST call (the field paid two full 2,000-line emissions); an unread
// DIFFERENT body stays refused before any mutation; the equality domain is
// the bytes the write would produce (CRLF file vs LF content is a REAL
// update, never mislabeled identical).
console.log('── W. the anchored non-mutating disposition ──')
{
  _resetRepetitionPolicyForTesting()
  // W1-W4: unread + identical ⇒ typed no-change, zero writes, first call.
  const pUnreadSame = join(fixtures, 'unread-identical.txt')
  const body = 'line-1\nline-2\nline-3\n'
  writeFileSync(pUnreadSame, body)
  const beforeDigest = digestOf(pUnreadSame)
  const beforeMtime = mtimeOf(pUnreadSame)
  const rSame = await writeViaTool({ file_path: pUnreadSame, content: body }, makeContext())
  check('W1 UNREAD identical settles no-change on the FIRST call (WR-01..03)', rSame.ok && rSame.data.type === 'no-change', rSame.ok ? String(rSame.data.type) : rSame.error)
  if (rSame.ok) {
    check('W2 zero writes (digest + mtime unchanged, WR-06/07)', digestOf(pUnreadSame) === beforeDigest && mtimeOf(pUnreadSame) === beforeMtime)
    check('W3 typed effect no-change through the existing settlement (WR-05)', rSame.effect.outcome === 'no-change' && rSame.effect.changedPaths.length === 0)
    check('W4 no model-visible read-before-write error (WR-03)', mapResult(rSame.data).is_error !== true)
  }

  // W5: unread + DIFFERENT ⇒ still refused before mutation (WR-12).
  const pUnreadDiff = join(fixtures, 'unread-different.txt')
  writeFileSync(pUnreadDiff, 'original\n')
  const rDiff = await writeViaTool({ file_path: pUnreadDiff, content: 'changed\n' }, makeContext())
  check('W5 UNREAD different stays refused (WR-12)', !rDiff.ok && /Read the file before overwriting it/.test(rDiff.error), rDiff.ok ? 'settled?!' : rDiff.error)
  check('W5b nothing was written on the refusal', readFileSync(pUnreadDiff, 'utf8') === 'original\n')

  // W6: PARTIAL-view + different ⇒ refused (WR-13).
  const pPartial = join(fixtures, 'partial-different.txt')
  writeFileSync(pPartial, 'p1\np2\n')
  const ctxPartial = makeContext()
  ctxPartial.readFileState.set(pPartial, {
    content: 'p1\n',
    timestamp: Date.now() + 60_000,
    offset: 1,
    limit: 1,
    isPartialView: true,
  })
  const rPartial = await writeViaTool({ file_path: pPartial, content: 'different\n' }, ctxPartial)
  check('W6 partial-view different stays refused (WR-13)', !rPartial.ok && /Read the file before overwriting it/.test(rPartial.error))

  // W7: STALE + different ⇒ refused via the freshness anchor (WR-18/19).
  const pStale = join(fixtures, 'stale-different.txt')
  writeFileSync(pStale, 's1\n')
  const ctxStale = makeContext()
  ctxStale.readFileState.set(pStale, {
    content: 'OLD-VIEW\n',
    timestamp: mtimeOf(pStale) - 60_000,
    offset: undefined,
    limit: undefined,
  })
  const rStale = await writeViaTool({ file_path: pStale, content: 'different\n' }, ctxStale)
  check('W7 stale different refused at the final freshness anchor (WR-18)', !rStale.ok, rStale.ok ? 'settled?!' : '')

  // W8 (WR-17): a CRLF file vs the same text with LF endings is a REAL
  // update — the write would change bytes; normalized equality must never
  // call it identical.
  const pCrlf = join(fixtures, 'crlf-file.txt')
  writeFileSync(pCrlf, 'a\r\nb\r\n')
  const ctxCrlf = makeContext()
  primeRead(ctxCrlf, pCrlf)
  const rCrlf = await writeViaTool({ file_path: pCrlf, content: 'a\nb\n' }, ctxCrlf)
  check('W8 CRLF→LF is a REAL update, never mislabeled identical (WR-17)', rCrlf.ok && rCrlf.data.type === 'update' && readFileSync(pCrlf, 'utf8') === 'a\nb\n', rCrlf.ok ? String(rCrlf.data.type) : rCrlf.error)

  // W9 (WR-16): existing empty + empty requested content ⇒ no-change even
  // UNREAD (the equality needs no read knowledge).
  const pEmptyEmpty = join(fixtures, 'empty-empty.txt')
  writeFileSync(pEmptyEmpty, '')
  const rEmpty = await writeViaTool({ file_path: pEmptyEmpty, content: '' }, makeContext())
  check('W9 unread empty→empty settles no-change (WR-16)', rEmpty.ok && rEmpty.data.type === 'no-change')

  // W10 (WR-09): the repetition policy records the unread-identical
  // no-change exactly once per call with its bounded semantics intact.
  if (rSame.ok) {
    const streak = (rSame.data as { noChange?: { streak: number } }).noChange?.streak
    check('W10 repetition policy engaged exactly once (streak 1, WR-09)', streak === 1, String(streak))
  }

  // W11 (WR-31): validateInput performs no target-content equality read —
  // the snapshot/disposition belongs to the post-decision transaction.
  const toolSrc = readFileSync(
    new URL('../../src/tools/FileWriteTool/FileWriteTool.ts', import.meta.url),
    'utf8',
  )
  const validateBody = toolSrc.slice(
    toolSrc.indexOf('async validateInput('),
    toolSrc.indexOf('async call('),
  )
  check(
    'W11 validateInput is content-free — no snapshot read, no equality (WR-31)',
    !validateBody.includes('readFileSyncWithMetadata') &&
      !validateBody.includes('rawContent') &&
      !validateBody.includes('=== content'),
  )

  // W12 (WR-21 census, recorded dispositions): the expensive-payload risk is
  // Write-specific — FileEdit/NotebookEdit carry SNIPPET-sized payloads and
  // FileEdit already refuses the no-op edit (old_string === new_string) at
  // validation, so no second-body economics leak exists there. Pin the
  // refusal so the disposition stays true.
  const editSrc = readFileSync(
    new URL('../../src/tools/FileEditTool/FileEditTool.ts', import.meta.url),
    'utf8',
  )
  check(
    'W12 FileEdit refuses the no-op edit at validation (WR-21 disposition holds)',
    editSrc.includes('old_string === new_string'),
  )
}

clearTimeout(guard)
console.log(failures === 0 ? '\nprove-nochange-write: GREEN' : `\nprove-nochange-write: RED (${failures} failure${failures === 1 ? '' : 's'})`)
process.exit(failures === 0 ? 0 : 1)
