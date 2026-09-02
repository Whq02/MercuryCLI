// ============================================================================
//  instructions/adapters/index.ts — the ONE runtime adapter over the ONE
//  engine. This is the narrow typed extension point:
//  a later cross-harness adapter registers here and nowhere else. NO
//  AGENTS.md parsing, no speculative adapters. The Claude-family compat
//  adapter is retired — Mercury composes its native
//  convention only.
// ============================================================================
import type {
  InstructionAdapter,
  InstructionConvention,
} from '../contracts.js'
import { mercuryNativeConvention } from './mercuryNative.js'

/** The Mercury runtime adapter: the native contract is the only profile
 *  (the legacy 'auto' input resolves to it
 *  before conventions are consulted). Project scope is Mercury-native
 *  (MERCURY.md sources + the project-home rules dirs); the managed/user
 *  operator layers ride the same convention. There is NO automatic CLAUDE.md
 *  composition — a project without native material composes an empty project
 *  scope. */
export const mercuryAdapter: InstructionAdapter = {
  id: 'mercury',
  conventionsFor(): InstructionConvention[] {
    return [mercuryNativeConvention]
  },
}

export function adapterForProfile(): InstructionAdapter {
  return mercuryAdapter
}
