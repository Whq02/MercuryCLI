#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-default-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.MERCURY_ANCHOR_PATCH

const { EditTool } = await import('../../src/tools/edit/EditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { mintFileAnchor } = await import('../../src/tools/engines/change-transaction/snapshotAnchor.ts')
const { rememberAnchoredSnapshot, _resetSnapshotRingForTesting } = await import(
  '../../src/tools/engines/change-transaction/snapshotRing.ts'
)
const { ownerFromToolUseContext } = await import('../../src/engine/run-owner/resolveOwner.ts')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')

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
  const validation = await (EditTool as { validateInput: Function }).validateInput(input, ctx)
  if (validation.result === false) {
    return { ok: false, error: String(validation.message), errorCode: validation.errorCode }
  }
  try {
    const result = await (EditTool as { call: Function }).call(input, ctx, null, {
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

section('§1 a pure line shift recovers through the real tool, offset named')
{
  const path = join(fixtures, 'shift.ts')
  writeFileSync(path, v1)
  const ctx = makeContext()
  const staleAnchor = mintFileAnchor(v1)
  rememberAnchoredSnapshot(ownerFromToolUseContext(ctx as never), staleAnchor, v1, path)
  const banner = ['// gen 1', '// gen 2', '// gen 3', '// gen 4', '// gen 5'].join('\n')
  const v2 = banner + '\n' + v1
  writeFileSync(path, v2)
  primeRead(ctx, path)
  const outcome = await editViaTool(
    { file_path: path, expected_anchor: staleAnchor, hunks: [{ lines: '7', replace: "  return 'after'" }] },
    ctx,
  )
  check('the edit lands', outcome.ok === true, (outcome.ok === false ? outcome.error : '') + ' — a pure line shift must relocate the hunk; fix attemptStaleHunkRecovery in src/tools/edit/call/fileFacts.ts and recoverStaleHunks in src/tools/engines/change-transaction/stalePatchRecovery.ts')
  const after = readFileSync(path, 'utf8')
  check('the replacement landed at the MOVED position (line 12)', after.split('\n')[11] === "  return 'after'", JSON.stringify(after.split('\n')[11]) + ' — the relocated hunk must apply at the shifted line; fix recoverStaleHunks in src/tools/engines/change-transaction/stalePatchRecovery.ts')
  check('the untouched shifted content survives', after.startsWith(banner) && after.includes('function target() {'), 'recovery must change only the hunk lines; see hunksEdit in src/tools/edit/call/call.ts and recoverStaleHunks in src/tools/engines/change-transaction/stalePatchRecovery.ts')
  if (outcome.ok) {
    const note = String((outcome.data as { staleRecovery?: string }).staleRecovery ?? '')
    check('the result carries the relocation notice with the line offset', /lines 7 → 12/.test(note), note + ' — the note must name the old and new line of each hunk; fix recoverStaleHunks in src/tools/engines/change-transaction/stalePatchRecovery.ts')
    check('the effect evidence names the recovery', /stale anchor recovered/.test(String((outcome.effect as { evidence?: string }).evidence ?? '')), 'the effect evidence must say "stale anchor recovered"; fix editedAnswer in src/tools/edit/call/callParts.ts')
    const wire = (EditTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(outcome.data, 'tu-1')
    check('the model-facing text states the relocation and the re-read guidance', /relocated/.test(String(wire.content)) && /re-read/.test(String(wire.content)), String(wire.content).slice(0, 160) + ' — the model-facing text must say the hunks were relocated and to re-read; fix mapToolResultToToolResultBlockParam in src/tools/edit/EditTool.ts')
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
  check('refused', outcome.ok === false, 'a change inside the hunk window must refuse, not relocate; fix recoverStaleHunks in src/tools/engines/change-transaction/stalePatchRecovery.ts')
  check('with the existing typed message and error code 11', outcome.ok === false && outcome.errorCode === 11 && /anchor/i.test(outcome.error), outcome.ok === false ? `${outcome.errorCode} ${outcome.error.slice(0, 80)} — a refused stale anchor must keep error code 11 and the anchor message from formatAnchorFailure in src/tools/engines/change-transaction/snapshotAnchor.ts` : 'the edit did not refuse; see recoverStaleHunks in src/tools/engines/change-transaction/stalePatchRecovery.ts')
  check('nothing written', readFileSync(path, 'utf8') === v3, 'a refused edit must not write; see the throw before the write in src/tools/edit/call/call.ts')
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
  check('ambiguity refuses', outcome.ok === false && outcome.errorCode === 11, 'two matching positions must refuse with error code 11; fix the unique-match rule in recoverStaleHunks (src/tools/engines/change-transaction/stalePatchRecovery.ts)')
  check('nothing written', readFileSync(path, 'utf8') === v4, 'a refused edit must not write; see the throw before the write in src/tools/edit/call/call.ts')
}

section('§4 a ring miss refuses with today\'s message')
{
  _resetSnapshotRingForTesting()
  const path = join(fixtures, 'ringmiss.ts')
  writeFileSync(path, v1)
  const ctx = makeContext()
  const staleAnchor = mintFileAnchor(v1)
  const v2 = '// pad\n' + v1
  writeFileSync(path, v2)
  primeRead(ctx, path)
  const outcome = await editViaTool(
    { file_path: path, expected_anchor: staleAnchor, hunks: [{ lines: '7', replace: 'x' }] },
    ctx,
  )
  check('ring miss refuses with error code 11', outcome.ok === false && outcome.errorCode === 11, 'with no snapshot in the ring the stale anchor must refuse with code 11; see attemptStaleHunkRecovery in src/tools/edit/call/fileFacts.ts')
  check('nothing written', readFileSync(path, 'utf8') === v2, 'a refused edit must not write; see the throw before the write in src/tools/edit/call/call.ts')
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
  process.env.MERCURY_EDIT_STALE_RECOVERY = '0'
  const off = await editViaTool(input, ctx)
  check('flag off: the recoverable case refuses (error code 11), nothing written', off.ok === false && off.errorCode === 11 && readFileSync(path, 'utf8') === v2, 'MERCURY_EDIT_STALE_RECOVERY=0 must restore the plain refusal; fix staleEditRecoveryEnabled in src/tools/engines/change-transaction/stalePatchRecovery.ts')
  delete process.env.MERCURY_EDIT_STALE_RECOVERY
  const on = await editViaTool(input, ctx)
  check('flag on: the same input recovers end to end', on.ok === true, (on.ok === false ? on.error : '') + ' — with the flag unset the recovery must run; fix staleEditRecoveryEnabled in src/tools/engines/change-transaction/stalePatchRecovery.ts')
  check('…with the shift applied at the moved line', readFileSync(path, 'utf8').split('\n')[7] === "  return 'after'", 'the recovered edit must apply at the shifted line; fix recoverStaleHunks in src/tools/engines/change-transaction/stalePatchRecovery.ts')
}

section('§6 the wiring, structural')
{
  const recoveryRow = getFlagSpec('MERCURY_EDIT_STALE_RECOVERY')
  check('the flag row stands with its off arm', recoveryRow !== undefined && recoveryRow.off.includes('pre-law build exactly'), 'MERCURY_EDIT_STALE_RECOVERY needs a row whose off text says "pre-law build exactly"; edit it in FLAG_REGISTRY')
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-edit-stale-default-path — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-edit-stale-default-path — all checks pass')
process.exit(0)
