#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }



let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const profileHint = 'fix composeSystemPrompt in src/engine/system-prompt/composer.ts for a section 5 check, or resolveMercuryAppearance and colorModeFromLevel in src/screen/widgets/appearanceSnapshot.ts for a section 6 check'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : ` — ${profileHint}`}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Session profile — typed appearance/identity snapshots')
console.log('============================================================')

delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_WORKFLOW_ROUTING

const appearance = await import('../../src/screen/widgets/appearanceSnapshot.js')
const composer = await import('../../src/engine/system-prompt/composer.js')

section('§5 — composition order: identity → operator/dynamic → wrapper → mode')
{
  const composed = composer.composeSystemPrompt({
    staticSections: ['IDENTITY', null, 'TONE'],
    dynamicBoundary: [],
    dynamicSpecs: [{ name: 'memory', cacheBreak: false }],
    dynamicResolved: ['OPERATOR-CONTEXT'],
    wrapperSections: [{ name: 'response-profile', text: 'WRAPPER-PROFILE' }],
    modeSections: [{ name: 'mode-apollo', text: 'MODE-PACK' }],
    antiSycSections: [],
  })
  const order = ['IDENTITY', 'TONE', 'OPERATOR-CONTEXT', 'WRAPPER-PROFILE', 'MODE-PACK']
  check('nulls filtered, order preserved', JSON.stringify(composed) === JSON.stringify(order))
  check('identity precedes the mode pack', composed.indexOf('IDENTITY') !== -1 && composed.indexOf('IDENTITY') < composed.indexOf('MODE-PACK'))
  check('operator context precedes the mode pack', composed.indexOf('OPERATOR-CONTEXT') !== -1 && composed.indexOf('OPERATOR-CONTEXT') < composed.indexOf('MODE-PACK'))
  check('the mode pack is the LAST word (no tail follows a mode pack)', composed.at(-1) === 'MODE-PACK')

}

section('§6 — the appearance snapshot')
{
  const look = appearance.resolveMercuryAppearance({
    requestedTheme: 'auto',
    concreteTheme: 'dark',
    colorLevel: 3,
    accent: '#DD4444',
    reducedMotion: false,
    changedAt: 222,
  })
  check('appearance snapshot frozen', Object.isFrozen(look))
  check('colorMode maps chalk level 3 → truecolor', look.colorMode === 'truecolor')
  check('colorMode maps chalk level 0 → mono', appearance.colorModeFromLevel(0) === 'mono')
  check('motion resolves full/reduced', look.motion === 'full' && appearance.resolveMercuryAppearance({ requestedTheme: 'dark', concreteTheme: 'dark', colorLevel: 3, accent: '#DD4444', reducedMotion: true, changedAt: 1 }).motion === 'reduced')

}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ session-profile proofs pass')
