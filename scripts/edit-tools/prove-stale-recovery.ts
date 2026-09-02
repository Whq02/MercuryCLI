#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-stale-recovery.ts — bounded unique-relocation
//  stale-anchor recovery on the patch path (spec 02 c.6.4):
//    R. a stale anchor whose hunk windows merely MOVED relocates with a
//       warning naming old→new lines, and the edit lands at the new place
//    A. an ambiguous relocation (the window appears twice) refuses with the
//       current anchor — nothing written
//    C. recovery NEVER fires across content changes inside the hunk window
//    W. whole-file ops (delete-file / move-to) never recover — typed refusal
//    N. no ring snapshot ⇒ the plain typed staleness refusal
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-stale-recovery.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-rec-home-'))
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
process.env.MERCURY_ANCHOR_PATCH = '1'
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'stale-rec-cs-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { rememberAnchoredSnapshot } = await import(
  '../../src/services/changeTransaction/snapshotRing.ts'
)
const { recoverStaleHunks } = await import(
  '../../src/services/changeTransaction/stalePatchRecovery.ts'
)
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'stale-rec-fix-')))
const owner = processMainOwner()

function makeContext() {
  const readFileState = new Map<string, unknown>()
  const empty = getEmptyToolPermissionContext()
  const permCtx = {
    ...empty,
    additionalWorkingDirectories: new Map([[fixtures, { source: 'session' }]]),
  }
  return {
    owner,
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: permCtx }),
  } as never as { readFileState: Map<string, { content: string; timestamp: number }> }
}
type Ctx = ReturnType<typeof makeContext>
async function callTool(input: Record<string, unknown>, ctx: Ctx) {
  const result = await (ChangeSetTool as { call: Function }).call(input, ctx, null, {
    uuid: '00000000-0000-0000-0000-0000000sr001',
    message: { id: 'msg_fixture' },
  })
  return result as { data: { outcome: string; result: string } }
}

/** Simulate the model's read of `content` at `path`: anchor + ring +
 *  read-state (the ledger is irrelevant here — recovered members are exempt,
 *  and refusal paths never reach it). */
function primeAnchoredRead(ctx: Ctx, path: string, content: string): string {
  const anchor = mintFileAnchor(content)
  rememberAnchoredSnapshot(owner, anchor, content, path)
  ctx.readFileState.set(path, { content, timestamp: Date.now() + 60_000 } as never)
  return anchor
}

const BODY = ['function target() {', '  return OLD', '}'].join('\n')

console.log('— R. unique relocation applies with a warning —')
{
  const p = join(fixtures, 'moved.ts')
  const original = ['// head', BODY, '// tail', ''].join('\n')
  writeFileSync(p, original)
  const ctx = makeContext()
  const oldAnchor = primeAnchoredRead(ctx, p, original)
  // External drift: three lines PREPENDED — the window moves, bytes intact.
  writeFileSync(p, ['// new 1', '// new 2', '// new 3', '// head', BODY, '// tail', ''].join('\n'))
  const patch = [`file ${p} ${oldAnchor}`, 'replace 3', '|   return NEW'].join('\n')
  const r = await callTool({ op: 'apply', patch }, ctx)
  check('relocated apply succeeded', r.data.outcome === 'succeeded', r.data.result.slice(0, 260))
  check('the warning names old→new lines', /stale anchor recovered: lines 3 → 6/.test(r.data.result), r.data.result.slice(0, 300))
  check('the edit landed at the RELOCATED position', readFileSync(p, 'utf8').includes('// new 3\n// head\nfunction target() {\n  return NEW\n}'), JSON.stringify(readFileSync(p, 'utf8')))
}

console.log('— A. ambiguous relocation refuses with the current anchor —')
{
  const p = join(fixtures, 'twice.ts')
  const original = ['// head', BODY, '// tail', ''].join('\n')
  writeFileSync(p, original)
  const ctx = makeContext()
  const oldAnchor = primeAnchoredRead(ctx, p, original)
  // Drift duplicates the whole window — two byte-identical candidates.
  writeFileSync(p, ['// pre', '// head', BODY, '// tail', '// mid', '// head', BODY, '// tail', ''].join('\n'))
  const before = readFileSync(p, 'utf8')
  const patch = [`file ${p} ${oldAnchor}`, 'replace 3', '|   return NEW'].join('\n')
  const r = await callTool({ op: 'apply', patch }, ctx)
  check('ambiguous relocation refused', r.data.outcome === 'failed', r.data.result.slice(0, 240))
  check('the refusal says ambiguous and carries the current anchor', /ambiguous/.test(r.data.result) && /current_anchor: fa:/.test(r.data.result), r.data.result.slice(0, 300))
  check('nothing written', readFileSync(p, 'utf8') === before)
}

console.log('— C. changed window never recovers —')
{
  const p = join(fixtures, 'changed.ts')
  const original = ['// head', BODY, '// tail', ''].join('\n')
  writeFileSync(p, original)
  const ctx = makeContext()
  const oldAnchor = primeAnchoredRead(ctx, p, original)
  // Drift EDITS a line inside the hunk window (content changed, not moved).
  writeFileSync(p, ['// head', 'function target() {', '  return TAMPERED', '}', '// tail', ''].join('\n'))
  const before = readFileSync(p, 'utf8')
  const patch = [`file ${p} ${oldAnchor}`, 'replace 3', '|   return NEW'].join('\n')
  const r = await callTool({ op: 'apply', patch }, ctx)
  check('changed-window recovery refused', r.data.outcome === 'failed', r.data.result.slice(0, 240))
  check('the refusal names the content change', /no longer appears|changed, not just moved/.test(r.data.result), r.data.result.slice(0, 300))
  check('nothing written', readFileSync(p, 'utf8') === before)

  // The pure-module law directly: context must match EXACTLY (the window
  // moved AND its neighbour line changed ⇒ no recovery even though the span
  // itself is intact).
  const pure = recoverStaleHunks({
    staleAnchor: oldAnchor,
    snapshotContent: original,
    currentContent: ['// PRE', '// head EDITED', BODY, '// tail', ''].join('\n'),
    hunks: [{ lines: '3', replace: '  return NEW' }],
    displayPath: 'changed.ts',
  })
  check('context drift inside the search block refuses (pure)', !pure.ok)
}

console.log('— W. whole-file ops never recover —')
{
  const p = join(fixtures, 'wholefile.ts')
  const original = 'to be moved\n'
  writeFileSync(p, original)
  const ctx = makeContext()
  const oldAnchor = primeAnchoredRead(ctx, p, original)
  writeFileSync(p, 'to be moved\nplus drift\n')
  const dest = join(fixtures, 'wholefile-dest.ts')
  const r = await callTool({ op: 'apply', patch: [`file ${p} ${oldAnchor}`, `move-to ${dest}`].join('\n') }, ctx)
  check('stale move-to refused (never recovered)', r.data.outcome === 'failed', r.data.result.slice(0, 240))
  check('file not moved', existsSync(p) && !existsSync(dest))
}

console.log('— N. no ring snapshot ⇒ the plain typed staleness refusal —')
{
  const p = join(fixtures, 'noring.ts')
  writeFileSync(p, 'x\ny\n')
  const ctx = makeContext()
  ctx.readFileState.set(p, { content: 'x\ny\n', timestamp: Date.now() + 60_000 } as never)
  // A syntactically valid anchor the ring has never seen.
  const foreign = 'fa:00000000feed'
  const r = await callTool({ op: 'apply', patch: [`file ${p} ${foreign}`, 'replace 1', '| X'].join('\n') }, ctx)
  check('unknown stale anchor refuses typed', r.data.outcome === 'failed' && /Stale anchor|stale/.test(r.data.result), r.data.result.slice(0, 240))
  check('the refusal carries the current anchor + reread hint', /current_anchor: fa:/.test(r.data.result) && /Reread|re-read/i.test(r.data.result), r.data.result.slice(0, 300))
}

console.log('')
if (failures > 0) {
  console.log(`RED: ${failures} failing check(s)`)
  process.exit(1)
}
console.log('GREEN: recovery fires only on provably unique moves; every other staleness stays a typed refusal')
