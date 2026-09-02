/**
 * Deprecated-model table plus the warning/notice/retired predicates.
 *
 * A model counts as deprecated when it has either a retirement date or a
 * replacement description; entries matching by substring but with neither
 * are skipped and the scan continues. No entry in the table at this
 * snapshot carries a replacement description, so the remap branches are
 * currently unreachable — the branches are kept (the table is data).
 */
import { binaryName } from '../config.js'

type DeprecationEntry = {
  /** Case-insensitive substring of the model ID. */
  match: string
  /** Human model name. */
  name: string
  date: string | null
  /** A replacement description means the model is silently remapped. */
  replacement?: string
}

const DEPRECATION_TABLE: DeprecationEntry[] = [
  {
    match: 'claude-3-opus',
    name: 'Claude 3 Opus',
    date: 'January 5, 2026',
  },
  {
    match: 'claude-3-7-sonnet',
    name: 'Claude 3.7 Sonnet',
    date: 'February 19, 2026',
  },
  {
    match: 'claude-3-5-haiku',
    name: 'Claude 3.5 Haiku',
    date: 'February 19, 2026',
  },
]

/** The entry that deprecates `id`, or null. */
function findDeprecation(id: string): { entry: DeprecationEntry; date: string | null } | null {
  if (!id) return null
  const lowered = id.toLowerCase()
  for (const entry of DEPRECATION_TABLE) {
    if (!lowered.includes(entry.match)) continue
    const date = entry.date
    // Skipped when it has neither a date nor a replacement.
    if (date === null && entry.replacement === undefined) continue
    return { entry, date }
  }
  return null
}

/** Date comparison tolerating an unparseable date (treated as future). */
function isDateInPast(date: string): boolean {
  const parsed = Date.parse(date)
  if (Number.isNaN(parsed)) return false
  return parsed < Date.now()
}

const WARNING_MARKER = '⚠\uFE0E'

/** A warning string. */
export function getModelDeprecationWarning(id: string | null | undefined): string | null {
  if (!id) return null
  const found = findDeprecation(id)
  if (found === null) return null
  if (found.entry.replacement !== undefined) {
    return `${WARNING_MARKER} ${found.entry.name} has been superseded; it now runs as ${found.entry.replacement}.`
  }
  const date = found.date as string
  const tense = isDateInPast(date) ? 'was retired' : 'will be retired'
  return `${WARNING_MARKER} ${found.entry.name} ${tense} on ${date}. Switch to a newer model.`
}

/** A compact notice pair for status lists. */
export function getModelDeprecationAction(
  id: string | null | undefined,
): { message: string; action: string } | null {
  if (!id) return null
  const found = findDeprecation(id)
  if (found === null) return null
  const command = `${binaryName()} /model`
  if (found.entry.replacement !== undefined) {
    return {
      message: `${found.entry.name} now runs as ${found.entry.replacement}.`,
      action: `Run ${command} to change it.`,
    }
  }
  const date = found.date as string
  const tense = isDateInPast(date) ? 'was retired' : 'retires'
  return {
    message: `${found.entry.name} ${tense} ${date}.`,
    action: `Run ${command} to switch.`,
  }
}

/** True for remapped models and for dated models whose (parseable) date is
 *  in the past. */
export function isModelRetired(id: string | null | undefined): boolean {
  if (!id) return false
  const found = findDeprecation(id)
  if (found === null) return false
  if (found.entry.replacement !== undefined) return true
  return found.date !== null && isDateInPast(found.date)
}
