#!/usr/bin/env bun
import { getPinnedModelIds } from '../../src/models/facts/pinnedModelIds.js'
import { renderModelChip } from '../../src/models/catalogue/engineModel.js'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : ' | to fix: the chip text is made by renderModelChip in src/models/catalogue/engineModel.ts; change its name mapping or suffix handling so the id renders as the wanted chip'}`)
  if (!cond) fail++
}

console.log('prove-model-chip — friendly chip form on the standing chrome')

const ms = getPinnedModelIds()
const cases: Array<[string, string]> = [
  [ms.opus48 + '[1m]', 'Opus 4.8 [1m]'],
  [ms.opus48, 'Opus 4.8'],
  [ms.fable5 + '[1m]', 'Fable 5 [1m]'],
  [ms.fable5, 'Fable 5'],
  [ms.mythos5, 'Mythos 5'],
  [ms.haiku45, 'Haiku 4.5'],
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-sonnet-5[1m]', 'Sonnet 5 [1m]'],
  ['some-unknown-model', 'some-unknown-model'],
]
for (const [id, want] of cases) {
  const got = renderModelChip(id)
  check(`${id} → ${want}`, got === want, `got ${got}`)
}
check('chip form never emits the long parenthetical', !renderModelChip(ms.fable5 + '[1m]').includes('(1M context)'))


console.log(fail === 0 ? '\n✅ prove-model-chip: ALL PASS' : `\n❌ prove-model-chip: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
