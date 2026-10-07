import type { Tool, Tools } from '../../Tool.js'
import { cutPart, describeBashNotReadOnly, type NotReadOnly } from '../BashTool/readOnlyValidation.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '../ExitWorktreeTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { SKILL_TOOL_NAME } from '../SkillTool/constants.js'
import { AGENT_TOOL_NAME, MERCURY_SCOUT_AGENT_TYPE } from './constants.js'

export const SCOUT_SHELL_REFUSAL_TAIL = 'Read-only commands do run here, with pipes, 2>&1 and input redirects (< file) — for example wc, grep, head, tail and sort — and Read, Grep and Glob read files.'

export function scoutShellRefusal(reason: NotReadOnly): string {
  const stem = `${MERCURY_SCOUT_AGENT_TYPE} is read-only:`
  const sentence = (): string => {
    switch (reason.kind) {
      case 'not-on-list':
        return `\`${reason.word}\` is not a command Mercury can verify as read-only, so no form of it runs in this shell.`
      case 'form':
        return `\`${reason.part}\` is not a read-only form of \`${reason.word}\`, so it does not run in this shell.`
      case 'writes':
        return `the command writes to \`${reason.target}\`, so it does not run in this shell.`
      case 'screen':
        return `the command could not be verified as read-only — ${reason.detail ?? ''}`
      case 'unparseable':
        return 'the command could not be parsed, so it cannot be verified as read-only.'
      case 'sandbox':
        return 'a shell call that leaves the sandbox or carries a simulated sed edit does not run here.'
      case 'git-guard':
        return `${(reason.detail ?? '').replace(/\.$/, '')}.`
    }
  }
  return `${stem} ${sentence()} ${SCOUT_SHELL_REFUSAL_TAIL}`
}

export const SCOUT_TOOLS_DESCRIPTION = 'read-only — Read, Glob, Grep, a read-only shell, and every other tool only in the form that reads'

const SCOUT_DENIED_TOOLS: ReadonlySet<string> = new Set([AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME, ENTER_WORKTREE_TOOL_NAME, EXIT_WORKTREE_TOOL_NAME])

export function scoutToolRefusal(toolName: string): string {
  return `${MERCURY_SCOUT_AGENT_TYPE} is read-only: ${toolName} would write or change state here, so the call is refused.`
}

function readsOnly(tool: Tool, input: Record<string, unknown>): boolean {
  try {
    return tool.isReadOnly(input as never) === true
  } catch {
    return false
  }
}

function shellNotReadOnly(input: Record<string, unknown>): NotReadOnly {
  const command = typeof input.command === 'string' ? input.command : ''
  const part = cutPart(command)
  try {
    return describeBashNotReadOnly(command) ?? { kind: 'screen', part, detail: 'the shell tool did not classify it as read-only.' }
  } catch {
    return { kind: 'unparseable', part }
  }
}

export function scoutRefusal(tool: Tool, input: Record<string, unknown>): string | null {
  if (SCOUT_DENIED_TOOLS.has(tool.name)) return scoutToolRefusal(tool.name)
  if (tool.name === BASH_TOOL_NAME) {
    if (input._simulatedSedEdit !== undefined || input.dangerouslyDisableSandbox === true) {
      return scoutShellRefusal({ kind: 'sandbox', part: cutPart(typeof input.command === 'string' ? input.command : '') })
    }
    return readsOnly(tool, input) ? null : scoutShellRefusal(shellNotReadOnly(input))
  }
  if (tool.name === SKILL_TOOL_NAME) return null
  return readsOnly(tool, input) ? null : scoutToolRefusal(tool.name)
}

export function scoutOffersTool(tool: Tool): boolean {
  if (SCOUT_DENIED_TOOLS.has(tool.name)) return false
  if (tool.name === BASH_TOOL_NAME || tool.name === SKILL_TOOL_NAME) return true
  return readsOnly(tool, {})
}

export function restrictScoutTools(tools: Tools): Tools {
  return tools.filter(scoutOffersTool).map(tool => ({
    ...tool,
    async call(...args: Parameters<Tool['call']>) {
      const refusal = scoutRefusal(tool, args[0])
      if (refusal !== null) throw new Error(refusal)
      return tool.call(...args)
    },
  }))
}
