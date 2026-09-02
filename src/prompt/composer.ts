
import { recordPromptComposition } from '../utils/cockpit/promptProvenance.js'
import {
  buildBehaviourContract,
  registerComposedContract,
  renderAnthropicSections,
} from './behaviourContract.js'
import type { NamedSection } from './mercuryContract.js'

export type { NamedSection }

export interface ComposerDynamicSpec {
  name: string
  cacheBreak: boolean
}

export interface PromptParts {
  staticSections: ReadonlyArray<string | null>
  dynamicBoundary: ReadonlyArray<string>
  dynamicSpecs: ReadonlyArray<ComposerDynamicSpec>
  dynamicResolved: ReadonlyArray<string | null>
  wrapperSections: ReadonlyArray<NamedSection>
  modeSections: ReadonlyArray<NamedSection>
  antiSycSections: ReadonlyArray<string>
  reconcileTailSections: ReadonlyArray<string>
}

export function composeSystemPrompt(parts: PromptParts): string[] {
  const contract = buildBehaviourContract(parts)
  registerComposedContract(contract)
  const composed = renderAnthropicSections(contract)

  const absentDynamic = parts.dynamicSpecs
    .map((spec, i) => ({ spec, resolved: parts.dynamicResolved[i] }))
    .filter(x => x.resolved == null)
    .map(x => ({
      name: x.spec.name,
      reason: x.spec.cacheBreak
        ? 'computed null this turn (uncached section)'
        : 'computed null (capability gated off or nothing to say)',
    }))
  recordPromptComposition({ contract, composedSegments: composed, absentDynamic })

  return composed
}
