#!/usr/bin/env bun
// ============================================================================
//  scripts/repetition-guard/prove-changeset-repetition.ts — the set-level
//  no-change joins the ONE bounded repetition policy:
//
//    · an all-satisfied apply repeated with the SAME plan digest reaches
//      the ceiling on the 3rd call — is_error surfaces via repetitionStop
//      while the internal effect stays a truthful no-change with ZERO
//      writes;
//    · a DIFFERENT all-satisfied plan (changed intent) starts fresh;
//    · the committed-plan replay lane stays OUT of the policy (its result
//      self-names and never errors).
//
//  Deterministic: fs digests — no sleeps; hermetic MERCURY_CONFIG_DIR +
//  MERCURY_CHANGESET_DIR pins (the F6 law).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stillpoint-cs-home-'))
process.env.MERCURY_SIMPLE = '1'
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'stillpoint-cs-dir-'))
delete process.env.MERCURY_CHANGESET
delete process.env.MERCURY_CHANGE_RECEIPTS

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — changeset-repetition proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import(
  '../../src/services/changeTransaction/snapshotAnchor.ts'
)
const { _resetRepetitionPolicyForTesting } = await import(
  '../../src/services/changeTransaction/repetitionPolicy.ts'
)

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'stillpoint-cs-fix-')))
const A = 'a1\na2\na3\n'
const B = 'b1\nb2\n'
const aPath = join(fixtures, 'a.ts')
const bPath = join(fixtures, 'b.ts')
writeFileSync(aPath, A)
writeFileSync(bPath, B)

function makeContext(owner = 'stillpoint-cs-owner') {
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
  } as never as { readFileState: Map<string, unknown> }
}
type Ctx = ReturnType<typeof makeContext>

function primeRead(ctx: Ctx, ...paths: string[]): void {
  for (const p of paths) {
    ctx.readFileState.set(p, {
      content: readFileSync(p, 'utf8').replaceAll('\r\n', '\n'),
      timestamp: Date.now() + 60_000,
      offset: undefined,
      limit: undefined,
    })
  }
}

async function callTool(input: Record<string, unknown>, ctx: Ctx) {
  const result = await (ChangeSetTool as { call: Function }).call(input, ctx, null, {
    uuid: '00000000-0000-0000-0000-0000000000c5',
    message: { id: 'msg_fixture' },
  })
  const mapped = (ChangeSetTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(
    result.data,
    'toolu_fixture',
  ) as { content: string; is_error?: boolean }
  return {
    data: result.data as { op: string; result: string; outcome: string; planId?: string; repetitionStop?: boolean },
    effect: result.effect as { outcome: string; operation: string; changedPaths: string[] },
    mapped,
  }
}

const satisfied = (p: string, line: string, text: string) => ({
  file_path: p,
  expected_anchor: mintFileAnchor(readFileSync(p, 'utf8').replaceAll('\r\n', '\n')),
  hunks: [{ lines: line, replace: text }],
})

function treeDigest(): string {
  return [aPath, bPath].map(p => createHash('sha256').update(readFileSync(p)).digest('hex')).join('|')
}

console.log('── set-level ceiling ──')
{
  _resetRepetitionPolicyForTesting()
  const ctx = makeContext()
  primeRead(ctx, aPath, bPath)
  const before = treeDigest()
  const sameSet = () => ({
    op: 'apply',
    changes: [satisfied(aPath, '1', 'a1'), satisfied(bPath, '2', 'b2')],
  })

  const r1 = await callTool(sameSet(), ctx)
  check('C1 all-satisfied apply is a truthful no-change', r1.data.outcome === 'no-change' && r1.effect.outcome === 'no-change' && r1.effect.changedPaths.length === 0, r1.data.result)
  check('C2 1st is recoverable (no is_error)', r1.mapped.is_error !== true)

  const r2 = await callTool(sameSet(), ctx)
  check('C3 2nd recoverable + escalating guidance in the result', r2.mapped.is_error !== true && /times in a row/.test(r2.data.result), r2.data.result)

  const r3 = await callTool(sameSet(), ctx)
  check('C4 3rd surfaces the model-visible error (repetitionStop)', r3.mapped.is_error === true && r3.data.repetitionStop === true, r3.data.result)
  check('C5 3rd INTERNAL outcome stays truthful no-change', r3.data.outcome === 'no-change' && r3.effect.outcome === 'no-change' && r3.effect.changedPaths.length === 0)
  check('C6 ZERO writes across all three applies', treeDigest() === before)
  check('C7 ceiling text instructs stop (never updated/created)', /Stop repeating/.test(r3.data.result) && !/updated|created/i.test(r3.data.result), r3.data.result)

  // a DIFFERENT satisfied set (changed intent) starts fresh
  const other = await callTool(
    { op: 'apply', changes: [satisfied(aPath, '2', 'a2')] },
    ctx,
  )
  check('C8 a different satisfied plan starts fresh (no is_error)', other.data.outcome === 'no-change' && other.mapped.is_error !== true, other.data.result)
}

console.log('── committed-plan replay stays OUT ──')
{
  _resetRepetitionPolicyForTesting()
  const ctx = makeContext()
  primeRead(ctx, aPath, bPath)
  const real = await callTool(
    { op: 'apply', changes: [satisfied(aPath, '1', 'A1-changed')] },
    ctx,
  )
  check('C9 the real set applied', real.data.outcome === 'succeeded' && readFileSync(aPath, 'utf8') === 'A1-changed\na2\na3\n', real.data.result)
  const planId = real.data.planId
  // replay the SAME committed plan three times — self-naming no-change,
  // never a repetition error (the replay lane stays out of the policy)
  let anyError = false
  for (let i = 0; i < 3; i++) {
    const replay = await callTool({ op: 'apply', plan_id: planId }, ctx)
    if (replay.mapped.is_error === true) anyError = true
    check(`C10.${i + 1} replay ${i + 1} self-names as committed no-change`, replay.data.outcome === 'no-change' && /already committed/.test(replay.data.result), replay.data.result)
  }
  check('C11 replays never surface a repetition error', !anyError)
}

clearTimeout(guard)
console.log(failures === 0 ? '\nprove-changeset-repetition: GREEN' : `\nprove-changeset-repetition: RED (${failures} failure${failures === 1 ? '' : 's'})`)
process.exit(failures === 0 ? 0 : 1)
