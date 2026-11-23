import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionRule } from '../../types/permissions.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from './PermissionResult.js'
import { pinnedCommandAnalysis } from './decision/commandAnalysis.js'
import { getRuleByContentsForToolName } from './decision/rules.js'
import { refusalWithReason, ruleSentence, withRuleReason } from './ruleReason.js'
import { stripComments, stripSafeWrappers } from './safeWrappers.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
  type ShellPermissionRule,
} from './shellRuleMatching.js'

const TOOL_NAME = 'Bash'

export function stripAllLeadingEnvVars(command: string, blocklist?: RegExp): string {
  let previous: string
  let current = command
  do {
    previous = current
    current = stripComments(current)
    const match = current.match(/^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=/)
    if (match) {
      const name = match[1] as string
      if (blocklist && blocklist.test(name)) break
      const consumed = consumeAggressiveAssignment(current)
      if (consumed !== null) current = consumed
    }
  } while (current !== previous)
  return current.trim()
}

function consumeAggressiveAssignment(command: string): string | null {
  const head = command.match(/^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/)
  if (!head) return null
  let i = head[0].length
  const segment = () => {
    if (command[i] === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return false
      i = end + 1
      return true
    }
    if (command[i] === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '$' || command[j] === '`') return false
        if (command[j] === '\\') j++
        j++
      }
      if (command[j] !== '"') return false
      i = j + 1
      return true
    }
    const m = command.slice(i).match(/^[^$`;|&()<>'"\s\\]+/)
    if (!m || m[0].length === 0) return false
    i += m[0].length
    return true
  }
  let advanced = false
  while (i < command.length && !/\s/.test(command[i] as string)) {
    if (!segment()) return advanced ? consumeTrailingWhitespace(command, i) : null
    advanced = true
  }
  return consumeTrailingWhitespace(command, i)
}

function consumeTrailingWhitespace(command: string, i: number): string {
  const ws = command.slice(i).match(/^[ \t]+/)
  return command.slice(i + (ws ? ws[0].length : 0))
}

function withoutRedirections(command: string): string {
  return pinnedCommandAnalysis.extractOutputRedirections(command).commandWithoutRedirections
}

function generateCandidates(command: string, mode: 'exact' | 'prefix', behavior: 'allow' | 'deny' | 'ask'): string[] {
  const trimmed = command.trim()
  const redirStripped = withoutRedirections(trimmed)
  const bases = mode === 'exact' ? [trimmed, redirStripped] : [redirStripped]
  const candidates = new Set<string>()
  for (const base of bases) {
    candidates.add(base)
    const wrapperStripped = stripSafeWrappers(base)
    if (wrapperStripped !== base) candidates.add(wrapperStripped)
  }
  if (behavior === 'deny' || behavior === 'ask') {
    let changed = true
    while (changed) {
      changed = false
      for (const candidate of [...candidates]) {
        for (const derived of [stripAllLeadingEnvVars(candidate), stripSafeWrappers(candidate)]) {
          if (!candidates.has(derived)) {
            candidates.add(derived)
            changed = true
          }
        }
      }
    }
  }
  return [...candidates]
}

function ruleMatches(
  rule: ShellPermissionRule,
  candidate: string,
  mode: 'exact' | 'prefix',
  isCompound: boolean,
  skipCompoundGuard: boolean,
): boolean {
  switch (rule.type) {
    case 'exact':
      return candidate === rule.command
    case 'wildcard':
      if (mode === 'exact') return false
      if (isCompound && !skipCompoundGuard) return false
      return matchWildcardPattern(rule.pattern, candidate)
  }
}

function isCompoundCandidate(candidate: string): boolean {
  return pinnedCommandAnalysis.splitCommand(candidate).length > 1
}

export function matchRules(
  command: string,
  context: ToolPermissionContext,
  behavior: 'allow' | 'deny' | 'ask',
  mode: 'exact' | 'prefix',
  skipCompoundGuard: boolean,
): string | null {
  return walkRules(command, context, behavior, mode, skipCompoundGuard, false)[0] ?? null
}

export function matchAllRules(
  command: string,
  context: ToolPermissionContext,
  behavior: 'allow' | 'deny' | 'ask',
  mode: 'exact' | 'prefix',
  skipCompoundGuard: boolean,
): string[] {
  return walkRules(command, context, behavior, mode, skipCompoundGuard, true)
}

function walkRules(
  command: string,
  context: ToolPermissionContext,
  behavior: 'allow' | 'deny' | 'ask',
  mode: 'exact' | 'prefix',
  skipCompoundGuard: boolean,
  all: boolean,
): string[] {
  const found: string[] = []
  const rulesByContent = getRuleByContentsForToolName(context, TOOL_NAME, behavior)
  if (rulesByContent.size === 0) return found
  const candidates = generateCandidates(command, mode, behavior)
  const alwaysSkip = behavior === 'deny' || behavior === 'ask' || skipCompoundGuard
  const compoundOf = new Map<string, boolean>()
  for (const candidate of candidates) {
    if (!alwaysSkip) compoundOf.set(candidate, isCompoundCandidate(candidate))
  }
  for (const [ruleContent] of rulesByContent) {
    const parsed = parsePermissionRule(ruleContent)
    for (const candidate of candidates) {
      const isCompound = alwaysSkip ? false : compoundOf.get(candidate) ?? false
      if (ruleMatches(parsed, candidate, mode, isCompound, alwaysSkip)) {
        found.push(ruleContent)
        if (!all) return found
        break
      }
    }
  }
  return found
}

export function ruleFor(
  context: ToolPermissionContext,
  ruleContent: string,
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule {
  const rule = getRuleByContentsForToolName(context, TOOL_NAME, behavior).get(ruleContent)
  return rule ?? { source: 'localSettings', ruleBehavior: behavior, ruleValue: { toolName: TOOL_NAME, ruleContent } }
}

export function ruleReason(
  context: ToolPermissionContext,
  ruleContent: string,
  behavior: 'allow' | 'deny' | 'ask',
): PermissionDecisionReason {
  return { type: 'rule', rule: ruleFor(context, ruleContent, behavior) }
}

export function denyByRule(
  context: ToolPermissionContext,
  subject: string,
  ruleContent: string,
  matches: () => string[],
): PermissionResult {
  const said = withRuleReason(context, ruleFor(context, ruleContent, 'deny'), () =>
    matches().map(content => ruleFor(context, content, 'deny')),
  )
  return {
    behavior: 'deny',
    message: refusalWithReason(ruleSentence(subject, 'deny', said), said.ruleValue.reason),
    decisionReason: { type: 'rule', rule: said },
  }
}

export function askByRule(context: ToolPermissionContext, subject: string, ruleContent: string): PermissionResult {
  const rule = ruleFor(context, ruleContent, 'ask')
  return { behavior: 'ask', message: ruleSentence(subject, 'ask', rule), decisionReason: { type: 'rule', rule } }
}

export function readBashRuleVerdict(input: { command: string }, context: ToolPermissionContext): PermissionResult {
  const command = input.command.trim()
  for (const behavior of ['deny', 'ask', 'allow'] as const) {
    const matched = matchRules(command, context, behavior, 'exact', true) ?? matchRules(command, context, behavior, 'prefix', true)
    if (matched === null) continue
    if (behavior === 'deny') return denyByRule(context, command, matched, () => matchAllRules(command, context, 'deny', 'prefix', true))
    if (behavior === 'ask') return askByRule(context, command, matched)
    return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(context, matched, 'allow') }
  }
  return { behavior: 'passthrough', message: 'No Bash rule covers this command.' }
}
