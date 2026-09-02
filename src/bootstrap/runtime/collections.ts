// ============================================================================
//  src/bootstrap/runtime/collections.ts — the session-collections owner
//
//
//  Scope: SESSION — agent colors, session-only cron tasks, session-created
//  teams, invoked skills. resetStateForTests
//  rebuilds the instance.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports ONLY types. No
//  src/utils value imports. src/bootstrap/state.ts is the ONLY sanctioned
//  importer; every consumer goes through the frozen facade.
// ============================================================================
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'

// One invoked skill's capture — held so compaction can re-inject the skills
// a conversation is still operating under.
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

export class CollectionsOwner {
  // agent name → assigned display color.
  agentColorMap: Map<string, AgentColorName> = new Map()
  // FOLDED from the old STATE record (cut): this cell never had an
  // accessor on the facade — zero readers or writers exist anywhere in src/
  // beyond its initializer. Carried on the color owner, facade-invisible.
  agentColorIndex = 0
  // Teams minted this session via TeamCreate. gracefulShutdown's
  // cleanupSessionTeams() deletes them so subagent-created teams don't
  // accumulate on disk across sessions; TeamDelete drops its entry here so
  // an explicitly deleted team isn't cleaned twice. Lives on this owner
  // (not teamHelpers.ts) so resetStateForTests() clears it between tests.
  sessionCreatedTeams: Set<string> = new Set()
  // Invoked-skill captures for compaction re-injection. Keyed
  // `${agentId ?? ''}:${skillName}` — two agents invoking the same skill
  // must not overwrite each other's capture.
  invokedSkills: Map<string, InvokedSkillInfo> = new Map()

  addInvokedSkill(
    skillName: string,
    skillPath: string,
    content: string,
    agentId: string | null = null,
  ): void {
    const key = `${agentId ?? ''}:${skillName}`
    this.invokedSkills.set(key, {
      skillName,
      skillPath,
      content,
      invokedAt: Date.now(),
      agentId,
    })
  }

  getInvokedSkillsForAgent(
    agentId: string | undefined | null,
  ): Map<string, InvokedSkillInfo> {
    const normalizedId = agentId ?? null
    const filtered = new Map<string, InvokedSkillInfo>()
    for (const [key, skill] of this.invokedSkills) {
      if (skill.agentId === normalizedId) {
        filtered.set(key, skill)
      }
    }
    return filtered
  }

  clearInvokedSkills(preservedAgentIds?: ReadonlySet<string>): void {
    if (!preservedAgentIds || preservedAgentIds.size === 0) {
      this.invokedSkills.clear()
      return
    }
    for (const [key, skill] of this.invokedSkills) {
      if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
        this.invokedSkills.delete(key)
      }
    }
  }

  clearInvokedSkillsForAgent(agentId: string): void {
    for (const [key, skill] of this.invokedSkills) {
      if (skill.agentId === agentId) {
        this.invokedSkills.delete(key)
      }
    }
  }
}
