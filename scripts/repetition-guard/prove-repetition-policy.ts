#!/usr/bin/env bun
// ============================================================================
//  scripts/repetition-guard/prove-repetition-policy.ts — the ONE bounded
//  owner-scoped no-change repetition policy:
//
//    P. pure policy laws — 1st/2nd recoverable, 3rd at the ceiling ·
//       changed intent / changed revision reset · successful-mutation reset ·
//       path + owner independence · bounded entries (LRU past the cap) ·
//       guidance vocabulary (reread hints, stop instruction, never
//       "updated"/"created")
//    T. tool-integrated ceiling — three identical no-change Edits: the 3rd
//       surfaces is_error while the INTERNAL effect stays a truthful
//       no-change; a real mutation between repeats resets even when the
//       content ROUNDTRIPS back to the same revision (the effectObserver
//       subscription, exactly as the chokepoint drives it)
//    V. verification law — a no-change observation never advances the
//       mutation sequence (evidence stays valid); a succeeded effect does
//
//  Deterministic: counters only — no sleeps.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stillpoint-policy-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_VERIFY_EVIDENCE

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — repetition-policy proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const {
  NO_CHANGE_REPETITION_CEILING,
  recordNoChangeOutcome,
  noteSuccessfulMutation,
  _resetRepetitionPolicyForTesting,
} = await import('../../src/services/changeTransaction/repetitionPolicy.ts')
const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const { verificationSummary, _resetVerificationStateForTesting } = await import(
  '../../src/utils/verification/verificationState.ts'
)
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import(
  '../../src/services/changeTransaction/snapshotAnchor.ts'
)

const fixtures = mkdtempSync(join(tmpdir(), 'stillpoint-policy-fix-'))

// ── P. pure policy laws ─────────────────────────────────────────────────────
console.log('── P. pure policy laws ──')
{
  _resetRepetitionPolicyForTesting()
  const owner = 'sp-owner-a' as never
  const obs = (over: Partial<Parameters<typeof recordNoChangeOutcome>[1]> = {}) => ({
    operation: 'file.edit',
    path: join(fixtures, 'p.ts'),
    revision: 'fa:aaaaaaaaaaaa',
    intentDigest: 'intent-1',
    ...over,
  })

  const v1 = recordNoChangeOutcome(owner, obs())
  const v2 = recordNoChangeOutcome(owner, obs())
  const v3 = recordNoChangeOutcome(owner, obs())
  check('P1 ceiling constant is 3', NO_CHANGE_REPETITION_CEILING === 3)
  check('P2 1st/2nd recoverable, 3rd at ceiling', v1.streak === 1 && !v1.atCeiling && v2.streak === 2 && !v2.atCeiling && v3.streak === 3 && v3.atCeiling)
  const v4 = recordNoChangeOutcome(owner, obs())
  check('P3 the 4th identical stays bounded', v4.streak === 4 && v4.atCeiling)

  check('P4 changed intent resets', recordNoChangeOutcome(owner, obs({ intentDigest: 'intent-2' })).streak === 1)
  check('P5 changed revision resets', recordNoChangeOutcome(owner, obs({ intentDigest: 'intent-2', revision: 'fa:bbbbbbbbbbbb' })).streak === 1)

  // successful mutation resets (streak rebuilt to 2 first)
  recordNoChangeOutcome(owner, obs())
  noteSuccessfulMutation(owner, [obs().path])
  check('P6 successful mutation resets the streak', recordNoChangeOutcome(owner, obs()).streak === 1)

  // path independence
  recordNoChangeOutcome(owner, obs())
  const vB = recordNoChangeOutcome(owner, obs({ path: join(fixtures, 'q.ts') }))
  check('P7 different paths independent', vB.streak === 1)
  // ...and the other path's streak was untouched by q.ts
  check('P8 path A streak continues after path B', recordNoChangeOutcome(owner, obs()).streak === 3)

  // owner independence
  const vO = recordNoChangeOutcome('sp-owner-b' as never, obs())
  check('P9 different owners independent', vO.streak === 1)

  // guidance vocabulary
  check('P10 early guidance is a reread hint', /re-read/i.test(v1.guidance) && !/updated|created/i.test(v1.guidance), v1.guidance)
  check('P11 ceiling guidance instructs stop', /Stop repeating/.test(v3.guidance) && /different action/.test(v3.guidance) && !/updated|created/i.test(v3.guidance), v3.guidance)

  // bounded entries: 129 distinct paths → the oldest entry falls off
  _resetRepetitionPolicyForTesting()
  recordNoChangeOutcome(owner, obs({ path: join(fixtures, 'evict-0.ts') }))
  recordNoChangeOutcome(owner, obs({ path: join(fixtures, 'evict-0.ts') }))
  for (let i = 1; i <= 128; i++) {
    recordNoChangeOutcome(owner, obs({ path: join(fixtures, `evict-${i}.ts`) }))
  }
  check('P12 entries bounded (LRU eviction past the cap)', recordNoChangeOutcome(owner, obs({ path: join(fixtures, 'evict-0.ts') })).streak === 1)
}

// ── V. verification law ─────────────────────────────────────────────────────
console.log('── V. verification law ──')
{
  _resetVerificationStateForTesting()
  const owner = 'sp-verify-owner' as never
  const cwd = mkdtempSync(join(tmpdir(), 'stillpoint-verify-cwd-'))
  const base = { owner, toolName: 'Edit', toolUseId: 't1', input: {}, ok: true, durationMs: 1, cwd }
  const effectShape = (outcome: string, changedPaths: string[]) => ({
    outcome,
    operation: 'file.edit',
    changedPaths,
    evidence: 'proof',
    startedAt: 1,
    completedAt: 2,
  })
  const before = verificationSummary(cwd, { skipDigest: true, owner }).mutationsSinceEvidence
  observeToolTerminal({ ...base, effect: effectShape('no-change', []) } as never)
  const afterNoChange = verificationSummary(cwd, { skipDigest: true, owner }).mutationsSinceEvidence
  check('V1 no-change never advances the mutation sequence', afterNoChange === before, `${before} → ${afterNoChange}`)
  observeToolTerminal({ ...base, effect: effectShape('succeeded', [join(cwd, 'x.ts')]) } as never)
  const afterSuccess = verificationSummary(cwd, { skipDigest: true, owner }).mutationsSinceEvidence
  check('V2 a succeeded effect still marks a mutation', afterSuccess === afterNoChange + 1, `${afterNoChange} → ${afterSuccess}`)
}

// ── T. tool-integrated ceiling + resets ─────────────────────────────────────
console.log('── T. tool-integrated ceiling + resets ──')

function makeContext(owner: string) {
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
  const result = await (FileEditTool as { call: Function }).call(input, ctx, null, {
    uuid: '00000000-0000-0000-0000-0000000000a7',
    message: { id: 'msg_fixture' },
  })
  return result as {
    data: Record<string, unknown>
    effect: { outcome: string; changedPaths: string[] }
  }
}

function mapResult(data: Record<string, unknown>) {
  return (FileEditTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(
    data,
    'toolu_fixture',
  ) as { content: string; is_error?: boolean }
}

{
  _resetRepetitionPolicyForTesting()
  const p = join(fixtures, 't-ceiling.ts')
  const original = 'l1\nl2\nl3\n'
  writeFileSync(p, original)
  const ctx = makeContext('sp-tool-owner')
  primeRead(ctx, p)
  const sameHunk = () => ({
    file_path: p,
    expected_anchor: mintFileAnchor(original),
    hunks: [{ lines: '2', replace: 'l2' }],
  })

  const r1 = await editViaTool(sameHunk(), ctx)
  const m1 = mapResult(r1.data)
  const r2 = await editViaTool(sameHunk(), ctx)
  const m2 = mapResult(r2.data)
  const r3 = await editViaTool(sameHunk(), ctx)
  const m3 = mapResult(r3.data)
  check('T1 1st/2nd recoverable (no is_error)', m1.is_error !== true && m2.is_error !== true)
  check('T2 2nd carries escalating guidance', /2 times in a row/.test(m2.content), m2.content)
  check('T3 3rd is a model-visible tool error', m3.is_error === true, m3.content)
  check('T4 3rd INTERNAL outcome stays truthful no-change', r3.effect.outcome === 'no-change' && r3.effect.changedPaths.length === 0)
  check('T5 ceiling text instructs stop, never says updated/created', /Stop repeating/.test(m3.content) && !/updated|created/i.test(m3.content), m3.content)
  const r4 = await editViaTool(sameHunk(), ctx)
  check('T6 4th identical stays bounded', mapResult(r4.data).is_error === true)

  // Roundtrip reset: 2 no-changes → real edit away → real edit back (same
  // revision as before!) → the SAME no-change intent starts a fresh streak.
  // The resets ride the effectObserver subscription exactly as the
  // chokepoint fires it.
  _resetRepetitionPolicyForTesting()
  const owner = 'sp-tool-owner' as never
  const observe = (effect: { outcome: string; changedPaths: string[] }) =>
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'trip',
      input: {},
      ok: true,
      durationMs: 1,
      cwd: fixtures,
      effect: { operation: 'file.edit', evidence: 'proof', startedAt: 1, completedAt: 2, ...effect },
    } as never)

  await editViaTool(sameHunk(), ctx)
  await editViaTool(sameHunk(), ctx)
  const away = await editViaTool(
    { file_path: p, expected_anchor: mintFileAnchor(original), hunks: [{ lines: '2', replace: 'CHANGED' }] },
    ctx,
  )
  observe(away.effect)
  const back = await editViaTool(
    { file_path: p, expected_anchor: mintFileAnchor('l1\nCHANGED\nl3\n'), hunks: [{ lines: '2', replace: 'l2' }] },
    ctx,
  )
  observe(back.effect)
  check('T7 roundtrip restored the original content', readFileSync(p, 'utf8') === original)
  const rAfter = await editViaTool(sameHunk(), ctx)
  const mAfter = mapResult(rAfter.data)
  check('T8 real mutations reset the streak despite the SAME revision', mAfter.is_error !== true && /already matches/.test((rAfter.data as { noChange?: { guidance: string } }).noChange?.guidance ?? ''), mAfter.content)
}

{
  // owner isolation at the tool level: the same file + intent under a
  // different owner starts at streak 1.
  _resetRepetitionPolicyForTesting()
  const p = join(fixtures, 't-owner.ts')
  const original = 'o1\no2\n'
  writeFileSync(p, original)
  const input = () => ({
    file_path: p,
    expected_anchor: mintFileAnchor(original),
    hunks: [{ lines: '1', replace: 'o1' }],
  })
  const ctxA = makeContext('sp-owner-A')
  const ctxB = makeContext('sp-owner-B')
  primeRead(ctxA, p)
  primeRead(ctxB, p)
  await editViaTool(input(), ctxA)
  await editViaTool(input(), ctxA)
  const rA3 = await editViaTool(input(), ctxA)
  const rB1 = await editViaTool(input(), ctxB)
  check('T9 owner A reached the ceiling', mapResult(rA3.data).is_error === true)
  check('T10 owner B is independent (streak 1)', mapResult(rB1.data).is_error !== true)
}

clearTimeout(guard)
console.log(failures === 0 ? '\nprove-repetition-policy: GREEN' : `\nprove-repetition-policy: RED (${failures} failure${failures === 1 ? '' : 's'})`)
process.exit(failures === 0 ? 0 : 1)
