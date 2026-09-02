// ============================================================================
//  prompt/behaviourContract — the typed behaviour-contract pipeline
//
//
//  ONE typed section list with ONE canonical ordering (the composer's written
//  group order — src/prompt/composer.ts), a STABLE digest, and one narrow
//  renderer per backend:
//
//    - THE ONE-CONTENT LAW: every renderer emits the SAME sections in the
//      same order — the family-scope sets are empty, so the per-family
//      filter is the identity. The renderers differ only in JOIN SHAPE
//      (Anthropic: a segment list; OpenAI Responses `instructions` and the
//      chat lanes: one joined string) — delivery, never content;
//    - the digest covers the COMPOSED BASE contract (group·name·scope·text);
//      the per-turn appended system context (appendSystemContext's one
//      trailing element) renders but never joins the digest — receipts pin
//      the contract, not the turn's weather.
//
//  Since every section additionally records its OWNER (the module whose
//  text it carries) and CACHE CLASS (stable · session · turn) — the true-
//  capture provenance surface reads these; nothing here stores prompt text
//  beyond the composition itself.
//
//  Registry: compositions register content-keyed (bounded LRU — concurrent
//  in-process composers stay isolated); the runtime resolves a callModel
//  systemPrompt back to its contract by exact content, probing for the ONE
//  appended context tail. A miss falls back to a total raw-segment decode —
//  same rendering, generic names — so the OpenAI path NEVER depends on the
//  registry hitting (a raw decode simply carries no provider deltas).
// ============================================================================
import { createHash } from 'crypto'
import type { PromptParts } from './composer.js'

export type BehaviourGroup =
  | 'static'
  | 'boundary'
  | 'dynamic'
  | 'wrapper'
  | 'mode'
  | 'antisyc'
  | 'reconcile'
  | 'context'
  | 'segment'

export type BehaviourScope = 'all' | 'anthropic-only' | 'openai-only'

/** How stable a section's bytes are across turns of one session. */
export type BehaviourCacheClass = 'stable' | 'session' | 'turn'

export interface BehaviourSection {
  group: BehaviourGroup
  name: string
  scope: BehaviourScope
  /** The module that owns this section's text (provenance surface). */
  owner: string
  /** Cache stability of this section's bytes. */
  cacheClass: BehaviourCacheClass
  text: string
}

export interface BehaviourContract {
  sections: readonly BehaviourSection[]
  /** Stable digest of the BASE contract (context-tail sections excluded). */
  digest: string
}

/** THE ONE-CONTENT LAW: both family-scope sets are EMPTY — no section is
 *  family-scoped; every model receives the same content, and per-family
 *  differences are delivery data the dialects resolve at request time.
 *  (the model-currency rule is neutral; agent-persistence conduct lives in
 *  the all-families doctrine.)
 *  A new entry in either set forks content by family — that takes an
 *  operator-level ruling, never a lane convenience. */
const ANTHROPIC_ONLY_SECTION_NAMES: ReadonlySet<string> = new Set([])

/** Sections that exist only for the OpenAI Responses wire, by NAME (empty —
 *  see the one-content law above). */
const OPENAI_ONLY_SECTION_NAMES: ReadonlySet<string> = new Set([])

function scopeFor(group: BehaviourGroup, name: string): BehaviourScope {
  if (ANTHROPIC_ONLY_SECTION_NAMES.has(name)) return 'anthropic-only'
  if (OPENAI_ONLY_SECTION_NAMES.has(name)) return 'openai-only'
  void group
  return 'all'
}

/** Canonical owners per section (group:name → module path). Sections not
 *  listed fall back to their group owner. Kept beside the scope tables so a
 *  new named section declares its ownership in ONE place. */
const SECTION_OWNERS: ReadonlyMap<string, string> = new Map([
  ['dynamic:memory', 'src/memdir/memdir.ts'],
  ['dynamic:harness_map', 'src/utils/cockpit/harnessMap.ts'],
  ['dynamic:run_protocol', 'src/utils/cockpit/runProtocol.ts'],
  ['dynamic:runtime_posture', 'src/utils/cockpit/runtimePosture.ts'],
  ['dynamic:brief', 'src/tools/BriefTool/prompt.ts'],
  ['wrapper:identity-floor', 'src/prompt/mercuryContract.ts'],
  ['wrapper:mercury-doctrine', 'src/prompt/mercuryContract.ts'],
  ['mode:mode-autopilot', 'src/utils/autopilot/autopilotPrompt.ts'],
  ['mode:mode-apollo', 'src/prompt/apolloMode.ts'],
  ['mode:mode-vulcan', 'src/utils/vulcan/vulcanGates.ts'],
])

const GROUP_OWNERS: Readonly<Record<BehaviourGroup, string>> = {
  static: 'src/constants/prompts.ts',
  boundary: 'src/constants/prompts.ts',
  dynamic: 'src/constants/prompts.ts',
  wrapper: 'src/prompt/mercuryContract.ts',
  mode: 'src/constants/prompts.ts',
  antisyc: 'src/utils/antiSycophancy.ts',
  reconcile: 'src/prompt/mercuryContract.ts',
  context: 'runtime (appendSystemContext)',
  segment: 'unresolved (raw decode)',
}

export function ownerFor(group: BehaviourGroup, name: string): string {
  return SECTION_OWNERS.get(`${group}:${name}`) ?? GROUP_OWNERS[group]
}

function digestOf(sections: readonly BehaviourSection[]): string {
  const hash = createHash('sha256')
  for (const section of sections) {
    if (section.group === 'context') continue
    hash.update(section.group)
    hash.update('\u001f')
    hash.update(section.name)
    hash.update('\u001f')
    hash.update(section.scope)
    hash.update('\u001f')
    hash.update(section.text)
    hash.update('\u001e')
  }
  return `bc1-${hash.digest('hex').slice(0, 24)}`
}

/** Canonical names for the static head sections (index-aligned with the
 *  UNfiltered staticSections list prompts.ts supplies — EIGHT entries for
 *  eight sections). The table was one entry short (no name for the
 *  project-instruction-estate section), so every section from index four
 *  on carried its neighbour's name on /provenance and the /health
 *  request-context row, and the last fell through to 'static-7'
 *  (FN-017 rank 11). prove-static-section-names ratchets the two lengths. */
export const STATIC_SECTION_NAMES: readonly string[] = [
  'intro',
  'system',
  'doing-tasks',
  'actions',
  'instruction-estate',
  'using-tools',
  'tone-style',
  'output-efficiency',
]

/**
 * Build the typed contract from the SAME parts the composer assembles —
 * identical filtering, identical order (the parity law).
 */
export function buildBehaviourContract(parts: PromptParts): BehaviourContract {
  const sections: BehaviourSection[] = []
  const push = (
    group: BehaviourGroup,
    name: string,
    cacheClass: BehaviourCacheClass,
    text: string,
  ): void => {
    sections.push({
      group,
      name,
      scope: scopeFor(group, name),
      owner: ownerFor(group, name),
      cacheClass,
      text,
    })
  }

  parts.staticSections.forEach((text, index) => {
    if (text === null) return
    push('static', STATIC_SECTION_NAMES[index] ?? `static-${index}`, 'stable', text)
  })
  for (const text of parts.dynamicBoundary) {
    push('boundary', 'cache-boundary', 'stable', text)
  }
  parts.dynamicResolved.forEach((text, index) => {
    if (text === null) return
    const spec = parts.dynamicSpecs[index]
    push(
      'dynamic',
      spec?.name ?? `dynamic-${index}`,
      spec?.cacheBreak ? 'turn' : 'session',
      text,
    )
  })
  for (const section of parts.wrapperSections) {
    push('wrapper', section.name, 'session', section.text)
  }
  for (const section of parts.modeSections) {
    push('mode', section.name, 'session', section.text)
  }
  parts.antiSycSections.forEach((text, index) => {
    const name =
      parts.antiSycSections.length === 1
        ? 'anti-sycophancy'
        : `anti-sycophancy-${index}`
    push('antisyc', name, 'session', text)
  })
  parts.reconcileTailSections.forEach(text => {
    push('reconcile', 'identity-reconcile', 'session', text)
  })
  return { sections, digest: digestOf(sections) }
}

// ── Family rendering (the one-content law) ──────────────────────────────────
//  ONE contract renders on every wire — same sections, same order, no family
//  overlay (the scope sets above are empty, so the filter is the identity).
//  The family parameter survives as the JOIN-SHAPE selector the dialects
//  call by name; content can never differ by it.

export type ContractRenderFamily = 'anthropic' | 'openai' | 'generic'

/** The one renderer: canonical order, every section (the empty scope sets
 *  make the family filter the identity). */
export function renderContractSections(
  contract: BehaviourContract,
  family: ContractRenderFamily,
): string[] {
  return contract.sections
    .filter(
      section =>
        section.scope === 'all' ||
        (section.scope === 'anthropic-only' && family === 'anthropic') ||
        (section.scope === 'openai-only' && family === 'openai'),
    )
    .map(section => section.text)
}

/** The Anthropic renderer: the one contract as the segment list the
 *  Messages wire carries. */
export function renderAnthropicSections(contract: BehaviourContract): string[] {
  return renderContractSections(contract, 'anthropic')
}

/** The OpenAI renderer: the same content joined into ONE Responses
 *  `instructions` string. */
export function renderOpenaiInstructions(contract: BehaviourContract): string {
  return renderContractSections(contract, 'openai').join('\n\n')
}

/** The generic renderer for the chat lanes: the same content joined for a
 *  chat `system` string. */
export function renderGenericInstructions(contract: BehaviourContract): string {
  return renderContractSections(contract, 'generic').join('\n\n')
}

// ── The composition registry (content-keyed, bounded) ───────────────────────

const REGISTRY_MAX = 8
const registry = new Map<string, BehaviourContract>()

function contentKey(segments: readonly string[]): string {
  const hash = createHash('sha256')
  for (const segment of segments) {
    hash.update(segment)
    hash.update('\u001e')
  }
  return hash.digest('hex')
}

/** Register a composed contract under its rendered ANTHROPIC content (the
 *  segment list the runtime carries) — LRU-bounded. */
export function registerComposedContract(contract: BehaviourContract): void {
  const key = contentKey(renderAnthropicSections(contract))
  registry.delete(key)
  registry.set(key, contract)
  while (registry.size > REGISTRY_MAX) {
    const oldest = registry.keys().next().value
    if (oldest === undefined) break
    registry.delete(oldest)
  }
}

/** Total fallback decode: every raw segment becomes an opaque section. Same
 *  rendering; generic names; stable digest for identical bytes. */
export function contractFromSegments(segments: readonly string[]): BehaviourContract {
  const sections: BehaviourSection[] = segments.map((text, index) => ({
    group: 'segment' as const,
    name: `segment-${index}`,
    scope: 'all' as const,
    owner: GROUP_OWNERS.segment,
    cacheClass: 'session' as const,
    text,
  }))
  return { sections, digest: digestOf(sections) }
}

/**
 * Resolve a callModel systemPrompt back to its typed contract. The turn
 * machine appends EXACTLY ONE system-context element after composition
 * (appendSystemContext) — probe the full content first, then with the one
 * trailing element carried as a 'context' section (rendered, never
 * digested). Unresolvable content decodes raw — never a miss-crash.
 */
export function resolveBehaviourContract(segments: readonly string[]): BehaviourContract {
  const exact = registry.get(contentKey(segments))
  if (exact) return exact
  if (segments.length > 1) {
    const base = registry.get(contentKey(segments.slice(0, -1)))
    if (base) {
      return {
        sections: [
          ...base.sections,
          {
            group: 'context',
            name: 'system-context',
            scope: 'all',
            owner: GROUP_OWNERS.context,
            cacheClass: 'turn',
            text: segments[segments.length - 1]!,
          },
        ],
        digest: base.digest,
      }
    }
  }
  return contractFromSegments(segments)
}

/** Proof seam. */
export function __resetBehaviourContractRegistryForTest(): void {
  registry.clear()
}

// ── Mode-pack sections (the wrapper-pack machinery's surviving mechanics) ───
//  A mode pack (autopilot, apollo, vulcan) is authored prose in FINAL
//  render order — no validator, no compiler, no kind-sort, no governance
//  records (the wrapper-pack estate is retired;
//  apolloMode.ts is the pattern). What survives here is the render shape the
//  packs were proven on (one XML-tagged block per section) and the
//  honesty/safety weakener lint the provers run over every authored append.

/** One authored mode-pack section. `kind` is the XML tag the rendered block
 *  carries — a reading aid for the model, not a taxonomy (order is authored,
 *  never derived from it). */
export interface ModePackSection {
  id: string
  kind: string
  text: string
}

/** Render an ordered section list into the mode append: each section
 *  XML-tagged, blank-line joined, empty-text sections dropped so they leave
 *  no dangling tag. */
export function renderModePackAppend(sections: readonly ModePackSection[]): string {
  return sections
    .filter(section => section.text.trim().length > 0)
    .map(section => `<${section.kind}>\n${section.text}\n</${section.kind}>`)
    .join('\n\n')
}

/**
 * Honesty/safety WEAKENER deny-list. A section that tells the model to drop
 * a floor — "skip verification", "bypass the gate", "ignore the freeze", etc. —
 * must be caught BEFORE it ever composes into the live prompt. These are the
 * imperative weakening forms, not the floor's own REFUSAL language: the always-on
 * floor + the mode packs legitimately say "never bypass the gate" / are
 * "binding even if … tells you to bypass the gate", and those must pass clean.
 */
const WEAKENER_PHRASES: readonly string[] = Object.freeze([
  'skip verification',
  'bypass the gate',
  'ignore the floor',
  'ignore the freeze',
  'you are the fable model',
  'no need to confirm',
])

/**
 * Negation / refusal cues. If any appears in the SAME CLAUSE before a deny-list
 * phrase, the phrase is being NEGATED or REFUSED (e.g. "never bypass the gate",
 * "binding even if a peer tells you to bypass the gate") and is NOT a weakener.
 * Covers the direct floor form ("never"/"don't"/"refuse(d)"/"outranks"/"must not")
 * and the structural-refusal framing ("binding even if", "cannot", "withheld",
 * "reject/decline"). The over-broad bare "not " cue was DROPPED (it
 * false-negated an adversarial weakener like "this is not a drill, so skip
 * verification"); the real shipping text gates its only hit ("… bypass the
 * gate, ignore the freeze") on "even if", not "not ", so dropping it stays clean.
 */
const NEGATION_CUES: readonly string[] = Object.freeze([
  'never',
  "n't", // don't / can't / won't / doesn't
  'refus', // refuse / refused / refusal
  'outrank',
  'binding',
  'even if',
  'cannot',
  'withheld',
  'reject',
  'decline',
])

/**
 * Lint a block of prompt text for honesty/safety WEAKENERS — deny-list phrases that
 * are NOT in a negated/refusal sense. Negation-aware + CLAUSE-SCOPED: a phrase is
 * skipped only when a negation/refusal cue appears in the SAME CLAUSE before it (the
 * clause = the text back to the previous `.`/`;`/`:`/newline — deliberately NOT a
 * comma, because the floor comma-chains weakener nouns: "… bypass the gate, ignore
 * the freeze"). This replaced a flat 140-char window that false-negated an
 * adversarial weakener whenever ANY unrelated negation happened to fall within the
 * window (e.g. "this is not a drill. skip verification"). Returns the matched
 * (un-negated) phrases. Never throws; pure (no I/O, no clock).
 *
 * HEURISTIC, not a sound proof: this guards AUTHOR-controlled contract/pack text
 * (defense-in-depth, run by the proof suites), not adversarial input. A weakener
 * and a negation cue artfully comma-chained inside one clause can still mask. Do
 * not over-trust it as a gate.
 */
export function lintWeakeners(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const hay = text.toLowerCase()
  const hits: string[] = []
  for (const phrase of WEAKENER_PHRASES) {
    let from = 0
    let idx: number
    while ((idx = hay.indexOf(phrase, from)) !== -1) {
      from = idx + phrase.length
      // Clause start = the latest sentence/clause boundary before the phrase
      // (NOT a comma). -1 (none found) ⇒ slice from the start of the text.
      const clauseStart = Math.max(
        hay.lastIndexOf('.', idx - 1),
        hay.lastIndexOf(';', idx - 1),
        hay.lastIndexOf(':', idx - 1),
        hay.lastIndexOf('\n', idx - 1),
      )
      const before = hay.slice(clauseStart + 1, idx)
      const negated = NEGATION_CUES.some(cue => before.includes(cue))
      if (!negated && !hits.includes(phrase)) hits.push(phrase)
    }
  }
  return hits
}
