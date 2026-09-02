#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-anchor-patch-apply.ts — the anchored patch
//  dialect through the PRODUCTION ChangeSet tool (spec 02 c.6.2 + the
//  acceptance criteria):
//    A. a three-file patch (edit + cut/paste move of code + file rename)
//       applies atomically — byte-exact landings, one journal commit
//    C. fresh-anchor chaining: a second patch applies with NO intervening
//       read, carrying only the anchor the first result returned
//    Z. drift between plan and commit aborts with NOTHING written
//    N. a byte-identical patch classifies already-satisfied (not an error);
//       the third identical no-op escalates per the repetition policy
//    D. delete-file removes atomically; an injected fault mid-move restores
//       every path (old exists, destination absent)
//    T. token-economy RECORD: the same 20-edit session spelled as JSON
//       changes[] vs the patch dialect (a record, not a gate)
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-anchor-patch-apply.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'anchor-patch-apply-home-'))
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
process.env.MERCURY_ANCHOR_PATCH = '1'
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'anchor-patch-apply-cs-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — apply proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { countLines } = await import('../../src/services/changeTransaction/hunks.ts')
const { fileGeneration, recordSeenLines } = await import(
  '../../src/services/changeTransaction/seenLines.ts'
)
const { listPatchRegisters } = await import(
  '../../src/services/changeTransaction/patchRegisters.ts'
)
const { listJournalOperations } = await import('../../src/substrate/operationJournal.ts')
const { changeSetJournalDir } = await import(
  '../../src/services/changeTransaction/changeSetContracts.ts'
)
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'anchor-patch-apply-fix-')))
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

/** Prime BOTH evidence layers the way a real Read does: readFileState and
 *  the per-line ledger (whole file). */
function primeRead(ctx: Ctx, ...paths: string[]): void {
  for (const p of paths) {
    const content = readFileSync(p, 'utf8').replaceAll('\r\n', '\n')
    ctx.readFileState.set(p, { content, timestamp: Date.now() + 60_000 } as never)
    const generation = fileGeneration(p)
    if (generation !== null) recordSeenLines(owner, p, generation, 1, Math.max(1, countLines(content)))
  }
}

async function callTool(input: Record<string, unknown>, ctx: Ctx) {
  const result = await (ChangeSetTool as { call: Function }).call(input, ctx, null, {
    uuid: '00000000-0000-0000-0000-0000000ap002',
    message: { id: 'msg_fixture' },
  })
  return result as {
    data: { op: string; result: string; outcome: string; planId?: string; repetitionStop?: boolean }
    effect: { outcome: string; operation: string; changedPaths: string[] }
  }
}

const anchorOf = (p: string): string =>
  mintFileAnchor(readFileSync(p, 'utf8').replaceAll('\r\n', '\n'))

console.log('— A. the three-file patch: edit + cross-file code move + rename —')
{
  const a = join(fixtures, 'alpha.ts')
  const b = join(fixtures, 'beta.ts')
  const c = join(fixtures, 'gamma.ts')
  const d = join(fixtures, 'delta.ts')
  writeFileSync(a, ['// alpha', 'export function keep(): number {', '  return 1', '}', 'const HELPER = 42', 'const TAIL = 9', ''].join('\n'))
  writeFileSync(b, ['// beta', 'export const B = 2', ''].join('\n'))
  writeFileSync(c, ['// gamma', 'export const C = 3', ''].join('\n'))
  const ctx = makeContext()
  primeRead(ctx, a, b, c)
  const patch = [
    `file ${a} ${anchorOf(a)}`,
    'replace 1',
    '| // alpha (edited)',
    'cut 5 into helper',
    `file ${b} ${anchorOf(b)}`,
    'paste helper after 2',
    `file ${c} ${anchorOf(c)}`,
    `move-to ${d}`,
  ].join('\n')
  const r = await callTool({ op: 'apply', patch }, ctx)
  check('apply succeeded', r.data.outcome === 'succeeded', r.data.result.slice(0, 300))
  check('alpha edited + cut removed', readFileSync(a, 'utf8') === ['// alpha (edited)', 'export function keep(): number {', '  return 1', '}', 'const TAIL = 9', ''].join('\n'), JSON.stringify(readFileSync(a, 'utf8')))
  check('beta received the pasted line', readFileSync(b, 'utf8') === ['// beta', 'export const B = 2', 'const HELPER = 42', ''].join('\n'), JSON.stringify(readFileSync(b, 'utf8')))
  check('gamma moved to delta', !existsSync(c) && existsSync(d))
  check('delta bytes exact', existsSync(d) && readFileSync(d, 'utf8') === ['// gamma', 'export const C = 3', ''].join('\n'))
  check('changedPaths carries all four endpoints', r.effect.changedPaths.length === 4, JSON.stringify(r.effect.changedPaths))
  check('fresh anchors in the result', /\(anchor: fa:[0-9a-f]{12}\)/.test(r.data.result), r.data.result.slice(0, 200))
  check('register published', listPatchRegisters(owner).some(x => x.name === 'helper'))
  const ops = await listJournalOperations(changeSetJournalDir())
  check('exactly one committed journal op', ops.filter(o => o.state === 'committed').length === 1)

  console.log('— C. fresh-anchor chaining without a re-read —')
  const freshA = (r.data.result.match(/alpha\.ts \(anchor: (fa:[0-9a-f]{12})\)/) ?? [])[1]
  check('the result names alpha’s fresh anchor', typeof freshA === 'string')
  if (freshA) {
    const chain = [`file ${a} ${freshA}`, 'replace 1', '| // alpha (chained)'].join('\n')
    const r2 = await callTool({ op: 'apply', patch: chain }, ctx)
    check('chained patch applied with no intervening read', r2.data.outcome === 'succeeded', r2.data.result.slice(0, 240))
    check('chained content landed', readFileSync(a, 'utf8').startsWith('// alpha (chained)'))
  }
}

console.log('— Z. drift between preview and apply writes NOTHING —')
{
  const e = join(fixtures, 'epsilon.ts')
  const f = join(fixtures, 'zeta.ts')
  writeFileSync(e, 'one\ntwo\nthree\n')
  writeFileSync(f, 'ONE\nTWO\n')
  const ctx = makeContext()
  primeRead(ctx, e, f)
  const patch = [
    `file ${e} ${anchorOf(e)}`,
    'replace 2',
    '| TWO-EDITED',
    `file ${f} ${anchorOf(f)}`,
    'replace 1',
    '| one-edited',
  ].join('\n')
  const prev = await callTool({ op: 'preview', patch }, ctx)
  check('preview minted a plan', typeof prev.data.planId === 'string', prev.data.result.slice(0, 200))
  writeFileSync(f, 'DRIFTED\n')
  const r = await callTool({ op: 'apply', plan_id: prev.data.planId }, ctx)
  check('drifted apply refused', r.data.outcome === 'failed')
  check('nothing written on drift (epsilon intact)', readFileSync(e, 'utf8') === 'one\ntwo\nthree\n')
  check('the refusal names the drifted file with its current anchor', r.data.result.includes('zeta.ts') && /current anchor fa:/.test(r.data.result), r.data.result.slice(0, 240))
}

console.log('— N. already-satisfied and the repetition ceiling —')
{
  const g = join(fixtures, 'eta.ts')
  writeFileSync(g, 'same\nlines\n')
  const ctx = makeContext()
  primeRead(ctx, g)
  const patch = [`file ${g} ${anchorOf(g)}`, 'replace 1', '| same'].join('\n')
  const r1 = await callTool({ op: 'apply', patch }, ctx)
  check('byte-identical patch → no-change (not an error)', r1.data.outcome === 'no-change' && r1.data.repetitionStop !== true, r1.data.result.slice(0, 200))
  const r2 = await callTool({ op: 'apply', patch }, ctx)
  check('second identical no-op still not at the ceiling', r2.data.repetitionStop !== true)
  const r3 = await callTool({ op: 'apply', patch }, ctx)
  check('third identical no-op escalates (repetitionStop)', r3.data.repetitionStop === true, r3.data.result.slice(0, 200))
}

console.log('— D. delete-file + the interrupted move —')
{
  const h = join(fixtures, 'theta.ts')
  writeFileSync(h, 'doomed\n')
  const ctx = makeContext()
  primeRead(ctx, h)
  const r = await callTool({ op: 'apply', patch: [`file ${h} ${anchorOf(h)}`, 'delete-file'].join('\n') }, ctx)
  check('delete-file removed the file', r.data.outcome === 'succeeded' && !existsSync(h), r.data.result.slice(0, 200))

  const i = join(fixtures, 'iota.ts')
  const j = join(fixtures, 'kappa.ts')
  writeFileSync(i, 'movable\n')
  const ctx2 = makeContext()
  primeRead(ctx2, i)
  process.env.MERCURY_FAULT_INJECT = 'changeset-before-rename@kappa:throw'
  const rf = await callTool({ op: 'apply', patch: [`file ${i} ${anchorOf(i)}`, `move-to ${j}`].join('\n') }, ctx2)
  delete process.env.MERCURY_FAULT_INJECT
  check('faulted move reported failed (restored)', rf.data.outcome === 'failed', `${rf.data.outcome}: ${rf.data.result.slice(0, 240)}`)
  check('source restored after fault', existsSync(i) && readFileSync(i, 'utf8') === 'movable\n')
  check('destination absent after fault', !existsSync(j))
  const retry = await callTool({ op: 'apply', patch: [`file ${i} ${anchorOf(i)}`, `move-to ${j}`].join('\n') }, ctx2)
  check('clean retry lands the move', retry.data.outcome === 'succeeded' && !existsSync(i) && existsSync(j), retry.data.result.slice(0, 200))
}

console.log('— T. token-economy record (20 edits, JSON vs dialect) —')
{
  const files: string[] = []
  for (let n = 0; n < 5; n++) {
    const p = join(fixtures, `bench${n}.ts`)
    writeFileSync(p, Array.from({ length: 40 }, (_, k) => `const v${n}_${k} = ${k}`).join('\n') + '\n')
    files.push(p)
  }
  const changes: object[] = []
  const patchSections: string[] = []
  for (let n = 0; n < 5; n++) {
    const p = files[n]!
    const anchor = anchorOf(p)
    const hunks = []
    const ops: string[] = [`file ${p} ${anchor}`]
    for (let e = 0; e < 4; e++) {
      const line = 5 + e * 8
      hunks.push({ lines: `${line}`, replace: `const edited_${n}_${e} = 'value ${e}'` })
      ops.push(`replace ${line}`, `| const edited_${n}_${e} = 'value ${e}'`)
    }
    changes.push({ file_path: p, expected_anchor: anchor, hunks })
    patchSections.push(ops.join('\n'))
  }
  const jsonForm = JSON.stringify({ op: 'apply', changes })
  const patchForm = JSON.stringify({ op: 'apply', patch: patchSections.join('\n') })
  const ratio = patchForm.length / jsonForm.length
  console.log(`  RECORD 20-edit session serialized input: JSON changes[] ${jsonForm.length} chars · patch dialect ${patchForm.length} chars · ratio ${ratio.toFixed(3)}`)
  check('token-economy record emitted (patch form smaller)', ratio < 1, `ratio ${ratio.toFixed(3)}`)
}

console.log('')
if (failures > 0) {
  console.log(`RED: ${failures} failing check(s)`)
  process.exit(1)
}
console.log('GREEN: the patch dialect applies atomically, chains read-free, refuses drift, and records its economy')
