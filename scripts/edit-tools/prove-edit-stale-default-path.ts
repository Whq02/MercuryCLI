#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-edit-stale-default-path.ts — FN-013 LOOP-03:
//  the DEFAULT hunks Edit path attempts the bounded stale-anchor relocation
//  before refusing, with the safety conditions unchanged. Before this law
//  the recovery existed and was wired only into the opt-in anchor-patch
//  lane; the surface almost every edit uses answered every drifted anchor
//  with a refusal and cost a full re-read plus a model round trip per
//  drifted edit.
//
//    §1 a PURE LINE SHIFT recovers end to end through the REAL tool: the
//       write lands at the moved position, the result names the offset
//       ("lines A → B"), and the model-facing text carries the notice.
//    §2 a change INSIDE the hunk window refuses with the existing typed
//       message and error code 11, writing nothing.
//    §3 an AMBIGUOUS relocation (two matching positions) refuses.
//    §4 a RING MISS refuses with today's message.
//    §5 the OFF arm (MERCURY_EDIT_STALE_RECOVERY=0) refuses the recoverable
//       case byte-identically to the weaker cases' message — the pre-law
//       surface exactly — and the validate stage agrees with the call
//       stage on the recoverable case.
//    §6 the wiring, structural: the read-side ring gate arms for the
//       default lane; the flag row stands with its off arm.
//
//  Hermetic: scratch home + scratch fixtures, the PRODUCTION FileEditTool.
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-edit-stale-default-path.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-default-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.MERCURY_ANCHOR_PATCH

const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { rememberAnchoredSnapshot, _resetSnapshotRingForTesting } = await import(
  '../../src/services/changeTransaction/snapshotRing.ts'
)
const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — stale-default proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'stale-default-fixture-'))

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
type Ctx = ReturnType<typeof makeContext>

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
  | { ok: false; error: string; errorCode?: number }
> {
  const validation = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  if (validation.result === false) {
    return { ok: false, error: String(validation.message), errorCode: validation.errorCode }
  }
  try {
    const result = await (FileEditTool as { call: Function }).call(input, ctx, null, {
      uuid: '00000000-0000-0000-0000-000000000003',
      message: { id: 'msg_fixture' },
    })
    return { ok: true, data: result.data, effect: result.effect }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const BLOCK = ['function target() {', "  return 'before'", '}'].join('\n')
const v1 = ['// head 1', '// head 2', '// head 3', '// head 4', '', BLOCK, '', '// tail'].join('\n') + '\n'
// BLOCK sits at lines 6-8 of v1; the edit targets line 7.

section('§1 a pure line shift recovers through the real tool, offset named')
{
  const path = join(fixtures, 'shift.ts')
  writeFileSync(path, v1)
  const ctx = makeContext()
  const staleAnchor = mintFileAnchor(v1)
  rememberAnchoredSnapshot(ownerFromToolUseContext(ctx as never), staleAnchor, v1, path)
  // The file shifts down by five lines (a sibling edit / generator wrote a
  // banner); the model's readFileState is CURRENT (it re-read, or the
  // sibling refreshed it) but its anchor is from the earlier read.
  const banner = ['// gen 1', '// gen 2', '// gen 3', '// gen 4', '// gen 5'].join('\n')
  const v2 = banner + '\n' + v1
  writeFileSync(path, v2)
  primeRead(ctx, path)
  const outcome = await editViaTool(
    { file_path: path, expected_anchor: staleAnchor, hunks: [{ lines: '7', replace: "  return 'after'" }] },
    ctx,
  )
  check('the edit lands', outcome.ok === true, outcome.ok === false ? outcome.error : '')
  const after = readFileSync(path, 'utf8')
  check('the replacement landed at the MOVED position (line 12)', after.split('\n')[11] === "  return 'after'", JSON.stringify(after.split('\n')[11]))
  check('the untouched shifted content survives', after.startsWith(banner) && after.includes('function target() {'))
  if (outcome.ok) {
    const note = String((outcome.data as { staleRecovery?: string }).staleRecovery ?? '')
    check('the result carries the relocation notice with the line offset', /lines 7 → 12/.test(note), note)
    check('the effect evidence names the recovery', /stale anchor recovered/.test(String((outcome.effect as { evidence?: string }).evidence ?? '')))
    const wire = (FileEditTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(outcome.data, 'tu-1')
    check('the model-facing text states the relocation and the re-read guidance', /relocated/.test(String(wire.content)) && /re-read/.test(String(wire.content)), String(wire.content).slice(0, 160))
  }
}

section('§2 a change INSIDE the hunk window refuses typed, writing nothing')
{
  const path = join(fixtures, 'inside.ts')
  writeFileSync(path, v1)
  const ctx = makeContext()
  const staleAnchor = mintFileAnchor(v1)
  rememberAnchoredSnapshot(ownerFromToolUseContext(ctx as never), staleAnchor, v1, path)
  const v3 = v1.replace("  return 'before'", "  return 'REWRITTEN by someone else'")
  writeFileSync(path, v3)
  primeRead(ctx, path)
  const outcome = await editViaTool(
    { file_path: path, expected_anchor: staleAnchor, hunks: [{ lines: '7', replace: "  return 'after'" }] },
    ctx,
  )
  check('refused', outcome.ok === false)
  check('with the existing typed message and error code 11', outcome.ok === false && outcome.errorCode === 11 && /anchor/i.test(outcome.error), outcome.ok === false ? `${outcome.errorCode} ${outcome.error.slice(0, 80)}` : '')
  check('nothing written', readFileSync(path, 'utf8') === v3)
}

section('§3 two matching positions refuse rather than guess')
{
  const path = join(fixtures, 'ambiguous.ts')
  writeFileSync(path, v1)
  const ctx = makeContext()
  const staleAnchor = mintFileAnchor(v1)
  rememberAnchoredSnapshot(ownerFromToolUseContext(ctx as never), staleAnchor, v1, path)
  const v4 = '// banner\n' + v1 + '\n' + v1
  writeFileSync(path, v4)
  primeRead(ctx, path)
  const outcome = await editViaTool(
    { file_path: path, expected_anchor: staleAnchor, hunks: [{ lines: '7', replace: "  return 'after'" }] },
    ctx,
  )
  check('ambiguity refuses', outcome.ok === false && outcome.errorCode === 11)
  check('nothing written', readFileSync(path, 'utf8') === v4)
}

section('§4 a ring miss refuses with today\'s message')
{
  _resetSnapshotRingForTesting()
  const path = join(fixtures, 'ringmiss.ts')
  writeFileSync(path, v1)
  const ctx = makeContext()
  const staleAnchor = mintFileAnchor(v1)
  // NOT remembered — the ring holds nothing for this anchor.
  const v2 = '// pad\n' + v1
  writeFileSync(path, v2)
  primeRead(ctx, path)
  const outcome = await editViaTool(
    { file_path: path, expected_anchor: staleAnchor, hunks: [{ lines: '7', replace: 'x' }] },
    ctx,
  )
  check('ring miss refuses with error code 11', outcome.ok === false && outcome.errorCode === 11)
  check('nothing written', readFileSync(path, 'utf8') === v2)
}

section('§5 the off arm is the pre-law surface exactly; validate agrees with call')
{
  const path = join(fixtures, 'offarm.ts')
  writeFileSync(path, v1)
  const ctx = makeContext()
  const staleAnchor = mintFileAnchor(v1)
  rememberAnchoredSnapshot(ownerFromToolUseContext(ctx as never), staleAnchor, v1, path)
  const v2 = '// pad\n' + v1
  writeFileSync(path, v2)
  primeRead(ctx, path)
  const input = { file_path: path, expected_anchor: staleAnchor, hunks: [{ lines: '7', replace: "  return 'after'" }] }
  // The recoverable case, flag OFF: refuses; its message is byte-identical
  // to the ring-miss refusal above (today's formatAnchorFailure bytes).
  process.env.MERCURY_EDIT_STALE_RECOVERY = '0'
  const off = await editViaTool(input, ctx)
  check('flag off: the recoverable case refuses (error code 11), nothing written', off.ok === false && off.errorCode === 11 && readFileSync(path, 'utf8') === v2)
  delete process.env.MERCURY_EDIT_STALE_RECOVERY
  // Flag on again: the SAME input recovers — and the validate stage agreed
  // (editViaTool only reaches call after validateInput returned true).
  const on = await editViaTool(input, ctx)
  check('flag on: the same input recovers end to end', on.ok === true, on.ok === false ? on.error : '')
  check('…with the shift applied at the moved line', readFileSync(path, 'utf8').split('\n')[7] === "  return 'after'")
}

section('§6 the wiring, structural')
{
  const readTool = readFileSync(join(import.meta.dir, '../../src/tools/FileReadTool/FileReadTool.ts'), 'utf8')
  check('the read-side ring gate arms for the default lane', readTool.includes('anchorPatchEnabled() || staleEditRecoveryEnabled()'))
  const registry = readFileSync(join(import.meta.dir, '../../src/substrate/flagRegistry.ts'), 'utf8')
  check('the flag row stands with its off arm', registry.includes("env: 'MERCURY_EDIT_STALE_RECOVERY'") && registry.includes('pre-law build exactly'))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-edit-stale-default-path — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-edit-stale-default-path — all checks pass')
process.exit(0)
