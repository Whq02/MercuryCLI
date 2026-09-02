import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  BINARY_HIJACK_VARS,
  bashPermissionRule,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './bashPermissions.js'

type SandboxInput = { command?: string; dangerouslyDisableSandbox?: boolean }

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) return false
  if (input.dangerouslyDisableSandbox && SandboxManager.areUnsandboxedCommandsAllowed()) return false
  if (!input.command) return false
  if (matchesExclusionList(input.command)) return false
  return true
}

function matchesExclusionList(command: string): boolean {
  return commandQualifiesForExclusion(command, SandboxManager.getExcludedCommands())
}

export function commandQualifiesForExclusion(
  command: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return false

  let subcommands: string[]
  try {
    subcommands = pinnedCommandAnalysis.splitCommand(command)
  } catch {
    subcommands = [command]
  }

  const segments = subcommands.map(raw => raw.trim()).filter(segment => segment.length > 0)
  if (segments.length === 0) return false
  return segments.every(segment => segmentIsExcluded(segment, patterns))
}

function segmentIsExcluded(segment: string, patterns: readonly string[]): boolean {
  const candidates = buildCandidates(segment)
  for (const pattern of patterns) {
    const rule = bashPermissionRule(pattern)
    for (const candidate of candidates) {
      if (ruleMatchesCandidate(rule, candidate)) return true
    }
  }
  return false
}

function buildCandidates(subcommand: string): string[] {
  const candidates = new Set<string>([subcommand])
  let changed = true
  while (changed) {
    changed = false
    for (const candidate of [...candidates]) {
      for (const derived of [stripAllLeadingEnvVars(candidate, BINARY_HIJACK_VARS), stripSafeWrappers(candidate)]) {
        if (!candidates.has(derived)) {
          candidates.add(derived)
          changed = true
        }
      }
    }
  }
  return [...candidates]
}

function ruleMatchesCandidate(
  rule: { type: 'exact'; command: string } | { type: 'prefix'; prefix: string } | { type: 'wildcard'; pattern: string },
  candidate: string,
): boolean {
  switch (rule.type) {
    case 'exact':
      return candidate === rule.command
    case 'prefix':
      return candidate === rule.prefix || candidate.startsWith(rule.prefix + ' ')
    case 'wildcard':
      return matchWildcardPattern(rule.pattern, candidate)
  }
}
