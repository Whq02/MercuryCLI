import type { Command } from '../../types/command.js'
import { notBuilt } from '../../pi/holes.js'

export async function getPrompt(cwd: string): Promise<string> {
  return notBuilt('src/tools/SkillTool/prompt.ts:14')
}

export async function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return notBuilt('src/tools/SkillTool/prompt.ts:18')
}

export async function getSkillToolInfo(cwd: string): Promise<{ totalCommands: number; includedCommands: number }> {
  return notBuilt('src/tools/SkillTool/prompt.ts:22')
}
