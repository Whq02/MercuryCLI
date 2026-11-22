import type { PermissionUpdate } from '../../types/permissions.js'
import { isDestructiveCommandVerb } from '../shell/destructiveCommandWarning.js'
import { precedingBackslashes } from './permissionRuleParser.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const COMMAND_PREFIX_ARITY: Readonly<Record<string, number>> = {
  git: 2, npm: 2, pnpm: 2, yarn: 2, bun: 2, docker: 2, gh: 2, cargo: 2,
  go: 2, dotnet: 2, pip: 2, pip3: 2, kubectl: 2, terraform: 2,
  python: 2, python3: 2, node: 2, ruby: 2, perl: 2, php: 2, tsx: 2, 'ts-node': 2,
  'npm run': 3, 'pnpm run': 3, 'yarn run': 3, 'bun run': 3,
  'docker compose': 3, 'docker container': 3, 'docker image': 3,
  'gh pr': 3, 'gh issue': 3, 'gh repo': 3, 'gh release': 3, 'gh run': 3,
  aws: 3, az: 3, gcloud: 3, 'gcloud compute instances': 4,
  vssadmin: 2, wbadmin: 2, reg: 2, sc: 2, bcdedit: 2,
}
const UNSCOPED_EXECUTORS = new Set(['sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash', 'cmd', 'powershell', 'pwsh', 'env', 'xargs', 'nice', 'stdbuf', 'nohup', 'timeout', 'time', 'sudo', 'doas', 'pkexec'])

export function knownShellCommandPrefix(command: string): string | null {
  if (/[;&|<>\\\n\r$`*()]/.test(command) || isDestructiveCommandVerb(command)) return null
  const words = command.trim().split(/\s+/)
  const first = words[0] ?? ''
  const isRelativeScript = /^\.[\\/][a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(first) && !/[\\/]{2}/.test(first) && !first.split(/[\\/]/).includes('..')
  const firstLeaf = (first.split(/[\\/]/).pop() ?? '').replace(/\.[a-z0-9]+$/i, '').toLowerCase()
  if ((!isRelativeScript && !/^[a-z][a-z0-9-]*$/.test(first)) || UNSCOPED_EXECUTORS.has(firstLeaf)) return null
  let arity = 1
  let longest = 0
  for (const [prefix, count] of Object.entries(COMMAND_PREFIX_ARITY)) {
    const parts = prefix.split(' ')
    if (parts.length > longest && parts.every((part, index) => words[index] === part)) {
      longest = parts.length
      arity = count
    }
  }
  if (words.length < arity || words.slice(1, arity).some(word => !/^(?:\.[\\/])?[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/.test(word) || /[\\/]{2}/.test(word) || word.split(/[\\/]/).includes('..'))) return null
  return words.slice(0, arity).join(' ')
}

export type ShellPermissionRule =
  Unbuilt


export function hasWildcards(pattern: string): boolean {
  return notBuilt('src/utils/permissions/shellRuleMatching.ts:42')
}

function countUnescapedWildcards(pattern: string): number {
  let count = 0
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && precedingBackslashes(pattern, i) % 2 === 0) count++
  }
  return count
}

export function parsePermissionRule(rule: string): ShellPermissionRule {
  if (hasWildcards(rule)) {
    return { type: 'wildcard', pattern: rule }
  }
  return { type: 'exact', command: rule }
}

export function permissionRuleExtractPrefix(rule: string): string | null {
  if (!rule.endsWith(' *') || countUnescapedWildcards(rule) !== 1) return null
  const prefix = rule.slice(0, -2)
  if (prefix.trim() === '' || prefix.includes('\n')) return null
  return prefix
}

const LITERAL_STAR = '\x00MERCURY_STAR\x00'
const LITERAL_BACKSLASH = '\x00MERCURY_BS\x00'
const WILDCARD_MARK = '\x00MERCURY_WILD\x00'

const compiledCache = new Map<string, RegExp>()

export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive?: boolean,
): boolean {
  return notBuilt('src/utils/permissions/shellRuleMatching.ts:115')
}

function localAllowUpdate(toolName: string, content: string): PermissionUpdate {
  return notBuilt('src/utils/permissions/shellRuleMatching.ts:123')
}

export function suggestionForExactCommand(toolName: string, command: string): PermissionUpdate[] {
  return hasWildcards(command) ? [] : [localAllowUpdate(toolName, command)]
}

export function suggestionForPrefix(toolName: string, prefix: string): PermissionUpdate[] {
  return [localAllowUpdate(toolName, `${prefix} *`)]
}
