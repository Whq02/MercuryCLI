import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext, processMainOwner } from '../../services/run/resolveOwner.js'

export interface CapsuleState {
  generation: string
  sentSkillNames: Set<string>
  suppressNextSkills: boolean
  lastDate: string | null
}

const states = new Map<string, CapsuleState>()
let resumedMainListing = false

export function capsuleGeneration(messages: readonly Message[] | undefined): string {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages![i]!
    if (message.type === 'system' && message.subtype === 'compact_boundary') return message.uuid
  }
  return 'initial'
}

export function capsuleStateFor(
  context: Pick<ToolUseContext, 'owner' | 'agentId'>,
  messages?: readonly Message[],
): CapsuleState {
  const key = String(ownerFromToolUseContext(context))
  const generation = capsuleGeneration(messages)
  let state = states.get(key)
  if (!state || state.generation !== generation) {
    state = { generation, sentSkillNames: new Set(), suppressNextSkills: false, lastDate: null }
    states.set(key, state)
  }
  if (resumedMainListing && !context.agentId && key === String(processMainOwner())) {
    state.suppressNextSkills = true
    resumedMainListing = false
  }
  return state
}

export function resetCapsuleSkillNames(): void {
  resumedMainListing = false
  for (const state of states.values()) {
    state.sentSkillNames.clear()
    state.suppressNextSkills = false
  }
}

export function suppressCapsuleSkillListing(): void {
  resumedMainListing = true
}
