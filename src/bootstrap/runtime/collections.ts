import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'

export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

export class CollectionsOwner {
  agentColorMap: Map<string, AgentColorName> = new Map()
  agentColorIndex = 0
  sessionCreatedTeams: Set<string> = new Set()
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
