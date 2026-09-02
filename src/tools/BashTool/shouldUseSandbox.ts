/**
 * Decides whether an approved bash invocation runs inside the OS sandbox,
 * honouring the operator's exclusion list and the policy on unsandboxed
 * overrides.
 *
 * The command splitter is reached through the Mercury-original pinned
 * command-analysis provider, bound lazily at call time because the module
 * graph here is cyclic. The exclusion list is a convenience, not a security
 * boundary (the sandbox prompt is the real control), so its matching may be
 * heuristic.
 */
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

/** Whether to run the command sandboxed. */
export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) return false
  if (input.dangerouslyDisableSandbox && SandboxManager.areUnsandboxedCommandsAllowed()) return false
  if (!input.command) return false
  if (matchesExclusionList(input.command)) return false
  return true
}

/** Whether the command qualifies for exclusion from the sandbox against the
 *  operator's live `sandbox.excludedCommands` list. */
function matchesExclusionList(command: string): boolean {
  return commandQualifiesForExclusion(command, SandboxManager.getExcludedCommands())
}

/**
 * The pure exclusion decision (exported for the prover): does `command`
 * qualify to run OUTSIDE the sandbox against `patterns`?
 *
 * A compound qualifies only when EVERY segment independently qualifies: one
 * non-excluded segment keeps the whole command sandboxed, so
 * `excluded-cmd && curl evil.com` can never run `curl` outside the sandbox.
 * The earlier any-segment quantifier let one matching subcommand carry the
 * entire compound out of the sandbox — an escape (the exclusion list is a
 * convenience, but the sandbox itself is a correctness boundary; ideology
 * law 3 blocks correctness breaks).
 */
export function commandQualifiesForExclusion(
  command: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return false

  // Split into segments so a compound is judged segment by segment. A split
  // failure treats the whole command as one segment.
  let subcommands: string[]
  try {
    subcommands = pinnedCommandAnalysis.splitCommand(command)
  } catch {
    subcommands = [command]
  }

  // Blank segments (a trailing separator, an empty split) carry no command
  // and are ignored; a command with no real segment stays sandboxed rather
  // than vacuously excluded.
  const segments = subcommands.map(raw => raw.trim()).filter(segment => segment.length > 0)
  if (segments.length === 0) return false
  return segments.every(segment => segmentIsExcluded(segment, patterns))
}

/** Whether one command segment matches any exclusion pattern (post-split, so
 *  no segment separators remain inside it). */
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

/** Fixed-point normalisation: strip binary-hijack env assignments and safe wrappers. */
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

/** Match one parsed permission rule against one candidate. */
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
