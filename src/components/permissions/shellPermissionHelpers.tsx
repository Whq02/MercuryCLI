import * as React from 'react'
import { posix, win32 } from 'node:path'
import { Text } from '../../ink.js'
import { getPlatform } from '../../utils/platform.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { pathInWorkingPath } from '../../utils/permissions/filesystem.js'
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
  if (commands.length === 1) {
    return <Text bold>{commands[0]}</Text>
  }
  if (commands.length === 2) {
    return (
      <>
        <Text bold>{commands[0]}</Text> and <Text bold>{commands[1]}</Text>
      </>
    )
  }
  const init = commands.slice(0, -1).join(', ')
  const last = commands[commands.length - 1]
  return (
    <>
      <Text bold>{init}</Text>, and <Text bold>{last}</Text>
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
  const directories: string[] = []
  const commands: string[] = []

  for (const update of suggestions) {
    if (update.type !== 'addRules') continue
    for (const rule of update.rules) {
      if (!rule.ruleContent?.trim()) continue
      if (rule.toolName === 'Read') {
        const cleaned = rule.ruleContent.replace('/**', '')
        if (cleaned && !readPaths.includes(cleaned)) {
          readPaths.push(cleaned)
        }
      } else if (rule.toolName === 'Edit') {
        const cleaned = rule.ruleContent.replace(/\/\*\*$/, '').replace(/^\/\//, '/')
        if (cleaned && !directories.includes(cleaned)) {
          directories.push(cleaned)
        }
      } else if (rule.toolName === shellToolName) {
        const raw = permissionRuleExtractPrefix(rule.ruleContent) ?? rule.ruleContent
        const cmd = commandTransform ? commandTransform(raw) : raw
        if (cmd && !commands.includes(cmd)) {
          commands.push(cmd)
        }
      }
    }
  }

  const pathCount = directories.length + readPaths.length
  if (pathCount === 0 && commands.length === 0) return null

  const originalCwd = getFocusedSessionConnector().workspace().originalCwd

  if (pathCount === 0) {
    return (
      <>
        Yes, and don&apos;t ask again for {commandsPhrase(commands)} in{' '}
        <Text bold>{originalCwd}</Text>
      </>
    )
  }

  if (commands.length === 0) {
    const spelling = folderSpelling()
    const allInProject = [...directories, ...readPaths].every(folder =>
      pathInWorkingPath(displayFolderOfRule(folder, spelling), originalCwd),
    )
    return (
      <>
        Yes, and allow {grantPhrase(directories, readPaths)}
        {allInProject ? ' in this project' : ''}
      </>
    )
  }

  if (pathCount === 1 && commands.length === 1) {
    return (
      <>
        Yes, and allow {grantPhrase(directories, readPaths)} plus {commandsPhrase(commands)} in{' '}
        <Text bold>{originalCwd}</Text>
      </>
    )
  }

  return (
    <>
      Yes, and allow {grantPhrase(directories, readPaths)} and don&apos;t ask again for{' '}
      {commandsPhrase(commands)} in <Text bold>{originalCwd}</Text>
    </>
  )
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
