import type {
  InstructionAdapter,
  InstructionConvention,
} from '../contracts.js'
import { mercuryNativeConvention } from './mercuryNative.js'

export const mercuryAdapter: InstructionAdapter = {
  id: 'mercury',
  conventionsFor(): InstructionConvention[] {
    return [mercuryNativeConvention]
  },
}

export function adapterForProfile(): InstructionAdapter {
  return mercuryAdapter
}
