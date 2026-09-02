#!/usr/bin/env bun
// ============================================================================
//  scripts/router/prove-corpus-schema.ts
//  PROOF: every compiler + lifecycle fixture in
//  scripts/router/corpus/ is well-formed against the fixture schema the
//  routing kernel consumes. This is a SHAPE proof, not a routing-logic
//  proof — the kernel itself is what turns each fixture's
//  `mission` into a `profile`; this only guards that the corpus stays parseable
//  and that reasonCodes/adjustments never drift outside the closed vocabulary
//  the kernel is allowed to emit.
//
//  Checks per compiler/*.json fixture:
//   - valid JSON
//   - version === 1
//   - id is a non-empty kebab-case string matching its filename (no drift
//     between "the file everyone opens" and "the id everyone greps for")
//   - mode ∈ {sequential, fanout}
//   - expected.profile ∈ the allowed profile set (or REFUSAL)
//   - expected.width is a number
//   - expected.reasonCodes / expected.adjustments are arrays whose every
//     entry is drawn from the CLOSED reason-code vocabulary below
//
//  Checks per lifecycle/*.json fixture:
//   - valid JSON, version === 1, id matches filename
//   - scenario is a non-empty string
//   - steps is a non-empty array of {event: string, expect: string}
//
//  Run:  ~/.bun/bin/bun run scripts/router/prove-corpus-schema.ts
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, 'corpus')
const COMPILER_DIR = join(ROOT, 'compiler')
const LIFECYCLE_DIR = join(ROOT, 'lifecycle')

const ALLOWED_MODES = new Set(['sequential', 'fanout'])
const ALLOWED_PROFILES = new Set([
  'sonnet-direct',
  'sonnet-opus-review',
  'opus-direct',
  'parallel-sonnet',
  'dependency-graph',
  'workflow-delegated',
  'REFUSAL',
])
const ALLOWED_TASK_SHAPES = new Set(['mechanical', 'bounded', 'cross-cutting', 'diagnostic', 'architectural', 'research'])
const ALLOWED_CODES = new Set([
  'mechanical-bounded',
  'bounded-implementation',
  'high-ambiguity',
  'high-coupling',
  'diagnostic-unknown-cause',
  'architectural',
  'separable-disjoint-ownership',
  'ordered-dependencies',
  'workflow-posture-active',
  'revision-escalation',
  'affinity-kept-model',
  'changeover-worth-it',
  'fallback-local',
  'operator-pin',
  'history-favors-profile',
  'posture-quality',
  'posture-fast',
  'exact-pin-unresolvable',
  'cycle-detected',
  'duplicate-node-ids',
  'overlap-serialized',
  'width-capped-workers',
  'width-capped-shared-lane',
  'provider-unavailable',
  'workflow-posture-absent',
  'empty-acceptance-repaired',
  'context-pressure-renewal',
  'held-for-idle',
  'effort-clamped',
])

function isArrayOfStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

console.log('============================================================')
console.log(' router fixture-corpus phase — corpus schema proof')
console.log('============================================================')

section(`compiler/*.json — schema + closed reason-code vocabulary (${COMPILER_DIR})`)

const compilerFiles = readdirSync(COMPILER_DIR).filter(f => f.endsWith('.json')).sort()
check('at least one compiler fixture found', compilerFiles.length > 0, `found ${compilerFiles.length}`)
check('exactly 19 compiler fixtures (the corpus spec)', compilerFiles.length === 19, `found ${compilerFiles.length}`)

const seenIds = new Set<string>()

for (const file of compilerFiles) {
  const path = join(COMPILER_DIR, file)
  const expectedId = basename(file, '.json')
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch (e) {
    check(`${file}: valid JSON`, false, String(e))
    continue
  }
  check(`${file}: valid JSON`, true)
  check(`${file}: version === 1`, parsed.version === 1, `got ${JSON.stringify(parsed.version)}`)
  check(
    `${file}: id is a non-empty kebab-case string matching the filename`,
    typeof parsed.id === 'string' && parsed.id === expectedId && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(parsed.id as string),
    `got id=${JSON.stringify(parsed.id)} expected=${expectedId}`,
  )
  check(`${file}: id is unique across the corpus`, typeof parsed.id === 'string' && !seenIds.has(parsed.id as string))
  if (typeof parsed.id === 'string') seenIds.add(parsed.id)

  check(`${file}: mode ∈ {sequential, fanout}`, typeof parsed.mode === 'string' && ALLOWED_MODES.has(parsed.mode as string), `got ${JSON.stringify(parsed.mode)}`)

  const mission = parsed.mission as Record<string, unknown> | undefined
  check(`${file}: mission is an object`, typeof mission === 'object' && mission !== null)
  if (mission) {
    check(`${file}: mission.objective is a non-empty string`, typeof mission.objective === 'string' && (mission.objective as string).length > 0)
    check(`${file}: mission.title is a non-empty string`, typeof mission.title === 'string' && (mission.title as string).length > 0)
    check(`${file}: mission.task is a non-empty string`, typeof mission.task === 'string' && (mission.task as string).length > 0)
    check(
      `${file}: mission.taskShape ∈ the closed taskShape set (when present)`,
      mission.taskShape === undefined || (typeof mission.taskShape === 'string' && ALLOWED_TASK_SHAPES.has(mission.taskShape as string)),
      `got ${JSON.stringify(mission.taskShape)}`,
    )
    for (const dim of ['ambiguity', 'coupling', 'parallelism'] as const) {
      const v = mission[dim]
      check(
        `${file}: mission.${dim} is an integer 0-3 (when present)`,
        v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3),
        `got ${JSON.stringify(v)}`,
      )
    }
    if (mission.candidateNodes !== undefined) {
      check(`${file}: mission.candidateNodes is an array`, Array.isArray(mission.candidateNodes))
      if (Array.isArray(mission.candidateNodes)) {
        for (const node of mission.candidateNodes as Record<string, unknown>[]) {
          check(
            `${file}: candidate node has id/title/task/dependsOn[]/ownsPaths[]/acceptance[]`,
            typeof node.id === 'string' &&
              typeof node.title === 'string' &&
              typeof node.task === 'string' &&
              isArrayOfStrings(node.dependsOn) &&
              isArrayOfStrings(node.ownsPaths) &&
              isArrayOfStrings(node.acceptance),
            `node=${JSON.stringify(node.id)}`,
          )
        }
      }
    }
  }

  const expected = parsed.expected as Record<string, unknown> | undefined
  check(`${file}: expected is an object`, typeof expected === 'object' && expected !== null)
  if (expected) {
    check(
      `${file}: expected.profile ∈ the allowed profile set (or REFUSAL)`,
      typeof expected.profile === 'string' && ALLOWED_PROFILES.has(expected.profile as string),
      `got ${JSON.stringify(expected.profile)}`,
    )
    check(`${file}: expected.width is a number`, typeof expected.width === 'number', `got ${JSON.stringify(expected.width)}`)
    check(`${file}: expected.modelClasses is an array of strings`, isArrayOfStrings(expected.modelClasses), `got ${JSON.stringify(expected.modelClasses)}`)

    check(`${file}: expected.reasonCodes is an array`, isArrayOfStrings(expected.reasonCodes), `got ${JSON.stringify(expected.reasonCodes)}`)
    if (isArrayOfStrings(expected.reasonCodes)) {
      const bad = expected.reasonCodes.filter(c => !ALLOWED_CODES.has(c))
      check(`${file}: every reasonCode is drawn from the closed vocabulary`, bad.length === 0, `unknown codes: ${JSON.stringify(bad)}`)
    }

    check(`${file}: expected.adjustments is an array`, isArrayOfStrings(expected.adjustments), `got ${JSON.stringify(expected.adjustments)}`)
    if (isArrayOfStrings(expected.adjustments)) {
      const bad = expected.adjustments.filter(c => !ALLOWED_CODES.has(c))
      check(`${file}: every adjustment is drawn from the closed vocabulary`, bad.length === 0, `unknown codes: ${JSON.stringify(bad)}`)
    }

    // REFUSAL is the one profile that structurally implies a hollow dispatch.
    if (expected.profile === 'REFUSAL') {
      check(`${file}: REFUSAL ⇒ width 0`, expected.width === 0, `got ${JSON.stringify(expected.width)}`)
      check(`${file}: REFUSAL ⇒ modelClasses []`, Array.isArray(expected.modelClasses) && (expected.modelClasses as unknown[]).length === 0)
    }
  }
}

section(`lifecycle/*.json — schema (${LIFECYCLE_DIR})`)

const lifecycleFiles = readdirSync(LIFECYCLE_DIR).filter(f => f.endsWith('.json')).sort()
check('at least one lifecycle fixture found', lifecycleFiles.length > 0, `found ${lifecycleFiles.length}`)
check('exactly 3 lifecycle fixtures (the corpus spec)', lifecycleFiles.length === 3, `found ${lifecycleFiles.length}`)

for (const file of lifecycleFiles) {
  const path = join(LIFECYCLE_DIR, file)
  const expectedId = basename(file, '.json')
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch (e) {
    check(`${file}: valid JSON`, false, String(e))
    continue
  }
  check(`${file}: valid JSON`, true)
  check(`${file}: version === 1`, parsed.version === 1, `got ${JSON.stringify(parsed.version)}`)
  check(`${file}: id matches the filename`, parsed.id === expectedId, `got id=${JSON.stringify(parsed.id)} expected=${expectedId}`)
  check(`${file}: scenario is a non-empty string`, typeof parsed.scenario === 'string' && (parsed.scenario as string).length > 0)
  check(`${file}: steps is a non-empty array`, Array.isArray(parsed.steps) && (parsed.steps as unknown[]).length > 0)
  if (Array.isArray(parsed.steps)) {
    for (const step of parsed.steps as Record<string, unknown>[]) {
      check(
        `${file}: each step has {event: string, expect: string}`,
        typeof step.event === 'string' && step.event.length > 0 && typeof step.expect === 'string' && step.expect.length > 0,
        `step=${JSON.stringify(step)}`,
      )
    }
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CORPUS SCHEMA PROOFS PASS')
else console.log(`❌ ${failures} CORPUS SCHEMA PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
