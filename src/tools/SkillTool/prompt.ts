import { memoize } from 'lodash-es'
import { getSkillToolCommands } from '../../commands.js'
import type { Command } from '../../types/command.js'

const SKILL_TOOL_PROMPT =
  'Runs a skill by name, with optional arguments — inline in this conversation, or in a forked crewmate when the skill declares one. The skills on offer ride in system-reminder messages in this conversation; a user\'s "slash command" or "/something" means a skill.'

const promptForRoot = memoize((_cwd: string): Promise<string> => Promise.resolve(SKILL_TOOL_PROMPT))

export function getPrompt(cwd: string): Promise<string> {
  return promptForRoot(cwd)
}

export async function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

export async function getSkillToolInfo(cwd: string): Promise<{ totalCommands: number; includedCommands: number }> {
  const commands = await getSkillToolCommands(cwd)
  return { totalCommands: commands.length, includedCommands: commands.length }
}
