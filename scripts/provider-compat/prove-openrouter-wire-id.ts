#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.OPENROUTER_API_KEY = 'sk-or-fixture-key'

import {
  __resetOpenrouterCatalogueForTest,
  getOpenrouterModelOptions,
  refreshOpenrouterCatalogue,
} from '../../src/services/providers/openrouter/openrouterCatalogue.ts'
import { openrouterWireModelId } from '../../src/services/providers/openrouter/openrouterCallModel.ts'
import { compatDispatchModelId } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import { focusedOptionSupports1m } from '../../src/utils/model/modelOptions.ts'
import { validateModel } from '../../src/utils/model/validateModel.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const LIVE_IDS = [
  'openai/gpt-5.6-terra',
  'anthropic/claude-opus-5',
  'anthropic/claude-opus-5[1m]',
  'qwen/qwen3-coder',
]

const catalogueFetch: typeof fetch = (async () =>
  new Response(
    JSON.stringify({
      data: LIVE_IDS.map(id => ({ id, name: `Fixture ${id}`, context_length: 200000 })),
      total_count: LIVE_IDS.length,
      links: { next: null },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch

console.log('============================================================')
console.log(' openrouter wire-id composition — the display-string seam')
console.log('============================================================')

__resetOpenrouterCatalogueForTest()
check(
  'W5 no fetched catalogue ⇒ the slug passes through unchanged (no guessing)',
  openrouterWireModelId('openrouter/openai/gpt-5.6-terra[1m]') === 'openai/gpt-5.6-terra[1m]',
  openrouterWireModelId('openrouter/openai/gpt-5.6-terra[1m]'),
)

const snapshot = await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: catalogueFetch })
check('the fixture catalogue landed', snapshot !== null && snapshot.models.length === LIVE_IDS.length, JSON.stringify(snapshot?.models.length))

check(
  'W1 a well-formed qualified id strips to the vendor slug verbatim',
  openrouterWireModelId('openrouter/openai/gpt-5.6-terra') === 'openai/gpt-5.6-terra',
  openrouterWireModelId('openrouter/openai/gpt-5.6-terra'),
)
check(
  'W2 a Mercury context tag on a listed slug peels at the wire',
  openrouterWireModelId('openrouter/openai/gpt-5.6-terra[1m]') === 'openai/gpt-5.6-terra',
  openrouterWireModelId('openrouter/openai/gpt-5.6-terra[1m]'),
)
check(
  "W3 the live 400's exact string heals to the listed slug",
  openrouterWireModelId('openrouter/anthropic/openai/gpt-5.6-terra[1m]') === 'openai/gpt-5.6-terra',
  openrouterWireModelId('openrouter/anthropic/openai/gpt-5.6-terra[1m]'),
)
check(
  'W4 a genuine bracket slug passes verbatim (listed spelling never peeled)',
  openrouterWireModelId('openrouter/anthropic/claude-opus-5[1m]') === 'anthropic/claude-opus-5[1m]',
  openrouterWireModelId('openrouter/anthropic/claude-opus-5[1m]'),
)
check(
  'W8 compatDispatchModelId strips Mercury annotations, keeps the qualified prefix (probe-backed: no live catalogue serves bracket ids; stamps must not re-poison resume)',
  compatDispatchModelId('openrouter/anthropic/claude-opus-5[1m]') === 'openrouter/anthropic/claude-opus-5',
  compatDispatchModelId('openrouter/anthropic/claude-opus-5[1m]'),
)

{
  const rows = getOpenrouterModelOptions(process.env)
  const modelRows = rows.filter(r => typeof r.value === 'string' && r.value.startsWith('openrouter/'))
  check(
    'W6 picker rows are the HEALED catalogue: junk rows heal onto listed twins and collapse, every value a clean listed slug',
    (() => {
      const healed = [...new Set(LIVE_IDS.map(id => id.replace(/\[[^\]]*\]$/, '')))]
      const values = modelRows.map(r => String(r.value).slice('openrouter/'.length)).sort()
      return JSON.stringify(values) === JSON.stringify([...healed].sort()) &&
        values.every(v => !v.includes('['))
    })(),
    JSON.stringify(modelRows.map(r => r.value)),
  )
  check(
    'W6 …and no openrouter row offers the 1M toggle (no tag can join the value)',
    modelRows.every(r => !focusedOptionSupports1m(String(r.value))),
  )
}

{
  const good = await validateModel('openrouter/openai/gpt-5.6-terra')
  check('W7 a listed id validates', good.valid === true, JSON.stringify(good))
  const bad = await validateModel('openrouter/anthropic/openai/gpt-5.6-terra[1m]')
  check(
    'W7 the mangled id is refused with the healed spelling named',
    bad.valid === false && /openrouter\/openai\/gpt-5\.6-terra/.test((bad as { error?: string }).error ?? ''),
    JSON.stringify(bad),
  )
}

console.log(failures === 0 ? '\nprove-openrouter-wire-id: ALL LAWS HOLD' : `\nprove-openrouter-wire-id: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
