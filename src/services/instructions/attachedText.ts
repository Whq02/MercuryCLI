import { sharedRuleFormatOf } from './compositionOrder.js'
import type { InstructionSourceEntry } from './contracts.js'

const OFFERED_RULES_HEAD = 'Rule files offered by description (not loaded; Read one when its description fits the work):'

type AttachedInstruction = { path: string; convention?: string; globs?: string[] }

const attached = new Map<string, AttachedInstruction>()

export function attachedInstructions(): AttachedInstruction[] {
  return [...attached.values()]
}

export function instructionAttached(path: string): boolean {
  return attached.has(path)
}

export function offeredRulesText(pointers: string[]): string {
  return `${OFFERED_RULES_HEAD}\n${pointers.join('\n')}`
}

export function attachedInstructionText(entry: InstructionSourceEntry): string {
  if (entry.offered !== undefined) return offeredRulesText([entry.content])
  const scoped = entry.globs !== undefined && sharedRuleFormatOf(entry.convention) !== undefined
  attached.set(entry.path, { path: entry.path, convention: entry.convention, globs: entry.globs })
  const governed = scoped ? `it governs files matching ${(entry.globs ?? []).join(', ')}` : 'it governs its folder'
  return `Instruction file ${entry.path} (${governed}):\n\n${entry.content}`
}
