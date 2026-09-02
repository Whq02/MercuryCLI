#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-model-chip.ts — task #11: the standing chrome shows the
//  FRIENDLY model chip ("Fable 5 [1m]"), never the raw id, and the chip form
//  keeps the verbatim [1m] rider (not the long "(1M context)" parenthetical).
//  Exercises the REAL renderModelChip + pins the two chrome mounts + the
//  EffortChip's honest-resolve wiring structurally.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getModelStrings } from '../../src/utils/model/modelStrings.js'
import { renderModelChip } from '../../src/utils/model/model.js'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) fail++
}

console.log('prove-model-chip — friendly chip form on the standing chrome')

const ms = getModelStrings()
const cases: Array<[string, string]> = [
  [ms.opus48 + '[1m]', 'Opus 4.8 [1m]'],
  [ms.opus48, 'Opus 4.8'],
  [ms.fable5 + '[1m]', 'Fable 5 [1m]'],
  [ms.fable5, 'Fable 5'],
  [ms.mythos5, 'Mythos 5'],
  [ms.haiku45, 'Haiku 4.5'],
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-sonnet-5[1m]', 'Sonnet 5 [1m]'],
  ['some-unknown-model', 'some-unknown-model'], // honest raw fallback
]
for (const [id, want] of cases) {
  const got = renderModelChip(id)
  check(`${id} → ${want}`, got === want, `got ${got}`)
}
check('chip form never emits the long parenthetical', !renderModelChip(ms.fable5 + '[1m]').includes('(1M context)'))

// ── chrome mounts (structural: the raw-id class cannot regress silently) ─────
const read = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')
const deck = read('src/components/DeckPane.tsx')
const frame = read('src/components/MercuryFrame.tsx')
// the chip resolves through the ONE display resolver
// (useDisplayedSessionModel.compact — renderModelChip inside), so the raw-id
// class stays impossible AND the label follows the engaged router.
check('DeckPane renders the chip form (the ONE display resolver)', deck.includes('useDisplayedSessionModel().compact'))
check('DeckPane mounts the EffortChip beside the model', (deck.match(/<EffortChip model=\{rawModel\} \/>/g) ?? []).length >= 2)
check('MercuryFrame renders the chip form (the ONE display resolver)', frame.includes('useDisplayedSessionModel().compact'))
check('MercuryFrame mounts the EffortChip beside the model', frame.includes('<EffortChip model={model} />'))

// EffortChip itself: the honest live resolve + the mode word.
const chip = read('src/components/mercury-ui/EffortChip.tsx')
check('EffortChip resolves via getDisplayedEffortLevel (the ONE honest resolve)', chip.includes('getDisplayedEffortLevel(model, effortValue)'))
check('EffortChip subscribes to live AppState (mid-session repaint)', chip.includes('useAppStateMaybeOutsideOfProvider'))
check('EffortChip renders the supercode MODE word conditionally (not a comment match)', /\{supercode && columns >= 100 \? \(/.test(chip))
check('EffortChip is honest-null for effortless models', chip.includes('modelSupportsEffort(model)'))

console.log(fail === 0 ? '\n✅ prove-model-chip: ALL PASS' : `\n❌ prove-model-chip: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
