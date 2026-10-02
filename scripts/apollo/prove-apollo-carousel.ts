#!/usr/bin/env bun
import type { ToolPermissionContext } from '../../src/Tool.ts'
import type { PermissionMode } from '../../src/types/permissions.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getNextPermissionMode, cyclePermissionMode } = await import('../../src/utils/permissions/getNextPermissionMode.ts')
const { setAutoModeCircuitBroken } = await import('../../src/utils/permissions/autoModeState.ts')
const { isAutoModeGateEnabled } = await import('../../src/utils/permissions/permissionSetup.ts')
const { GLYPH, displayWidth } = await import('../../src/components/mercury-ui/glyphs.ts')
const { permissionModeSymbol, permissionModeTitle, permissionModeFromString, externalPermissionModeSchema, getModeColor } = await import('../../src/utils/permissions/PermissionMode.ts')

let failures = 0
function check(label: string, passed: boolean, detail = ''): void {
  if (!passed) failures++
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const context = (mode: PermissionMode, bypass = false): ToolPermissionContext => ({
  mode,
  isBypassPermissionsModeAvailable: bypass,
  isAutoModeAvailable: false,
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
})

for (const mode of ['implement', 'strategy'] as const) {
  const next = getNextPermissionMode(context(mode))
  check(`Shift+Tab from ${mode} reaches apollo`, next === 'apollo', `actual=${next}`)
  const transitioned = cyclePermissionMode({ ...context(mode), ...(mode === 'strategy' ? { preStrategyMode: 'implement' as const } : {}) })
  check(`${mode} transition targets apollo without stashed Strategy state`, transitioned.nextMode === 'apollo' && !('preStrategyMode' in transitioned.context), `next=${transitioned.nextMode}`)
}

try {
  for (const flow of [true, false]) {
    setAutoModeCircuitBroken(!flow)
    check(`live flow gate is ${flow}`, isAutoModeGateEnabled() === flow)
    for (const bypass of [false, true]) {
      const expected: PermissionMode[] = ['default', 'implement', 'apollo']
      if (flow) expected.push('flow')
      if (bypass) expected.push('sovereign')
      for (let index = 0; index < expected.length; index++) {
        const mode = expected[index]!
        const next = getNextPermissionMode(context(mode, bypass))
        const wanted = expected[(index + 1) % expected.length]!
        check(`flow=${flow} bypass=${bypass}: ${mode} → ${wanted}`, next === wanted, `actual=${next}`)
      }
      check(`the cycle ends at sovereign with flow=${flow} bypass=${bypass}`, expected[expected.length - 1] === (bypass ? 'sovereign' : flow ? 'flow' : 'apollo') && getNextPermissionMode(context(expected[expected.length - 1]!, bypass)) === 'default')
      check(`strategy rejoins apollo with flow=${flow} bypass=${bypass}`, getNextPermissionMode(context('strategy', bypass)) === 'apollo')
    }
  }
} finally {
  setAutoModeCircuitBroken(false)
}

check('Apollo uses the hollow diamond', GLYPH.modeApollo === '◇' && permissionModeSymbol('apollo') === '◇')
check('Strategy keeps its hollow diamond', GLYPH.modeStrategy === '◇' && permissionModeSymbol('strategy') === '◇')
check('both mode seals are one canonical cell', displayWidth(GLYPH.modeApollo) === 1 && displayWidth(GLYPH.modeStrategy) === 1)
check('words distinguish the shared seal', permissionModeTitle('apollo') === 'Apollo Mode' && permissionModeTitle('strategy') === 'Strategy Mode')
check('each mode keeps its own colour role', getModeColor('apollo') === 'permission' && getModeColor('strategy') === 'strategyMode')
check('Strategy remains a valid explicit permission mode', permissionModeFromString('strategy') === 'strategy' && externalPermissionModeSchema().parse('strategy') === 'strategy')
console.log(`apollo carousel: ${failures === 0 ? 'GREEN' : `RED — ${failures} failures`}`)
process.exit(failures === 0 ? 0 : 1)
