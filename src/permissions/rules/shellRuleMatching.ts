import type { PermissionUpdate } from './permissions.js'
import { isDestructiveCommandVerb } from './shell-commands/destructiveCommandWarning.js'
import { precedingBackslashCount } from '../../platform/shell/bash/heredoc.js'

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
  | { type: 'exact'; command: string }
  | { type: 'wildcard'; pattern: string }


export function hasWildcards(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && precedingBackslashCount(pattern, i) % 2 === 0) return true
  }
  return false
}

function countUnescapedWildcards(pattern: string): number {
  let count = 0
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && precedingBackslashCount(pattern, i) % 2 === 0) count++
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

function compileWildcardPattern(trimmed: string, caseInsensitive: boolean): RegExp {
  const key = `${caseInsensitive ? 'i' : 's'}:${trimmed}`
  const cached = compiledCache.get(key)
  if (cached !== undefined) return cached

  let marked = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (ch === '\\') {
      const next = trimmed[i + 1]
      if (next === '\\') {
        marked += LITERAL_BACKSLASH
        i++
      } else if (next === '*') {
        marked += LITERAL_STAR
        i++
      } else {
        marked += '\\'
      }
    } else if (ch === '*') {
      marked += WILDCARD_MARK
    } else {
      marked += ch
    }
  }

  const trailingOptional = ` ${WILDCARD_MARK}`
  const hasTrailingOptionalSpace = marked.endsWith(trailingOptional)
  let body = hasTrailingOptionalSpace ? marked.slice(0, -trailingOptional.length) : marked

  const doubleWild = `${WILDCARD_MARK}${WILDCARD_MARK}`
  while (body.includes(doubleWild)) {
    body = body.replaceAll(doubleWild, WILDCARD_MARK)
  }

  let regexSource = body
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll(WILDCARD_MARK, '.*')
    .replaceAll(LITERAL_STAR, '\\*')
    .replaceAll(LITERAL_BACKSLASH, '\\\\')

  if (hasTrailingOptionalSpace) {
    regexSource += '(?: .*)?'
  }

  const compiled = new RegExp(`^${regexSource}$`, caseInsensitive ? 'si' : 's')
  compiledCache.set(key, compiled)
  return compiled
}

export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  return compileWildcardPattern(pattern.trim(), caseInsensitive).test(command)
}

function localAllowUpdate(toolName: string, content: string): PermissionUpdate {
  return {
    type: 'addRules',
    rules: [{ toolName, ruleContent: content }],
    behavior: 'allow',
    destination: 'localSettings',
  }
}

export function suggestionForExactCommand(toolName: string, command: string): PermissionUpdate[] {
  return hasWildcards(command) ? [] : [localAllowUpdate(toolName, command)]
}

export function suggestionForPrefix(toolName: string, prefix: string): PermissionUpdate[] {
  return [localAllowUpdate(toolName, `${prefix} *`)]
}
