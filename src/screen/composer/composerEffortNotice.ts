import { effortLevelToSymbol } from '../widgets/effortIndicator.js'
import { focusedEffortLabelOf } from '../widgets/EffortChip.js'
import {
  convertEffortValueToLevel,
  getDisplayedEffortLevel,
  modelSupportsEffort,
  parseEffortValue,
  type EffortValue,
} from '../../models/effort/effort.js'

type ComposerEffortFacts = {
  model: string
  seatEffort: string | null
  sentEffort: string | null | undefined
  effortValue: EffortValue | undefined
  bornEffort: string | null
}

export function composerEffortLabel(facts: ComposerEffortFacts): string | undefined {
  if (facts.model === '' || !modelSupportsEffort(facts.model)) return undefined
  return focusedEffortLabelOf(facts.model, facts.seatEffort, facts.sentEffort, facts.effortValue, facts.bornEffort, false)
}

export function composerEffortNotice(facts: ComposerEffortFacts): string | undefined {
  const label = composerEffortLabel(facts)
  if (label === undefined) return undefined
  const word = parseEffortValue(label)
  const level = word !== undefined ? convertEffortValueToLevel(word) : getDisplayedEffortLevel(facts.model, undefined)
  return `${effortLevelToSymbol(level)} effort: ${label} · /effort to change`
}
