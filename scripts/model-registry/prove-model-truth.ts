#!/usr/bin/env bun
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  getMarketingNameForModel,
  getDefaultOpusModel,
  isDefaultOpusNatively1M,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
} from '../../src/utils/model/model.js'
import { getModelKnowledgeCutoff } from '../../src/utils/model/capabilities.js'
import { SEAT_ALLOWED_FAMILIES } from '../../src/utils/model/seatSlots.js'
import { gatherFrontierFacts } from '../../src/utils/model/frontierPolicy.js'
import { classOfModel } from '../../src/utils/router/modelRegistry.js'

for (const k of [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_MODEL',
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
    "getDefaultOpusModel() = the ratified static default (Opus 5)",
    getDefaultOpusModel() === 'claude-opus-5',
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
  check(
    'opusplan copy derives from the tier owners',
    renderDefaultModelSetting('opusplan') === 'Opus 5 in strategy mode, else Sonnet 5',
    renderDefaultModelSetting('opusplan'),
  )
}

section('4. knowledge cutoffs — recorded-only')
{
  check("Opus 5 cutoff = 'May 2026' (recorded, live-verified)", getModelKnowledgeCutoff('claude-opus-5') === 'May 2026')
  check('Sonnet 5 cutoff stays ABSENT (never fabricated)', getModelKnowledgeCutoff('claude-sonnet-5') === null)
  check("Opus 4.8 raw-id cutoff unchanged ('January 2026')", getModelKnowledgeCutoff('claude-opus-4-8') === 'January 2026')
  check("Fable 5 cutoff unchanged ('January 2026')", getModelKnowledgeCutoff('claude-fable-5') === 'January 2026')
}

section('5. prompt currency copy (prompts.ts) — no hardcoded vendor list; the neutral rule')
{
  const prompts = src('src/constants/prompts.ts')
  check('the FRONTIER_MODEL_NAME hand const is gone', !/const FRONTIER_MODEL_NAME/.test(prompts))
  check('the CURRENT_MODEL_IDS hand const is gone', !/const CURRENT_MODEL_IDS/.test(prompts))
  check(
    'the currency note hardcodes NO model id (neutral for every vendor)',
    !/MODEL_CURRENCY_NOTE = `[^`]*(claude-|gpt-|glm-|gemini-|deepseek)/.test(prompts),
  )
  check(
    'the neutral live-catalogue rule is the note',
    /MODEL_CURRENCY_NOTE = `Model currency:/.test(prompts) &&
      /catalogue is the source of truth/.test(prompts),
  )
}

section('6. router class mirrors — every seat family classifies to a router class')
{
  for (const fam of SEAT_ALLOWED_FAMILIES) {
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
  const censusFiles = [
    'src/daemon/crewSpawn.ts',
  ]
  for (const rel of ['src/components/agents/studio/StudioEditor.tsx']) {
    check(
      `${rel} — carries NO model literal (the catalogue resolves live)`,
      !/[=:]\s*'claude-[a-z0-9-]+(?:\[1m\])?'/.test(src(rel)),
    )
  }
  for (const rel of censusFiles) {
    const ids = [...src(rel).matchAll(/[=:]\s*'(claude-[a-z0-9-]+(?:\[1m\])?)'/g)].map(
      m => m[1]!,
    )
    const dead = ids.filter(
      id => getMarketingNameForModel(parseUserSpecifiedModel(id)) === undefined,
    )
    check(
      `${rel} — ${ids.length} model literal(s) all resolve live`,
      ids.length > 0 && dead.length === 0,
      dead.length ? `dead: ${dead.join(', ')}` : 'no literals matched — census regex aged',
    )
  }
  const routing = src('src/tools/WorkflowTool/workflowRouting.ts')
  check(
    'the workflow executor route is the neutral seat default (no pinned first-party id)',
    routing.includes('export function workflowExecutorModel(): string | undefined') &&
      routing.includes('neutralSeatDefault()?.setting') &&
      !/WORKFLOW_EXECUTOR_MODEL = '/.test(routing),
  )
  const crewOpus = /opus:\s*\{\s*model:\s*'([^']+)'/.exec(src('src/daemon/crewSpawn.ts'))?.[1]
  check(
    `CREW_MODEL_CHOICES.opus (${crewOpus}) = getDefaultOpusModel()`,
    crewOpus === getDefaultOpusModel(),
  )
}

section('8. prose surfaces — bundled skills + living docs track the owners')
{
  const modelsMd = src('src/skills/bundled/provider-apis/references/models.md')
  for (const [id, marketing] of [
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-opus-5', 'Opus 5'],
  ] as const) {
    check(
      `provider-apis models.md names ${id} + '${marketing}'`,
      modelsMd.includes(id) && modelsMd.includes(marketing),
    )
  }
  check(
    'errors.ts refusal suggestion carries no dated hand-pinned id',
    !/claude-sonnet-4-20250514/.test(src('src/services/api/errors.ts')),
  )
}

section('9. registry header truth — no future-slot fossil over live adapters (the STALE class)')
{
  const registry = src('src/utils/router/modelRegistry.ts')
  check(
    "the registry header no longer claims an only-anthropic world",
    !/FUTURE SLOTS/.test(registry) && !/Today only 'anthropic' is available/.test(registry),
  )
  const importedAdapters = [...registry.matchAll(/import \{ (\w+)ProviderAdapter \}/g)].map(m => m[1]!)
  check(
    `every imported adapter family is named in the header (${importedAdapters.length} adapters)`,
    importedAdapters.length >= 10 &&
      importedAdapters.every(name => registry.slice(0, registry.indexOf('import ')).toLowerCase().includes(name.toLowerCase().replace('compat', 'openai-compat'))),
  )
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} model-truth check(s) failed`)
  process.exit(1)
}
console.log(' ALL MODEL-TRUTH PROOFS PASS')
