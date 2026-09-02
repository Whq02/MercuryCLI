
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { useEffect, useRef, useState } from 'react'
import type { ToolUseContext } from '../Tool.js'
import type { FileEdit } from '../tools/FileEditTool/types.js'
import type { PermissionOption } from '../components/permissions/FilePermissionDialog/permissionOptions.js'
import { callIdeRpc } from '../services/mcp/client.js'
import {
  getConnectedIdeClient,
  getIdeClientName,
  hasAccessToIDEExtensionDiffFeature,
} from '../utils/ide.js'
import { WindowsToWSLConverter } from '../utils/idePathConversion.js'
import { applyEditToFile } from '../tools/FileEditTool/utils.js'
import { getPatchFromContents } from '../utils/diff.js'
import { expandPath } from '../utils/path.js'
import { getGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { logForDebugging } from '../utils/debug.js'

const GENERIC_IDE_LABEL = 'IDE'
const DISCRIMINATOR_LENGTH = 6

function recomputeEdits(
  filePath: string,
  oldContent: string,
  newContent: string,
  editMode: 'single' | 'multiple',
): FileEdit[] {
  if (oldContent === newContent) return []
  const hunks = getPatchFromContents({
    filePath,
    oldContent,
    newContent,
    singleHunk: editMode === 'single',
  })
  if (hunks.length === 0) return []
  if (editMode === 'single' && hunks.length > 1) {
    logError(
      new Error(
        `expected a single hunk recomputing IDE edits for ${filePath}, got ${hunks.length}`,
      ),
    )
  }
  const edits: FileEdit[] = []
  for (const hunk of hunks) {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk.lines) {
      const body = line.slice(1)
      if (line.startsWith('-')) oldLines.push(body)
      else if (line.startsWith('+')) newLines.push(body)
      else {
        oldLines.push(body)
        newLines.push(body)
      }
    }
    const oldText = oldLines.join('\n')
    const newText = newLines.join('\n')
    if (oldText === newText) continue
    edits.push({ old_string: oldText, new_string: newText, replace_all: false })
  }
  return edits
}

export function useDiffInIDE({
  onChange,
  toolUseContext,
  filePath,
  edits,
  editMode,
}: {
  onChange: (
    option: PermissionOption,
    changed: { file_path: string; edits: FileEdit[] },
  ) => void
  toolUseContext: ToolUseContext
  filePath: string
  edits: FileEdit[]
  editMode: 'single' | 'multiple'
}): {
  closeTabInIDE: () => Promise<void>
  showingDiffInIDE: boolean
  ideName: string
  hasError: boolean
} {
  const mcpClients = toolUseContext.options.mcpClients
  const ideClient = getConnectedIdeClient(mcpClients)
  const ideName = getIdeClientName(ideClient) ?? GENERIC_IDE_LABEL

  const [showingDiffInIDE, setShowingDiffInIDE] = useState(false)
  const [hasError, setHasError] = useState(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const unmountedRef = useRef(false)
  const cleanupRef = useRef<() => Promise<void>>(async () => {})

  const tabNameRef = useRef(
    `[Mercury] ${basename(filePath)} (${randomUUID().replace(/-/g, '').slice(0, DISCRIMINATOR_LENGTH)})`,
  )

  const eligible =
    ideClient !== undefined &&
    hasAccessToIDEExtensionDiffFeature(mcpClients) &&
    getGlobalConfig().diffTool === 'auto' &&
    !filePath.endsWith('.ipynb') &&
    filePath !== ''

  useEffect(() => {
    unmountedRef.current = false
    if (!eligible || !ideClient) return

    let closed = false
    const closeTab = async (): Promise<void> => {
      if (closed) return
      closed = true
      abortSignal?.removeEventListener('abort', onAbort)
      process.off('exit', onExitSync)
      try {
        await callIdeRpc('close_tab', { tab_name: tabNameRef.current }, ideClient)
      } catch (error) {
        logForDebugging(`ide: close_tab failed: ${String(error)}`)
      }
    }
    cleanupRef.current = closeTab

    const abortSignal = toolUseContext.abortController.signal
    const onAbort = (): void => {
      void closeTab()
    }
    const onExitSync = (): void => {
      void closeTab()
    }
    abortSignal.addEventListener('abort', onAbort)
    process.on('exit', onExitSync)

    void (async () => {
      try {
        const expanded = expandPath(filePath)
        let oldContent: string
        try {
          oldContent = readFileSync(expanded, 'utf-8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          oldContent = ''
        }
        let newContent = oldContent
        for (const edit of edits) {
          newContent = applyEditToFile(
            newContent,
            edit.old_string,
            edit.new_string,
            edit.replace_all,
          )
        }

        const config = ideClient.config as { ideRunningInWindows?: boolean }
        const distro = process.env.WSL_DISTRO_NAME
        const idePath =
          config.ideRunningInWindows && distro
            ? new WindowsToWSLConverter(distro).toIDEPath(expanded)
            : expanded

        setShowingDiffInIDE(true)
        const result = await callIdeRpc(
          'openDiff',
          {
            old_file_path: idePath,
            new_file_path: idePath,
            new_file_contents: newContent,
            tab_name: tabNameRef.current,
          },
          ideClient,
        )
        if (unmountedRef.current) return

        const blocks = Array.isArray(result) ? result : undefined
        const first = blocks?.[0] as { type?: string; text?: string } | undefined
        const sentinel = first?.type === 'text' ? first.text : undefined
        let resolvedContent: string
        if (sentinel === 'FILE_SAVED') {
          const second = blocks?.[1] as { type?: string; text?: string } | undefined
          resolvedContent = second?.text ?? newContent
        } else if (sentinel === 'TAB_CLOSED') {
          resolvedContent = newContent
        } else if (sentinel === 'DIFF_REJECTED') {
          resolvedContent = oldContent
        } else {
          throw new Error(`unexpected openDiff result (the ${ideName} may have exited)`)
        }

        const recomputed = recomputeEdits(expanded, oldContent, resolvedContent, editMode)
        if (unmountedRef.current) return
        if (recomputed.length === 0) {
          await closeTab()
          onChangeRef.current({ type: 'reject' }, { file_path: filePath, edits })
          return
        }
        await closeTab()
        onChangeRef.current(
          { type: 'accept-once' },
          { file_path: filePath, edits: recomputed },
        )
      } catch (error) {
        if (!unmountedRef.current) {
          logError(error)
          setHasError(true)
          setShowingDiffInIDE(false)
        }
        void closeTab()
      }
    })()

    return () => {
      unmountedRef.current = true
      void closeTab()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, ideClient])

  return {
    closeTabInIDE: () => cleanupRef.current(),
    showingDiffInIDE: showingDiffInIDE && !hasError,
    ideName,
    hasError,
  }
}
