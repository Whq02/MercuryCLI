#!/usr/bin/env bun
// ============================================================================
//  scripts/prompt/prove-session-profile.ts — the Mercury session-profile layer
// One typed profile, pure resolvers, no drift:
//
//    §5 composition order: identity/wrapper before mode packs, reconcile tail
//       last; QueryEngine captures the prompt ONCE per query (mid-turn toggle
//       cannot re-shape an in-flight query)
//    §6 MercurySessionProfile composes identity + appearance, frozen, with
//       the invariant behavior doctrine
//
//  Run: ~/.bun/bin/bun run scripts/prompt/prove-session-profile.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Session profile — typed appearance/identity snapshots')
console.log('============================================================')

delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_WORKFLOW_ROUTING

const profile = await import('../../src/utils/profile/mercuryProfile.js')
const appearance = await import('../../src/utils/profile/appearanceSnapshot.js')
const composer = await import('../../src/prompt/composer.js')

section('§5 — composition order: identity → operator/dynamic → mode → tail')
{
  const composed = composer.composeSystemPrompt({
    staticSections: ['IDENTITY', null, 'TONE'],
    dynamicBoundary: [],
    dynamicSpecs: [{ name: 'memory', cacheBreak: false }],
    dynamicResolved: ['OPERATOR-CONTEXT'],
    wrapperSections: [{ name: 'mercury-doctrine', text: 'WRAPPER-DOCTRINE' }],
    modeSections: [{ name: 'mode-scribe', text: 'MODE-PACK' }],
    antiSycSections: [],
    reconcileTailSections: ['RECONCILE-TAIL'],
  })
  const order = ['IDENTITY', 'TONE', 'OPERATOR-CONTEXT', 'WRAPPER-DOCTRINE', 'MODE-PACK', 'RECONCILE-TAIL']
  check('nulls filtered, order preserved', JSON.stringify(composed) === JSON.stringify(order))
  check('identity precedes the mode pack', composed.indexOf('IDENTITY') !== -1 && composed.indexOf('IDENTITY') < composed.indexOf('MODE-PACK'))
  check('operator context precedes the mode pack', composed.indexOf('OPERATOR-CONTEXT') !== -1 && composed.indexOf('OPERATOR-CONTEXT') < composed.indexOf('MODE-PACK'))
  check('reconcile tail is the LAST word', composed.at(-1) === 'RECONCILE-TAIL')

  // The mid-turn invariant's mechanical anchor: QueryEngine captures the
  // prompt ONCE per query — a single fetchSystemPromptParts call site, before
  // the loop; the tool-use loop never rebuilds it.
  const engine = readFileSync(join(ROOT, 'src/QueryEngine.ts'), 'utf8')
  const captures = engine.match(/fetchSystemPromptParts\(/g) ?? []
  check('QueryEngine captures the system prompt exactly once per query', captures.length === 1, `${captures.length} call sites`)
}

section('§6 — the composed session profile')
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

  const sp = profile.resolveMercurySessionProfile(look)
  check('profile frozen', Object.isFrozen(sp))
  check('identity is the invariant Mercury doctrine', sp.identity === profile.MERCURY_BEHAVIOR_PROFILE)
  check('doctrine names the product', sp.identity.productName === 'Mercury')
  check('doctrine pins candid completion', sp.identity.outcomeLoyalty === 'candid-completion')
  check('changedAt follows the appearance half', sp.changedAt === 222)
}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ session-profile proofs pass')
