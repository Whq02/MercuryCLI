#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-a08-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-a08-home-'))
delete process.env.MERCURY_INSTRUCTION_PROFILE
delete process.env.MERCURY_EFFORT_LEVEL


const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

const model = await import('../../src/models/catalogue/engineModel.ts')
const caps = await import('../../src/models/facts/capabilities.ts')
const effort = await import('../../src/models/effort/effort.ts')
const router = await import('../../src/models/roads/callModelRouter.ts')
const profile = await import('../../src/sessions/instructions/profile.ts')

let failures = 0
const failureWhere = 'resolveRequestedInstructionProfile and setSessionInstructionProfile in src/sessions/instructions/profile.ts must only change the instruction profile; keep the model getters in src/models/catalogue/engineModel.ts, the capabilities in src/models/facts/capabilities.ts, resolveEffortTruth in src/models/effort/effort.ts and classifyModelRoute in src/models/roads/callModelRouter.ts from reading the profile'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ' — ' + (detail ? detail + ' — ' : '') + failureWhere : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
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
    mainLoop: model.getEngineModel(),
    best: model.getBestModel(),
    defaults: [
      model.getDefaultEngineModel(),
      model.getDefaultOpusModel(),
      model.getDefaultSonnetModel(),
      model.getDefaultHaikuModel(),
    ],
    userSetting: model.getUserSpecifiedModelSetting() ?? null,
    routes: ROUTE_MODELS.map(m => [m ?? '(undefined)', JSON.stringify(router.classifyModelRoute(m))]),
    effort: EFFORT_PROBES.map(([m, e]) => [m, e, effort.resolveEffortTruth(m, e as never)]),
    caps: CAP_MODELS.map(m => ({
      m,
      thinking: caps.modelSupportsThinking(m),
      effortSupported: caps.modelSupportsEffort(m),
      maxEffort: caps.getMaxSupportedEffortLevel(m),
      ctx: caps.getContextWindowForModel(m),
    })),
    gptView: caps.gptEffortVocabularyView('gpt-5.2'),
  })
  const digestOf = (v: unknown): string =>
    createHash('sha256').update(JSON.stringify(v)).digest('hex')

  const r0 = profile.resolveRequestedInstructionProfile()
  check('baseline resolves to the auto default', r0.profile === 'auto' && r0.origin === 'default')
  const d0 = digestOf(battery())

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
    'an unrecognised profile value is refused at the env seam (falls to default)',
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
