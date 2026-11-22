import { truncateToWidth } from '../utils/truncate.js'
import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLoad, usePublish } from '../hooks/effects.js'
import { Box, Text, useInput } from '../ink.js'
import type { SessionListing } from '../types/logs.js'
import { getLogDisplayTitle } from '../utils/log.js'
import { SessionPreview } from './SessionPreview.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useSearchInput } from '../hooks/useSearchInput.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { getSessionId } from '../bootstrap/state.js'
import { getBranch } from '../utils/git.js'
import { getCwd } from '../utils/cwd.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { getWorktreePaths } from '../utils/getWorktreePaths.js'
import { formatLogMetadata } from '../utils/format.js'
import { collapseWhitespace } from '../utils/stringUtils.js'
import {
  isCustomTitleEnabled,
  saveCustomTitle,
} from '../utils/sessionStorage.js'
import { logError } from '../utils/log.js'
import type { UUID } from 'crypto'
import { logSelectorView } from './logSelector/views.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export function commitLogRename(
  target: Pick<SessionListing, 'sessionId' | 'fullPath'>,
  trimmed: string,
  io: {
    save?: typeof saveCustomTitle
    onRenamed: () => void
    onError: (sentence: string | null) => void
  },
): Promise<void> {
  if (trimmed === '' || target.sessionId === undefined) return Promise.resolve()
  io.onError(null)
  return (io.save ?? saveCustomTitle)(target.sessionId as UUID, trimmed, target.fullPath)
    .then(() => {
      io.onRenamed()
    })
    .catch(error => {
      logError(error)
      io.onError(
        `Could not rename session (${error instanceof Error ? error.message : String(error)}) — press ctrl+r to try again`,
      )
    })
}

type LogSelectorProps = Unbuilt

const MIN_LABEL_WIDTH = 8

function displayTitle(log: SessionListing): string {
  return collapseWhitespace(getLogDisplayTitle(log, '(no prompt)'))
}

function prDescriptor(log: SessionListing): string {
  if (log.prNumber === undefined) return ''
  return `#${log.prNumber}${log.prRepository ? ` ${log.prRepository}` : ''}`
}

function truncateLabel(text: string, width: number): string {
  return truncateToWidth(text, Math.max(MIN_LABEL_WIDTH, width))
}

function hasMeaningfulEntry(log: SessionListing): boolean {
  if (log.sessionId !== undefined && log.sessionId === getSessionId()) {
    return true
  }
  if (log.customTitle) return true
  if (log.firstPrompt && log.firstPrompt.trim() !== '') return true
  return log.messages.some(
    message =>
      (message as { type?: string }).type === 'user' &&
      typeof (message as { message?: { content?: unknown } }).message
        ?.content === 'string',
  )
}

function describeLog(log: SessionListing, withProjectPath: boolean): string {
  const base = formatLogMetadata(log)
  return withProjectPath && log.projectPath ? `${base} · ${log.projectPath}` : base
}

function describeLogFitted(log: SessionListing, withProjectPath: boolean, width: number): string {
  return truncateToWidth(describeLog(log, withProjectPath), Math.max(MIN_LABEL_WIDTH, width))
}

export function LogSelector(arg0: LogSelectorProps): React.ReactNode {
  return notBuilt('src/components/LogSelector.tsx:110')
}

export default LogSelector
