import * as React from 'react'
import { basename, sep as platformSep } from 'node:path'
import { Text } from '../../ink.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { permissionRuleExtractPrefix } from '../../utils/permissions/shellRuleMatching.js'
import type { PermissionUpdate } from '../../types/permissions.js'

function pathDisplayName(path: string): string {
  const name = basename(path)
  return name === '' ? path : name
}

function singlePathDisplay(path: string): string {
  const MAX = 46
  if (path.length <= MAX) return path
  const head = path.slice(0, Math.ceil((MAX - 1) / 2))
  const tail = path.slice(-Math.floor((MAX - 1) / 2))
  return `${head}…${tail}`
}

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

  if (hasPaths && !hasDirs) {
    return <>Yes, and allow reading from {formatPathList(readPaths)} in this project</>
  }

  const combined = hasPaths ? [...directories, ...readPaths] : directories
  return <>Yes, and allow access to {formatPathList(combined)} in this project</>
}
