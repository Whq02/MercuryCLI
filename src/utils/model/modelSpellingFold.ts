// ============================================================================
//  modelSpellingFold — the HUMAN-SPELLING fold at the one normalizer
//  (AGENTDIALS C2, the operator's burned round-trip: "sonnet 5" refused at
//  a coordinator door while the coordinator itself knew claude-sonnet-5).
//
//  ONE derivation, catalogue-owned: a spelling is matched
//  case/whitespace/hyphen/dot-insensitively against the CATALOGUE's row
//  values AND display labels (getModelOptions — the /model picker's own
//  feed, the cross-surface precedent). Provider-equal by construction:
//  "sonnet 5" and "Sonnet-5" resolve exactly where "sonnet5" does, and
//  "gpt 5" resolves in the gpt rows the same way — ZERO hardcoded alias
//  tables, so a family the catalogue does not offer never resolves by
//  spelling. Dots join the fold class because display names spell point
//  releases with dots where ids spell hyphens ("Opus 4.6" must meet
//  claude-opus-4-6).
//
//  NO fuzzy-distance guessing — a wrong model silently launched is worse
//  than a refusal: the match is exact-after-fold only, and a folded key
//  that lands on MORE THAN ONE distinct resolved id answers null (the
//  route law's refusal stands downstream). Row targets resolve through
//  parseUserSpecifiedModelRaw (the alias/retired/pass-through core WITHOUT
//  the catalogue rung), so the fold can never re-enter itself: every
//  catalogue row value is alias-or-declared by construction.
//
//  Reached only through parseUserSpecifiedModel's guarded rung — an input
//  recognizeModelId already recognises (declared family, carrier shape,
//  first-party mark/alias/env pin) never consults this module, so every
//  currently-working spelling stays byte-identical and the hot path pays
//  nothing. model.ts requires this module at call time (the
//  auth/openaiCatalogue idiom) because a static import would cycle through
//  modelOptions back into model.ts.
// ============================================================================
import {
  getModelOptions,
  isProviderActionRow,
  MODES_MODEL_GROUP,
  type ModelOption,
} from './modelOptions.js'
import { normalizeModelStringForAPI, parseUserSpecifiedModelRaw } from './model.js'

/** The fold: lower-cased, with the separator class (whitespace · hyphen ·
 *  dot) removed. Context riders ([1m]/[served]) are the CALLER's to detach
 *  — this fold never touches brackets, so a suffixed spelling stays a
 *  distinct key rather than colliding with its bare twin. */
export function foldModelSpelling(value: string): string {
  return value.toLowerCase().replace(/[\s.-]+/g, '')
}

/** The catalogue rows the fold derives from: real model rows only — the
 *  null Default pseudo-row, the `__…__` mode/action sentinels, the
 *  connect doors and the router MODES group all carry no model identity. */
function foldableRows(catalogue: ModelOption[]): Array<{ value: string; label: string }> {
  const rows: Array<{ value: string; label: string }> = []
  for (const opt of catalogue) {
    if (typeof opt.value !== 'string' || opt.value.length === 0) continue
    if (opt.value.startsWith('__')) continue
    if (isProviderActionRow(opt.value)) continue
    if (opt.group === MODES_MODEL_GROUP) continue
    rows.push({ value: opt.value, label: opt.label })
  }
  return rows
}

/** One row's resolved target: the value with context riders detached,
 *  resolved through the catalogue-free core (recursion-proof). */
function rowTarget(value: string): string {
  return normalizeModelStringForAPI(parseUserSpecifiedModelRaw(normalizeModelStringForAPI(value)))
}

/**
 * Resolve a spelling against the catalogue: the folded input matched
 * against every row's folded value and folded label (both suffix-stripped
 * at build, targets suffix-stripped too — the [1m] twins collapse onto
 * their bare id; the caller's own rider re-attaches outside). Exactly one
 * distinct resolved id answers it; zero or several answer null.
 *
 * `catalogue` is injectable for provers; production passes nothing and
 * reads the live feed.
 */
export function resolveCatalogueSpelling(
  bare: string,
  catalogue: ModelOption[] = getModelOptions(),
): string | null {
  const want = foldModelSpelling(normalizeModelStringForAPI(bare))
  if (want.length === 0) return null
  const hits = new Set<string>()
  for (const row of foldableRows(catalogue)) {
    const target = rowTarget(row.value)
    if (
      foldModelSpelling(normalizeModelStringForAPI(row.value)) === want ||
      foldModelSpelling(normalizeModelStringForAPI(row.label)) === want
    ) {
      hits.add(target)
    }
  }
  if (hits.size !== 1) return null
  return [...hits][0]!
}

/**
 * A few lawful spellings from the SAME derivation, for the unrecognised
 * refusal to name (never a hardcoded family list): the first rows' display
 * labels in the catalogue's own order, distinct by resolved target.
 */
export function catalogueSpellingExamples(
  limit = 3,
  catalogue: ModelOption[] = getModelOptions(),
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of foldableRows(catalogue)) {
    const target = rowTarget(row.value)
    if (seen.has(target)) continue
    seen.add(target)
    out.push(normalizeModelStringForAPI(row.label))
    if (out.length >= limit) break
  }
  return out
}
