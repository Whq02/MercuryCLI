import {
  getModelOptions,
  isProviderActionRow,
  MODES_MODEL_GROUP,
  type ModelOption,
} from './modelOptions.js'
import { normalizeModelStringForAPI, parseUserSpecifiedModelRaw } from './model.js'

export function foldModelSpelling(value: string): string {
  return value.toLowerCase().replace(/[\s.-]+/g, '')
}

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

function rowTarget(value: string): string {
  return normalizeModelStringForAPI(parseUserSpecifiedModelRaw(normalizeModelStringForAPI(value)))
}

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
