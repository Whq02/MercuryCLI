#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { writeFileSync } from 'node:fs'

process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

const out = process.env.PICKER_COMPOSE_OUT ?? ''
const probe = process.env.PICKER_COMPOSE_PROBE ?? ''
const started = Date.now()
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getModelOptions, focusedOptionSupports1m, resolvesToExistingOption } = await import('../../src/utils/model/modelOptions.ts')
const model = await import('../../src/utils/model/model.ts')
const { resolveCatalogueSpelling } = await import('../../src/utils/model/modelSpellingFold.ts')

const rows = getModelOptions({ anthropicCredentialed: () => true })
const answer = {
  ms: Date.now() - started,
  rows: rows.filter(row => row.group === undefined && !row.value.startsWith('__')).map(row => ({ value: row.value, label: row.label })),
  probeRows: rows.filter(row => row.value === probe).length,
  parsed: probe === '' ? null : model.parseUserSpecifiedModel(probe),
  spelled: probe === '' ? null : resolveCatalogueSpelling(probe),
  fable51: model.parseUserSpecifiedModel('fable51'),
  engineModel: model.getEngineModel(),
  name: probe === '' ? null : model.renderModelName(probe),
  toggle: probe === '' ? null : focusedOptionSupports1m(probe),
  standsAlone: probe === '' ? null : !resolvesToExistingOption(rows, probe),
}
writeFileSync(out, JSON.stringify(answer))
process.exit(0)
