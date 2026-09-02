import * as React from 'react'
import { basename, sep as platformSep } from 'node:path'
import { Text } from '../../ink.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { permissionRuleExtractPrefix } from '../../utils/permissions/shellRuleMatching.js'
import type { PermissionUpdate } from '../../types/permissions.js'

/** Basename display name, falling back to the whole path when it is empty. */
function pathDisplayName(path: string): string {
  const name = basename(path)
  return name === '' ? path : name
}

/** The SINGLE-directory display (FC-060): the full path, middle-truncated —
 *  a bare basename left the operator unable to tell WHICH directory they
 *  were granting (two candidates can share a basename). Multi-entry lists
 *  keep the compact basenames. */
function singlePathDisplay(path: string): string {
  const MAX = 46
  if (path.length <= MAX) return path
  const head = path.slice(0, Math.ceil((MAX - 1) / 2))
  const tail = path.slice(-Math.floor((MAX - 1) / 2))
  return `${head}…${tail}`
}

/**
 * 1 name: bold + separator. 2: both bold, joined with "and". 3+: the first
 * two, then "and N more" where N counts ALL paths minus two. The trailing
 * separator here is the PLATFORM one (unlike the file dialog's fixed `/`).
 */
function formatPathList(paths: string[]): React.ReactNode {
  const names = paths.map(pathDisplayName)
  if (names.length === 1) {
    return (
      <Text bold>
        {singlePathDisplay(paths[0] as string)}
        {platformSep}
      </Text>
    )
  }
  if (names.length === 2) {
    return (
      <>
        <Text bold>
          {names[0]}
          {platformSep}
        </Text>{' '}
        and{' '}
        <Text bold>
          {names[1]}
          {platformSep}
        </Text>
      </>
    )
  }
  return (
    <>
      <Text bold>
        {names[0]}
        {platformSep}
      </Text>
      {', '}
      <Text bold>
        {names[1]}
        {platformSep}
      </Text>{' '}
      and {paths.length - 2} more
    </>
  )
}

/**
 * 1: bold. 2: "A and B", both bold. 3+: all but the last joined by ", " as a
 * single bold run, then ", and", then the last in bold. When the plain-text
 * ", "-join exceeds 50 characters the whole list collapses to the word
 * "similar" (rendered as "similar commands" by the caller's sentence).
 */
function formatCommandList(commands: string[]): React.ReactNode | 'similar' {
  if (commands.join(', ').length > 50) return 'similar'
  if (commands.length === 1) return <Text bold>{commands[0]}</Text>
  if (commands.length === 2) {
    return (
      <>
        <Text bold>{commands[0]}</Text> and <Text bold>{commands[1]}</Text>
      </>
    )
  }
  return (
    <>
      <Text bold>{commands.slice(0, -1).join(', ')}</Text>, and{' '}
      <Text bold>{commands[commands.length - 1]}</Text>
    </>
  )
}

function commandsPhrase(commands: string[]): React.ReactNode {
  const formatted = formatCommandList(commands)
  if (formatted === 'similar') return <>similar commands</>
  return <>{formatted} commands</>
}

/**
 * Build the human label for a shell "apply these suggestions" option, or
 * return null when the suggestions carry nothing to describe (the caller then
 * shows no always-allow option at all).
 *
 * Collection rules: Read-tool rules become read paths (with the FIRST `/**`
 * occurrence removed anywhere in the string, empty results dropped); rules
 * for the caller's shell tool become commands (reduced to their rule prefix,
 * falling back to the whole content, then passed through the caller's
 * transform, then de-duplicated — dedupe AFTER the transform); directory
 * additions become directories.
 */
export function generateShellSuggestionsLabel(
  suggestions: PermissionUpdate[],
  shellToolName: string,
  commandTransform?: (command: string) => string,
): React.ReactNode | null {
  const readPaths: string[] = []
  const rawCommands: string[] = []
  const directories: string[] = []

  for (const update of suggestions) {
    if (update.type === 'addRules') {
      for (const rule of update.rules) {
        if (rule.toolName === 'Read') {
          if (rule.ruleContent !== undefined) {
            const cleaned = rule.ruleContent.replace('/**', '')
            if (cleaned !== '') readPaths.push(cleaned)
          }
        } else if (rule.toolName === shellToolName) {
          if (rule.ruleContent !== undefined) {
            const prefix = permissionRuleExtractPrefix(rule.ruleContent) ?? rule.ruleContent
            rawCommands.push(commandTransform ? commandTransform(prefix) : prefix)
          }
        }
      }
    } else if (update.type === 'addDirectories') {
      directories.push(...update.directories)
    }
  }

  const commands = [...new Set(rawCommands)]
  const hasPaths = readPaths.length > 0
  const hasDirs = directories.length > 0
  const hasCommands = commands.length > 0

  if (!hasPaths && !hasDirs && !hasCommands) return null

  // Commands present: one affirmative naming the path access (when any) and
  // the commands, scoped to the original working directory (bold).
  if (hasCommands) {
    const cwd = <Text bold>{getFocusedSessionConnector().workspace().originalCwd}</Text>
    const allPaths = [...directories, ...readPaths]
    if (!hasPaths && !hasDirs) {
      return (
        <>
          Yes, and don&apos;t ask again for {commandsPhrase(commands)} in {cwd}
        </>
      )
    }
    if (allPaths.length === 1 && commands.length === 1) {
      // The one-path/one-command sentence reads more naturally than the
      // plural shape, so it is phrased separately.
      return (
        <>
          Yes, and allow access to {formatPathList(allPaths)} plus {commandsPhrase(commands)} in{' '}
          {cwd}
        </>
      )
    }
    return (
      <>
        Yes, and allow access to {formatPathList(allPaths)} and don&apos;t ask again for{' '}
        {commandsPhrase(commands)} in {cwd}
      </>
    )
  }

  // Read paths only: read-oriented phrasing, never generic "access".
  if (hasPaths && !hasDirs) {
    return <>Yes, and allow reading from {formatPathList(readPaths)} in this project</>
  }

  // Directories only, or directories + read paths: generic access phrasing,
  // directories first in the combined list.
  const combined = hasPaths ? [...directories, ...readPaths] : directories
  return <>Yes, and allow access to {formatPathList(combined)} in this project</>
}
