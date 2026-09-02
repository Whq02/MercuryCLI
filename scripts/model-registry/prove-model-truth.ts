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
import {
  getModelKnowledgeCutoff,
  modelSupportsEffort,
} from '../../src/utils/model/capabilities.js'
import {
  IMPLEMENTER_SEAT_DEFAULTS,
  SCRIBE_SEAT_DEFAULT_MODEL,
  SEAT_ALLOWED_FAMILIES,
  SEAT_MODEL_CYCLE,
} from '../../src/utils/model/seatSlots.js'
import { gatherFrontierFacts, frontierOperatorDecision } from '../../src/utils/model/frontierPolicy.js'
import { classOfModel } from '../../src/utils/router/modelRegistry.js'

for (const k of [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_SCRIBE_MODEL',
  'MERCURY_IMPLEMENTER_MODEL',
  'MERCURY_PARTY_SLOTS',
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

section('1. seat-pin currency — the D-02a pins alarm instead of silently aging')
{
  const expectedFrontierBase = frontierOperatorDecision().candidates[0]!.id.replace(/\[1m\]$/i, '')
  const base = (m: string): string => m.replace(/\[1m\]$/i, '')
  check(
    `the orchestration pin (scribe) base = the frontier winner (${expectedFrontierBase})`,
    base(SCRIBE_SEAT_DEFAULT_MODEL) === expectedFrontierBase,
    `scribe=${SCRIBE_SEAT_DEFAULT_MODEL} — a newer frontier registration landed; re-raise the D-02a seat decision`,
  )
  const executor = IMPLEMENTER_SEAT_DEFAULTS.model
  check(
    `executor pin (${executor}) resolves live with effort support`,
    getMarketingNameForModel(executor) !== undefined && modelSupportsEffort(executor),
  )
  check(
    'every seat default is an allowed seat family',
    [
      IMPLEMENTER_SEAT_DEFAULTS.model,
      SCRIBE_SEAT_DEFAULT_MODEL,
    ].every(m => {
      const resolved = parseUserSpecifiedModel(m)
      return SEAT_ALLOWED_FAMILIES.some(f =>
        resolved.toLowerCase().includes(f.replace('claude-', '')),
      )
    }),
  )
  check(
    'the seat cycle offers only live-resolvable models',
    SEAT_MODEL_CYCLE.every(
      m => getMarketingNameForModel(parseUserSpecifiedModel(m)) !== undefined,
    ),
  )
}

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
  const seatModels = [
    IMPLEMENTER_SEAT_DEFAULTS.model,
    SCRIBE_SEAT_DEFAULT_MODEL,
  ]
  check(
    'every seat default classifies to a router class',
    seatModels.every(m => classOfModel(m) !== undefined),
    seatModels.map(m => `${m}=${classOfModel(m)}`).join(' '),
  )
}

section('7. code-side model default census — literals resolve live, tiers track owners')
{
  const censusFiles = [
    'src/tools/WorkflowTool/workflowRouting.ts',
    'src/daemon/crewSpawn.ts',
  ]
  for (const rel of ['src/utils/scribe/scribePack.ts', 'src/utils/scribe/implementerPack.ts', 'src/components/agents/studio/StudioEditor.tsx']) {
    check(
      `${rel} — carries NO model literal (the seat resolves live)`,
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
  const wf = /WORKFLOW_EXECUTOR_MODEL = '([^']+)'/.exec(
    src('src/tools/WorkflowTool/workflowRouting.ts'),
  )?.[1]
  check(
    `WORKFLOW_EXECUTOR_MODEL (${wf}) = the implementer executor tier`,
    wf === IMPLEMENTER_SEAT_DEFAULTS.model,
  )
  const crewOpus = /opus:\s*\{\s*model:\s*'([^']+)'/.exec(src('src/daemon/crewSpawn.ts'))?.[1]
  check(
    `CREW_MODEL_CHOICES.opus (${crewOpus}) = getDefaultOpusModel()`,
    crewOpus === getDefaultOpusModel(),
  )
  check(
    'the implementer seat default is a live registry model',
    getMarketingNameForModel(parseUserSpecifiedModel(IMPLEMENTER_SEAT_DEFAULTS.model)) !== undefined,
    IMPLEMENTER_SEAT_DEFAULTS.model,
  )
  check(
    'the scribe seat base is a live registry model',
    getMarketingNameForModel(parseUserSpecifiedModel(SCRIBE_SEAT_DEFAULT_MODEL.replace(/\[1m\]$/i, ''))) !== undefined,
    SCRIBE_SEAT_DEFAULT_MODEL,
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
