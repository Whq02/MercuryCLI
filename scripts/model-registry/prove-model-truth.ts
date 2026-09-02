#!/usr/bin/env bun
// ============================================================================
//  scripts/model-registry/prove-model-truth.ts
//
//  MODEL-TRUTH ratchet. The two failure classes this
//  proof refuses:
//
//   · STALE COPY — display/prompt facts hand-copied from the owners and
//     left behind at the next launch (a hand FRONTIER_MODEL_NAME two
//     generations old, the currency note missing Opus 5 entirely);
//   · ERA-RELATIVE PINS — defaults that meant "the newest model" at
//     decision time
//     silently aging as the frontier moved.
//
//  This proof pins the repaired laws AND alarms when they age again: the
//  'opus' alias must resolve the current ratified Opus, display strings must
//  DERIVE from owners, and every id the currency note names must resolve
//  live. A red here after a model launch means: re-raise the pin decision,
//  don't ship stale.
//
//  Run: ~/.bun/bin/bun run scripts/model-registry/prove-model-truth.ts
// ============================================================================
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

// ── Ambient-state hygiene: the checks read model/provider/env seams — pin
//    them to the clean firstParty default so the proof never reads the
//    calibration machine (the F6 law). ─────────────────────────────────────
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

// ── 2. The 'opus' tier owner resolves the current Opus ─────────────────────
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

// ── 4. Knowledge cutoffs — recorded-only, absent beats fabricated ──────────
section('4. knowledge cutoffs — recorded-only')
{
  check("Opus 5 cutoff = 'May 2026' (recorded, live-verified)", getModelKnowledgeCutoff('claude-opus-5') === 'May 2026')
  check('Sonnet 5 cutoff stays ABSENT (never fabricated)', getModelKnowledgeCutoff('claude-sonnet-5') === null)
  check("Opus 4.8 raw-id cutoff unchanged ('January 2026')", getModelKnowledgeCutoff('claude-opus-4-8') === 'January 2026')
  check("Fable 5 cutoff unchanged ('January 2026')", getModelKnowledgeCutoff('claude-fable-5') === 'January 2026')
}

// ── 5. The prompt currency copy — the goal state achieved by ABSENCE ───────
//    (evolution, not weakening: this section previously pinned the hardcoded
//    Claude-id list as derived-and-alive; the one-content law replaced the
//    list with the neutral live-catalogue rule, so staleness is now
//    impossible by construction — the pins flip to absence.)
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

// ── 6. Router class mirrors — modelRegistry must mirror anthropic.ts ───────
// (stale-copy hunt: modelRegistry's classForCanonical lost the
//  claude-opus-5 row its anthropic.ts mirror carried, so the DEFAULT executor
//  classified off-family in routing snapshots.)
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

// ── 7. Code-side model defaults — every hardcoded default/pin resolves live ─
// The census the splash class demands: files that carry a literal model
// default OUTSIDE the catalogue owners. Source-extracted (not imported) so
// the proof stays loadable regardless of each owner's import graph. The law
// here is resolves-live, not is-current; the executor-tier pin additionally
// tracks the tier owner.
section('7. code-side model default census — literals resolve live, tiers track owners')
{
  // minerva.ts left this census when its literal pin became a live read —
  // zero literals is its law now. A row here for a file that does not exist
  // is a crash, never a law.
  // workflowRouting.ts left this census the same way (the neutral seat
  // law): the executor route is the neutral seat default's setting — no
  // literal names a model there now, and the route's pin stands below.
  const censusFiles = [
    'src/daemon/crewSpawn.ts',
  ]
  // StudioEditor.tsx left the literal census the same way: the agents face
  // went catalogue-neutral (built-ins model:'inherit'; the model dial and
  // the form derive from getModelOptions — zero family literals is the
  // face's own ratchet in prove-agent-face §9), so zero literals is ITS law
  // now too, pinned below.
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
  // Re-trued (the neutral seat law): the executor route carries NO pinned
  // id — it is the neutral seat default's setting (the most recent
  // sign-in's newest usable row), undefined with no usable sign-in. A
  // pinned first-party id here was the favoured family.
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

// ── 8. Prose surfaces — skills, packs, and living docs name current models ──
// The exact class the splash carried: hand-written display copy in surfaces
// the behavioral checks can't reach (bundled skill prose, deployed skill-pack
// assets, the wiki/matrix). Every gloss must DERIVE-or-agree with the owner.
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
  // (The opus-gloss file list is empty since the superpowers-derived skill
  // pack + assets/superpowers-mercury-pack retirement removed
  // every surface that carried hand-written `opus` glosses; new prose model
  // glosses join a fresh list here if any surface grows one.)
  check(
    'errors.ts refusal suggestion carries no dated hand-pinned id',
    !/claude-sonnet-4-20250514/.test(src('src/services/api/errors.ts')),
  )
  // (there is no separate Doctor screen; the max-output row lives
  // as the certificate's env-limits row, which derives models via the tier
  // owner by construction.)
}

section('9. registry header truth — no future-slot fossil over live adapters (the STALE class)')
{
  // The header once said "only 'anthropic' is available; openai/zai are
  // FUTURE SLOTS that always report unavailable" while ten adapters
  // registered below it. A header sentence about availability must not
  // contradict the import list under it.
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
