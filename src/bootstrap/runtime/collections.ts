import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export type InvokedSkillInfo = Unbuilt

type SkillCapture = Unbuilt

export class CollectionsOwner {
  invokedSkills: Map<string, InvokedSkillInfo> = unbuilt('src/bootstrap/runtime/collections.ts:14')

  addInvokedSkill(skillName: string, skillPath: string, content: string, agentId?: string | null): void {
    return notBuilt('src/bootstrap/runtime/collections.ts:16')
  }

  private captures(belongs: (skill: InvokedSkillInfo) => boolean): SkillCapture[] {
    return notBuilt('src/bootstrap/runtime/collections.ts:20')
  }

  private forget(belongs: (skill: InvokedSkillInfo) => boolean): void {
    return notBuilt('src/bootstrap/runtime/collections.ts:24')
  }

  getInvokedSkillsForAgent(agentId: string | undefined | null): Map<string, InvokedSkillInfo> {
    return notBuilt('src/bootstrap/runtime/collections.ts:28')
  }

  clearInvokedSkillsForAgent(agentId: string): void {
    return notBuilt('src/bootstrap/runtime/collections.ts:33')
  }
}
