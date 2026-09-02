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

export type BehaviourCacheClass = 'stable' | 'session' | 'turn'

export interface BehaviourSection {
  group: BehaviourGroup
  name: string
  scope: BehaviourScope
  owner: string
  cacheClass: BehaviourCacheClass
  text: string
}

export interface BehaviourContract {
  sections: readonly BehaviourSection[]
  digest: string
}

const ANTHROPIC_ONLY_SECTION_NAMES: ReadonlySet<string> = new Set([])

const OPENAI_ONLY_SECTION_NAMES: ReadonlySet<string> = new Set([])

function scopeFor(group: BehaviourGroup, name: string): BehaviourScope {
  if (ANTHROPIC_ONLY_SECTION_NAMES.has(name)) return 'anthropic-only'
  if (OPENAI_ONLY_SECTION_NAMES.has(name)) return 'openai-only'
  void group
  return 'all'
}

const SECTION_OWNERS: ReadonlyMap<string, string> = new Map([
  ['dynamic:memory', 'src/memdir/memdir.ts'],
  ['dynamic:harness_map', 'src/utils/cockpit/harnessMap.ts'],
  ['dynamic:run_protocol', 'src/utils/cockpit/runProtocol.ts'],
  ['dynamic:runtime_posture', 'src/utils/cockpit/runtimePosture.ts'],
  ['dynamic:brief', 'src/tools/BriefTool/prompt.ts'],
  ['wrapper:identity-floor', 'src/prompt/mercuryContract.ts'],
  ['wrapper:mercury-doctrine', 'src/prompt/mercuryContract.ts'],
  ['mode:mode-scribe', 'src/utils/scribe/scribePack.ts'],
  ['mode:mode-implementer', 'src/utils/scribe/implementerPack.ts'],
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


export type ContractRenderFamily = 'anthropic' | 'openai' | 'generic'

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

export function renderAnthropicSections(contract: BehaviourContract): string[] {
  return renderContractSections(contract, 'anthropic')
}

export function renderOpenaiInstructions(contract: BehaviourContract): string {
  return renderContractSections(contract, 'openai').join('\n\n')
}

export function renderGenericInstructions(contract: BehaviourContract): string {
  return renderContractSections(contract, 'generic').join('\n\n')
}


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

export function __resetBehaviourContractRegistryForTest(): void {
  registry.clear()
}


export interface ModePackSection {
  id: string
  kind: string
  text: string
}

export function renderModePackAppend(sections: readonly ModePackSection[]): string {
  return sections
    .filter(section => section.text.trim().length > 0)
    .map(section => `<${section.kind}>\n${section.text}\n</${section.kind}>`)
    .join('\n\n')
}

const WEAKENER_PHRASES: readonly string[] = Object.freeze([
  'skip verification',
  'bypass the gate',
  'ignore the floor',
  'ignore the freeze',
  'you are the fable model',
  'no need to confirm',
])

const NEGATION_CUES: readonly string[] = Object.freeze([
  'never',
  "n't",
  'refus',
  'outrank',
  'binding',
  'even if',
  'cannot',
  'withheld',
  'reject',
  'decline',
])

export function lintWeakeners(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const hay = text.toLowerCase()
  const hits: string[] = []
  for (const phrase of WEAKENER_PHRASES) {
    let from = 0
    let idx: number
    while ((idx = hay.indexOf(phrase, from)) !== -1) {
      from = idx + phrase.length
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
