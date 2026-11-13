import { sharedRuleFormatOf } from './compositionOrder.js'
import type { InstructionSourceEntry } from './contracts.js'

const OFFERED_RULES_HEAD = 'Rule files offered by description (not loaded; Read one when its description fits the work):'

export function offeredRulesText(pointers: string[]): string {
  return `${OFFERED_RULES_HEAD}\n${pointers.join('\n')}`
}

export function attachedInstructionText(entry: InstructionSourceEntry): string {
  if (entry.offered !== undefined) return offeredRulesText([entry.content])
  const governed =
    entry.globs !== undefined && sharedRuleFormatOf(entry.convention) !== undefined
      ? `it governs files matching ${entry.globs.join(', ')}`
      : 'it governs its folder'
  return `Instruction file ${entry.path} (${governed}):\n\n${entry.content}`
}
