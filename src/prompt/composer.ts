/**
 * Mercury's OWNED system-prompt composer.
 *
 * THE ORDER OF THE SYSTEM PROMPT IS A CONTRACT, and this module is where it
 * is written down — one function, one fixed sequence, provenance recorded at
 * the same seam so /provenance can never drift from what was actually
 * composed. prompts.ts builds the PARTS (it owns what each section says);
 * this composer owns HOW they assemble:
 *
 *   1. static sections        — cacheable identity/tone/tool doctrine
 *   2. dynamic boundary       — the global-cache-scope marker (when armed)
 *   3. dynamic sections       — the systemPromptSection registry, resolved
 *   4. contract sections      — the Mercury identity floor + doctrine
 *   5. mode sections          — runtime/role packs (scribe/implementer/party)
 *   6. anti-sycophancy arm    — opt-in always-on arm
 *   7. reconcile tail         — the identity reconcile re-emitted iff 5/6 spliced
 *
 * Since every wrapper/mode section carries a STABLE SEMANTIC NAME
 * (NamedSection) — positional wrapper-N/mode-N ids are absent; the behaviour
 * contract records name, provider scope, owner, and cache class per section.
 *
 * Invariants the proof pins (scripts/prompt/prove-composer.ts):
 *   - group order is exactly the above; nulls are filtered, order preserved;
 *   - the reconcile tail, when present, is the LAST segment (the #9 fix);
 *   - provenance sections equal what was composed.
 */

import { recordPromptComposition } from '../utils/cockpit/promptProvenance.js'
import {
  buildBehaviourContract,
  registerComposedContract,
  renderAnthropicSections,
} from './behaviourContract.js'
import type { NamedSection } from './mercuryContract.js'

export type { NamedSection }

/** The dynamic-registry spec shape the composer needs (structural — matches
 *  constants/systemPromptSections.ts without importing its private type). */
export interface ComposerDynamicSpec {
  name: string
  cacheBreak: boolean
}

export interface PromptParts {
  /** Static, cacheable head sections (nulls dropped, order kept). */
  staticSections: ReadonlyArray<string | null>
  /** The global-cache-scope boundary marker — [] or [marker]. */
  dynamicBoundary: ReadonlyArray<string>
  /** The resolved dynamic registry: specs and their resolved texts, index-aligned. */
  dynamicSpecs: ReadonlyArray<ComposerDynamicSpec>
  dynamicResolved: ReadonlyArray<string | null>
  /** The Mercury contract block (identity floor · doctrine), each section
   *  carrying its stable semantic name. */
  wrapperSections: ReadonlyArray<NamedSection>
  /** Behavioral mode packs (scribe/implementer/party/autopilot/vulcan),
   *  each carrying its stable semantic name. */
  modeSections: ReadonlyArray<NamedSection>
  /** Opt-in anti-sycophancy arm. */
  antiSycSections: ReadonlyArray<string>
  /** The identity-reconcile tail (composed by the caller iff modes/arm spliced). */
  reconcileTailSections: ReadonlyArray<string>
}

/**
 * Compose the final system-prompt segment list and record provenance.
 * Pure over its inputs apart from the provenance side-channel.
 */
export function composeSystemPrompt(parts: PromptParts): string[] {
  // A3: the typed behaviour contract IS the composition —
  // built from the same parts with the same filter+order, registered for the
  // provider renderers, and rendered back as the Anthropic segment list.
  // The one-content law makes every family's render the same content; the
  // registry still resolves the composed content back to its TYPED contract
  // (names, owners, cache classes, digest) for the non-Anthropic joins and
  // the provenance surfaces.
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
