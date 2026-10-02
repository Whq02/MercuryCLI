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

{
  const next = getNextPermissionMode(context('implement'))
  check('Shift+Tab from implement reaches apollo', next === 'apollo', `actual=${next}`)
  const transitioned = cyclePermissionMode(context('implement'))
  check('implement transition targets apollo', transitioned.nextMode === 'apollo', `next=${transitioned.nextMode}`)
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
    }
  }
} finally {
  setAutoModeCircuitBroken(false)
}

check('Apollo uses the hollow diamond', GLYPH.modeApollo === '◇' && permissionModeSymbol('apollo') === '◇')
check('the Apollo seal is one canonical cell', displayWidth(GLYPH.modeApollo) === 1)
check('Apollo wears its title and colour role', permissionModeTitle('apollo') === 'Apollo Mode' && getModeColor('apollo') === 'permission')
check('an unknown mode word reads as default', permissionModeFromString('strategy') === 'default' && !externalPermissionModeSchema().safeParse('strategy').success)
console.log(`apollo carousel: ${failures === 0 ? 'GREEN' : `RED — ${failures} failures`}`)
process.exit(failures === 0 ? 0 : 1)
