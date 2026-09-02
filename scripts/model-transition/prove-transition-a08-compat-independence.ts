#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-a08-compat-independence.ts —
//  A08 (re-scoped, brief Corrections §5): the compat instruction
//  profile selects INSTRUCTION FILES ONLY — model access/selection/routing
//  reads no compat facet, in either direction.
//
//    §A FORWARD FENCE — the six model-truth owners (model.ts ·
//       modelFloor.ts · capabilities.ts ·
//       modelTransition.ts · effort.ts · callModelRouter.ts) contain zero
//       references to the instruction facet (InstructionProfile ·
//       instructionProfile · instructions/profile · instructionsCompat ·
//       services/instructions).
//    §B REVERSE FENCE — the profile RESOLUTION owner
//       (services/instructions/profile.ts) reads no model facet: the
//       profile is "RUNTIME-owned — never inferred from a model name"
//       (contracts.ts law). The engine's single utils/model import is the
//       CHARACTERIZED benign exception: getMainLoopModel sizes the
//       memory-file BUDGET (context window → char cap), never the profile.
//    §C BEHAVIORAL — the model-truth battery digest is byte-identical
//       across every profile input seam: auto default · session slot
//       native · the MERCURY_INSTRUCTION_PROFILE env carrier (plus the
//       retired `compat` value refused at that seam) — with non-vacuity
//       checks that each flip really resolved.
//
//  Seams: source scan (fence) + the real resolvers under a hermetic env
//  (battery), profile flipped through its REAL seams (profile.ts setters,
//  registered env carrier).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-a08-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-a08-home-'))
delete process.env.MERCURY_INSTRUCTION_PROFILE
delete process.env.MERCURY_INSTRUCTION_PROFILE
delete process.env.MERCURY_EFFORT_LEVEL

const ROOT = join(import.meta.dir, '..', '..')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const model = await import('../../src/utils/model/model.ts')
const floor = await import('../../src/utils/model/modelFloor.ts')
const caps = await import('../../src/utils/model/capabilities.ts')
const effort = await import('../../src/utils/effort.ts')
const router = await import('../../src/services/providers/callModelRouter.ts')
const profile = await import('../../src/services/instructions/profile.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A forward fence — model owners reference no instruction facet')
{
  const OWNERS = [
    'src/utils/model/model.ts',
    'src/utils/model/modelFloor.ts',
    'src/utils/model/capabilities.ts',
    'src/utils/model/modelTransition.ts',
    'src/utils/effort.ts',
    'src/services/providers/callModelRouter.ts',
  ]
  const FACET = [
    'InstructionProfile',
    'instructionProfile',
    'instructions/profile',
    'instructionsCompat',
    'services/instructions',
  ]
  for (const rel of OWNERS) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    const hits = FACET.filter(f => src.includes(f))
    check(`${rel} is facet-free`, hits.length === 0, hits.join(', '))
  }
}

section('§B reverse fence — profile resolution reads no model facet')
{
  const src = readFileSync(join(ROOT, 'src/services/instructions/profile.ts'), 'utf8')
  const hits = ['utils/model', 'callModelRouter', 'modelFloor', 'getMainLoopModel'].filter(f =>
    src.includes(f),
  )
  check('profile.ts (the resolution owner) is model-free', hits.length === 0, hits.join(', '))
  // The characterized benign exception: engine.ts imports getMainLoopModel
  // ONLY to size the memory-file budget from the context window. Pin the
  // shape so a future profile-from-model read cannot hide behind it.
  const engine = readFileSync(join(ROOT, 'src/services/instructions/engine.ts'), 'utf8')
  const modelImports = engine
    .split('\n')
    .filter(l => l.includes('utils/model') && l.includes('import'))
  check(
    "engine.ts's only model import is the budget read (getMainLoopModel)",
    modelImports.length === 1 && modelImports[0]!.includes('getMainLoopModel'),
    modelImports.join(' · '),
  )
  check(
    'contracts.ts states the law (never inferred from a model name)',
    readFileSync(join(ROOT, 'src/services/instructions/contracts.ts'), 'utf8').includes(
      'never\n *  inferred from a model name',
    ) ||
      readFileSync(join(ROOT, 'src/services/instructions/contracts.ts'), 'utf8').includes(
        'never inferred from a model name',
      ),
  )
}

section('§C behavioral — model truth is byte-identical across every profile seam')
{
  const ROUTE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.2', 'glm-4.7', undefined]
  const EFFORT_PROBES: Array<[string, string]> = [
    ['claude-opus-5', 'high'],
    ['claude-opus-5', 'max'],
    ['gpt-5.2', 'high'],
    ['glm-4.7', 'high'],
  ]
  const CAP_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.2']

  const battery = (): unknown => ({
    mainLoop: model.getMainLoopModel(),
    best: model.getBestModel(),
    defaults: [
      model.getDefaultMainLoopModel(),
      model.getDefaultOpusModel(),
      model.getDefaultSonnetModel(),
      model.getDefaultHaikuModel(),
    ],
    userSetting: model.getUserSpecifiedModelSetting() ?? null,
    routes: ROUTE_MODELS.map(m => [m ?? '(undefined)', JSON.stringify(router.classifyModelRoute(m))]),
    effort: EFFORT_PROBES.map(([m, e]) => [m, e, effort.resolveEffortTruth(m, e as never)]),
    floor: [
      floor.enforceSubagentModelFloor('claude-haiku-4-5-20251001', 'a08-probe'),
      floor.enforceSubagentModelFloor('claude-opus-5', 'a08-probe'),
    ],
    caps: CAP_MODELS.map(m => ({
      m,
      thinking: caps.modelSupportsThinking(m),
      effortSupported: caps.modelSupportsEffort(m),
      maxEffort: caps.getMaxSupportedEffortLevel(m),
      autoMode: caps.modelSupportsAutoMode(m),
      ctx: caps.getContextWindowForModel(m),
    })),
    gptView: caps.gptEffortVocabularyView('gpt-5.2'),
  })
  const digestOf = (v: unknown): string =>
    createHash('sha256').update(JSON.stringify(v)).digest('hex')

  const r0 = profile.resolveRequestedInstructionProfile()
  check('baseline resolves to the auto default', r0.profile === 'auto' && r0.origin === 'default')
  const d0 = digestOf(battery())

  // The profile union is 'auto' | 'native' — there is no `compat` value
  // (contracts.ts: "the value is not accepted anywhere"). The battery flips
  // through the two REAL seams and proves the retired value stays refused.
  profile.setSessionInstructionProfile('native')
  const r2 = profile.resolveRequestedInstructionProfile()
  check('session slot flips the facet to native (non-vacuous)', r2.profile === 'native')
  const d2 = digestOf(battery())

  profile.setSessionInstructionProfile(null)
  process.env.MERCURY_INSTRUCTION_PROFILE = 'native'
  const r3 = profile.resolveRequestedInstructionProfile()
  check(
    'the registered env carrier flips the facet (agent tier, non-vacuous)',
    r3.profile === 'native' && r3.origin === 'agent',
  )
  const d3 = digestOf(battery())

  process.env.MERCURY_INSTRUCTION_PROFILE = 'compat'
  const r4 = profile.resolveRequestedInstructionProfile()
  check(
    'the retired compat value is refused at the env seam (falls to default)',
    r4.profile === 'auto' && r4.origin === 'default',
  )
  const d4 = digestOf(battery())
  delete process.env.MERCURY_INSTRUCTION_PROFILE

  check('model truth unchanged: auto == session-native', d0 === d2, `${d0.slice(0, 12)} vs ${d2.slice(0, 12)}`)
  check('model truth unchanged: auto == env-carrier-native', d0 === d3, `${d0.slice(0, 12)} vs ${d3.slice(0, 12)}`)
  check('model truth unchanged: auto == refused-compat', d0 === d4, `${d0.slice(0, 12)} vs ${d4.slice(0, 12)}`)
}

console.log(
  failures === 0
    ? '\n ✅ MODEL ACCESS IS COMPAT-INDEPENDENT (both fences + behavior)'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
