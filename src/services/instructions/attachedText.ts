import { sharedRuleFormatOf } from './compositionOrder.js'
import type { InstructionSourceEntry } from './contracts.js'

export function attachedInstructionText(entry: InstructionSourceEntry): string {
  const governed =
    entry.globs !== undefined && sharedRuleFormatOf(entry.convention) !== undefined
      ? `it governs files matching ${entry.globs.join(', ')}`
      : 'it governs its folder'
  return `Instruction file ${entry.path} (${governed}):\n\n${entry.content}`
}
