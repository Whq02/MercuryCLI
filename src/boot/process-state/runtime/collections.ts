export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

type SkillCapture = [string, InvokedSkillInfo]

function skillKey(agentId: string | null, skillName: string): string {
  return `${agentId ?? ''}:${skillName}`
}

export class CollectionsOwner {
  invokedSkills: Map<string, InvokedSkillInfo> = new Map()

  addInvokedSkill(skillName: string, skillPath: string, content: string, agentId?: string | null): void {
    const owner = agentId ?? null
    this.invokedSkills.set(skillKey(owner, skillName), {
      skillName,
      skillPath,
      content,
      invokedAt: Date.now(),
      agentId: owner,
    })
  }

  private captures(belongs: (skill: InvokedSkillInfo) => boolean): SkillCapture[] {
    const matched: SkillCapture[] = []
    for (const [key, skill] of this.invokedSkills) {
      if (belongs(skill)) matched.push([key, skill])
    }
    return matched
  }

  private forget(belongs: (skill: InvokedSkillInfo) => boolean): void {
    for (const [key] of this.captures(belongs)) {
      this.invokedSkills.delete(key)
    }
  }

  getInvokedSkillsForAgent(agentId: string | undefined | null): Map<string, InvokedSkillInfo> {
    const owner = agentId ?? null
    return new Map(this.captures(skill => skill.agentId === owner))
  }

  clearInvokedSkillsForAgent(agentId: string): void {
    this.forget(skill => skill.agentId === agentId)
  }
}
