import type { MemoryType } from '../../../utils/memory/types.js'
import type { InstructionConvention } from '../contracts.js'
import {
  isProjectInstructionExcluded as nativeInstructionExcluded,
  mercuryNativeConvention as nativeConvention,
} from '../nativeSource.js'

export function isProjectInstructionExcluded(filePath: string, type: MemoryType): boolean {
  return nativeInstructionExcluded(filePath, type)
}

export const mercuryNativeConvention: InstructionConvention = nativeConvention
