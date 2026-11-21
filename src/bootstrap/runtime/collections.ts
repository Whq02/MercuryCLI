export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

type SkillCapture = [key: string, skill: InvokedSkillInfo]

const captureKey = (agentId: string | null, skillName: string): string => `${agentId ?? ''}:${skillName}`

export class CollectionsOwner {
  invokedSkills: Map<string, InvokedSkillInfo> = new Map()

  addInvokedSkill(skillName: string, skillPath: string, content: string, agentId: string | null = null): void {
    this.invokedSkills.set(captureKey(agentId, skillName), { skillName, skillPath, content, invokedAt: Date.now(), agentId })
  }

  private captures(belongs: (skill: InvokedSkillInfo) => boolean): SkillCapture[] {
    return [...this.invokedSkills].filter(([, skill]) => belongs(skill))
  }

  private forget(belongs: (skill: InvokedSkillInfo) => boolean): void {
    for (const [key] of this.captures(belongs)) this.invokedSkills.delete(key)
  }

  getInvokedSkillsForAgent(agentId: string | undefined | null): Map<string, InvokedSkillInfo> {
    const owner = agentId ?? null
    return new Map(this.captures(skill => skill.agentId === owner))
  }

  clearInvokedSkillsForAgent(agentId: string): void {
    this.forget(skill => skill.agentId === agentId)
  }
}
