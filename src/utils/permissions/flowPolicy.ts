import type { Tool, ToolUseContext } from '../../Tool.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { getDestructiveCommandWarning } from '../../tools/BashTool/destructiveCommandWarning.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { basename, resolve } from 'node:path'
import { pinnedCommandAnalysis } from './decision/commandAnalysis.js'
import { getCwd } from '../cwd.js'
import { hasWildcards, suggestionForExactCommand } from './shellRuleMatching.js'

export const FLOW_AWAY_TIMEOUT_MS = 5 * 60_000
export const FLOW_AWAY_MESSAGE = 'the user is away; continue with an allowed tool call instead'

function flowShellCommands(command: string): Array<{ text: string; words: string[]; opaque: boolean }> {
  const { stripSafeWrappers, stripAllLeadingEnvVars } = require('../../tools/BashTool/bashPermissions.js') as typeof import('../../tools/BashTool/bashPermissions.js')
  const result: Array<{ text: string; words: string[]; opaque: boolean }> = []
  const pending = [command]
  while (pending.length > 0) {
    for (const segment of pinnedCommandAnalysis.splitCommand(pending.pop()!)) {
      const text = stripSafeWrappers(stripAllLeadingEnvVars(segment))
      const parsed = pinnedCommandAnalysis.tryParseShellCommand(text)
      if (!parsed.success) { result.push({ text, words: [], opaque: true }); continue }
      const words = parsed.tokens.filter((token): token is string => typeof token === 'string')
      while (words[0] === 'env' || words[0] === 'command' || /^[A-Za-z_]\w*=/.test(words[0] ?? '')) {
        const wrapper = words.shift()
        if ((wrapper === 'env' || wrapper === 'command') && words[0]?.startsWith('-')) break
      }
      const name = basename(words[0] ?? '').replace(/\.exe$/i, '')
      const opaque = parsed.tokens.length === 0 || typeof parsed.tokens[0] !== 'string' ||
        ['sudo', 'doas', 'env', 'nice', 'timeout', 'time', 'stdbuf', 'nohup', 'command', 'xargs', 'exec', 'eval'].includes(name) || name.startsWith('-') || /[$`]/.test(name)
      const warningWords = [...words]
      warningWords[0] = name
      if (name === 'git') {
        while (warningWords[1]?.startsWith('-')) {
          const option = warningWords.splice(1, 1)[0]!
          if (/^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)$/.test(option)) warningWords.splice(1, 1)
        }
      }
      result.push({ text: warningWords.join(' '), words, opaque })
      if (/^(?:ba|z|da|k|fi)?sh$/.test(name)) {
        const inline = words.findIndex((word, index) => index > 0 && /^-[^-]*c/.test(word))
        if (inline >= 0 && words[inline + 1] !== undefined) pending.push(words[inline + 1]!)
      }
    }
  }
  return result
}

export function flowRequiresFreshApproval(tool: Tool, input: Record<string, unknown>): boolean {
  try {
    return tool.isDestructive?.(input) === true ||
      (tool.name === BASH_TOOL_NAME && typeof input.command === 'string' &&
        flowShellCommands(input.command).some(command => getDestructiveCommandWarning(command.text) !== null))
  } catch {
    return true
  }
}

export function flowPushOrInstall(tool: Tool, input: Record<string, unknown>): boolean {
  if (tool.name !== BASH_TOOL_NAME || typeof input.command !== 'string') return false
  for (const part of flowShellCommands(input.command)) {
    if (part.opaque) return true
    const words = part.words.slice(1)
    let command = basename(part.words[0] ?? '').replace(/\.exe$/i, '')
    if (command === 'git' && words.includes('push')) return true
    if (/^python[\d.]*$/.test(command) && words[0] === '-m' && /^pip[\d.]*$/.test(words[1] ?? '')) {
      command = 'pip'
      words.splice(0, 2)
    }
    if (/^(?:npm|pnpm|yarn|bun|pip[\d.]*|pipx|uv|brew|apt(?:-get)?|cargo|gem|conda|mamba|poetry|pdm|composer|dnf|yum|apk|pacman|zypper)$/.test(command)) {
      if (command === 'yarn' && words.length === 0) return true
      if (words.some(word => /^(?:install|add|i|ci|sync|update|upgrade|reinstall|--sync|-S\w*)$/.test(word))) return true
    }
  }
  return false
}

export function flowUserAllowUpdates(
  tool: Tool,
  input: Record<string, unknown>,
  context: Partial<Pick<ToolUseContext, 'getAppState'>>,
  updates: PermissionUpdate[],
  suggestions: PermissionUpdate[] = [],
): PermissionUpdate[] {
  if (context.getAppState?.().toolPermissionContext.mode !== 'flow') return updates
  if (flowRequiresFreshApproval(tool, input)) return updates.filter(update => update.type === 'removeRules')
  if (updates.length > 0) return updates
  if (tool.name === BASH_TOOL_NAME && typeof input.command === 'string' && flowShellCommands(input.command).some(command => command.opaque)) return []
  if (tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME) {
    const command = input.command
    if (typeof command !== 'string' || command.trim() === '' || hasWildcards(command)) return []
    return suggestionForExactCommand(tool.name, command)
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool.name)) {
    const path = tool.getPath?.(input)
    if (!path || /[!*?\[\]{}\n\r]/.test(path)) return []
    const absolute = resolve(getCwd(), path).replace(/\\/g, '/')
    const drive = /^([A-Za-z]):\/(.*)$/.exec(absolute)
    const content = drive ? `//${drive[1]!.toUpperCase()}/${drive[2]}` : `/${absolute}`
    return [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: tool.name === 'Read' ? 'Read' : 'Edit', ruleContent: content }] }]
  }
  return suggestions.flatMap(update => {
    if (update.type !== 'addRules' || update.behavior !== 'allow') return []
    const rules = update.rules.filter(rule => rule.ruleContent !== undefined && rule.ruleContent.trim() !== '' && !hasWildcards(rule.ruleContent))
    return rules.length === update.rules.length && rules.length > 0
      ? [{ ...update, destination: 'localSettings' as const }]
      : []
  })
}
