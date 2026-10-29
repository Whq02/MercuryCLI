import * as React from 'react'
import { posix, win32 } from 'node:path'
import { Text } from '../../ink.js'
import { getPlatform } from '../../utils/platform.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { permissionRuleExtractPrefix } from '../../utils/permissions/shellRuleMatching.js'
import type { PermissionUpdate } from '../../types/permissions.js'

type FolderSpelling = 'windows' | 'posix'

function folderSpelling(): FolderSpelling {
  return getPlatform() === 'windows' ? 'windows' : 'posix'
}

export function displayFolderOfRule(cleaned: string, spelling: FolderSpelling = folderSpelling()): string {
  const anchored = cleaned.startsWith('//') ? cleaned.slice(1) : cleaned
  if (spelling !== 'windows') return anchored
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(anchored) ?? /^([A-Za-z]):\/(.*)$/.exec(anchored)
  if (drive === null) return anchored.replace(/\//g, '\\').replace(/\\+$/, '')
  const rest = (drive[2] ?? '').replace(/\//g, '\\').replace(/\\+$/, '')
  return `${(drive[1] as string).toUpperCase()}:\\${rest}`
}

export function folderSeparator(spelling: FolderSpelling = folderSpelling()): string {
  return spelling === 'windows' ? '' : posix.sep
}

function pathDisplayName(path: string): string {
  const name = folderSpelling() === 'windows' ? win32.basename(path) : posix.basename(path)
  return name === '' ? path : name
}

function singlePathDisplay(path: string): string {
  const MAX = 46
  if (path.length <= MAX) return path
  const head = path.slice(0, Math.ceil((MAX - 1) / 2))
  const tail = path.slice(-Math.floor((MAX - 1) / 2))
  return `${head}…${tail}`
}

function formatPathList(rulePaths: string[], namesOnly = false): React.ReactNode {
  const spelling = folderSpelling()
  const paths = rulePaths.map(path => displayFolderOfRule(path, spelling))
  const names = paths.map(pathDisplayName)
  const sep = folderSeparator(spelling)
  if (names.length === 1) {
    return (
      <Text bold>
        {namesOnly ? names[0] : singlePathDisplay(paths[0] as string)}
        {sep}
      </Text>
    )
  }
  if (names.length === 2) {
    return (
      <>
        <Text bold>
          {names[0]}
          {sep}
        </Text>{' '}
        and{' '}
        <Text bold>
          {names[1]}
          {sep}
        </Text>
      </>
    )
  }
  return (
    <>
      <Text bold>
        {names[0]}
        {sep}
      </Text>
      {', '}
      <Text bold>
        {names[1]}
        {sep}
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
        } else if (rule.toolName === 'Edit') {
          if (rule.ruleContent !== undefined) {
            const cleaned = rule.ruleContent.replace(/\/\*\*$/, '').replace(/^\/\//, '/')
            if (cleaned !== '') directories.push(cleaned)
          }
        } else if (rule.toolName === shellToolName) {
          if (rule.ruleContent !== undefined) {
            const prefix = permissionRuleExtractPrefix(rule.ruleContent) ?? rule.ruleContent
            rawCommands.push(commandTransform ? commandTransform(prefix) : prefix)
          }
        }
      }
    }
  }

  const commands = [...new Set(rawCommands)]
  const hasPaths = readPaths.length > 0
  const hasDirs = directories.length > 0
  const hasCommands = commands.length > 0

  if (!hasPaths && !hasDirs && !hasCommands) return null

  if (hasCommands) {
    const cwd = <Text bold>{getFocusedSessionConnector().workspace().originalCwd}</Text>
    if (!hasPaths && !hasDirs) {
      return (
        <>
          Yes, and don&apos;t ask again for {commandsPhrase(commands)} in {cwd}
        </>
      )
    }
    if (directories.length + readPaths.length === 1 && commands.length === 1) {
      return (
        <>
          Yes, and allow {grantPhrase(directories, readPaths)} plus {commandsPhrase(commands)} in{' '}
          {cwd}
        </>
      )
    }
    return (
      <>
        Yes, and allow {grantPhrase(directories, readPaths)} and don&apos;t ask again for{' '}
        {commandsPhrase(commands)} in {cwd}
      </>
    )
  }

  return <>Yes, and allow {grantPhrase(directories, readPaths)} in this project</>
}

function grantPhrase(directories: string[], readPaths: string[]): React.ReactNode {
  if (directories.length > 0 && readPaths.length > 0) {
    return (
      <>
        file edits in {formatPathList(directories, true)} and reading from {formatPathList(readPaths, true)}
      </>
    )
  }
  if (readPaths.length > 0) return <>reading from {formatPathList(readPaths)}</>
  return <>file edits in {formatPathList(directories)}</>
}
