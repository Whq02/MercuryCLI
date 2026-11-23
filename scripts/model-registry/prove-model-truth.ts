#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  getMarketingNameForModel,
  getDefaultOpusModel,
  isDefaultOpusNatively1M,
  parseUserSpecifiedModel,
} from '../../src/models/catalogue/engineModel.js'
import { getModelKnowledgeCutoff } from '../../src/models/facts/capabilities.js'
import { gatherFrontierFacts } from '../../src/models/catalogue/frontierPolicy.js'
import { buildProviderSnapshot, classOfModel } from '../../src/models/roads/modelRegistry.js'
import { SKILL_FILES as BUNDLED_PROVIDER_APIS_FILES } from '../../src/integrations/skills/bundled/provider-apisContent.js'

for (const k of [
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
]) {
  delete process.env[k]
}

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${mark}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const repoRoot = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf-8')

section("2. the 'opus' alias tracks the current Opus through the ratified owners")
{
  check(
    "getDefaultOpusModel() = the ratified static default (Opus 5.5)",
    getDefaultOpusModel() === 'claude-opus-5-5',
    getDefaultOpusModel(),
  )
  check(
    "parseUserSpecifiedModel('opus') resolves the same owner",
    parseUserSpecifiedModel('opus') === getDefaultOpusModel(),
  )
  check(
    'the current Opus is natively 1M — no [1m]-merge suffix anywhere',
    isDefaultOpusNatively1M() &&
      !gatherFrontierFacts().opusFallbackSetting.includes('[1m]'),
    `fallback=${gatherFrontierFacts().opusFallbackSetting}`,
  )
}

section('4. knowledge cutoffs — recorded-only')
{
  check("Opus 5 cutoff = 'May 2026' (recorded, live-verified)", getModelKnowledgeCutoff('claude-opus-5') === 'May 2026')
  check('Sonnet 5 cutoff stays ABSENT (never fabricated)', getModelKnowledgeCutoff('claude-sonnet-5') === null)
  check("Opus 4.8 raw-id cutoff unchanged ('January 2026')", getModelKnowledgeCutoff('claude-opus-4-8') === 'January 2026')
  check("Fable 5 cutoff unchanged ('January 2026')", getModelKnowledgeCutoff('claude-fable-5') === 'January 2026')
}


section('6. router class mirrors — every first-party generation classifies to a router class')
{
  for (const fam of ['claude-opus-4-6', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-fable-5-1']) {
    check(
      `classOfModel('${fam}') is defined`,
      classOfModel(fam) !== undefined,
      'the modelRegistry classForCanonical mirror lost a family row (see providers/anthropic.ts)',
    )
  }
  check(
    "classOfModel(getDefaultOpusModel()) === 'opus'",
    classOfModel(getDefaultOpusModel()) === 'opus',
    String(classOfModel(getDefaultOpusModel())),
  )
}

section('7. code-side model default census — literals resolve live, tiers track owners')
{
  const { foldLegacyWorkerModelKey } = await import('../../src/screen/concourse-model/workerModels.ts')
  const crewOpus = foldLegacyWorkerModelKey('opus')
  check(
    `a crew record's 'opus' (${crewOpus}) folds to getDefaultOpusModel()`,
    crewOpus === getDefaultOpusModel(),
  )
}

section('8. prose surfaces — bundled skills + living docs track the owners')
{
  const catalogue = buildProviderSnapshot().providers.flatMap(provider => provider.description.catalogue)
  const names = [...new Set(catalogue.flatMap(model => [model.id, model.displayLabel, getMarketingNameForModel(model.id)]).filter((name): name is string => typeof name === 'string' && name.length > 0))]
  const fixedRows = (text: string): string[] => text.split('\n').filter(line => {
    const prose = line.replace(/\]\([^)]*\)/g, ']').replace(/`(?:scripts|src)\/[A-Za-z0-9_./-]+`/g, '`path`')
    if (/\b(?:claude|gpt|kimi|moonshot|deepseek|grok|muse|glm|gemini)-[a-z0-9][a-z0-9._-]*/i.test(prose)) return true
    if (!line.trimStart().startsWith('|')) return false
    const cells = prose.split('|').map(cell => cell.replace(/[`*]/g, '').trim())
    return cells.some(cell => names.some(name => cell === name || cell.startsWith(`(${name},`)))
  })
  const files = (directory: string): string[] => readdirSync(join(repoRoot, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
  check('the skill census reads model names from a nonempty catalogue owner', catalogue.length > 0 && names.includes(getDefaultOpusModel()))
  for (const directory of ['mercury-skills/provider-apis', 'src/integrations/skills/bundled/provider-apis']) {
    const tree = files(directory)
    const frozen = tree.flatMap(path => fixedRows(src(path)).map(row => `${path}: ${row}`))
    check(`${directory}: every skill file is free of fixed catalogue rows`, tree.length >= 6 && frozen.length === 0, frozen.join('\n'))
  }
  const externalModelsMd = src('mercury-skills/provider-apis/references/models.md')
  check('mercury-skills/provider-apis: model facts come from the live catalogue reader', externalModelsMd.includes('src/models/roads/catalogueOnDemand.ts') && externalModelsMd.includes('current catalogue') && externalModelsMd.includes('no model inventory'))
  const bundledModelsMd = BUNDLED_PROVIDER_APIS_FILES['references/models.md'] ?? ''
  check('src/integrations/skills/bundled/provider-apis: model facts come from the live catalogue reader', bundledModelsMd.includes('src/models/roads/catalogueOnDemand.ts') && bundledModelsMd.includes('current catalogue') && bundledModelsMd.includes('no model inventory'))
  const sample = catalogue.find(model => model.id === getDefaultOpusModel())!
  check('the census rejects a planted model ID row', fixedRows(`| \`${sample.id}\` | fixture |`).length === 1)
  check('the census rejects a planted marketing-name row', fixedRows(`| ${sample.displayLabel} | fixture |`).length === 1)
  check('the census allows route grammar placeholders', fixedRows('| `openrouter/<vendor>/<model>` | carrier grammar |').length === 0)
}


console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} model-truth check(s) failed`)
  process.exit(1)
}
console.log(' ALL MODEL-TRUTH PROOFS PASS')
