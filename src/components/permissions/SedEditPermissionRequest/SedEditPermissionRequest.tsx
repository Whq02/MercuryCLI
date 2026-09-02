import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { promises as fs } from 'node:fs'
import { basename, relative } from 'node:path'
import { Text } from '../../../ink.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { isENOENT } from '../../../utils/errors.js'
import { detectEncodingForResolvedPath } from '../../../utils/fileRead.js'
import {
  applySedSubstitution,
  type SedEditInfo,
} from '../../../tools/BashTool/sedEditParser.js'
import { ConsentFileEditDiff } from '../ConsentFileEditDiff.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import type { ToolInput } from '../FilePermissionDialog/permissionOptions.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type LoadedFile = { exists: boolean; content: string }

/**
 * Presents an in-place `sed` substitution as a file-edit consent card. The
 * approved input is the Bash input plus the `_simulatedSedEdit` annotation
 * ({ filePath, newContent }) the executor turns into a real write.
 */
export function SedEditPermissionRequest({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  workerBadge,
  sedEditInfo,
}: PermissionRequestProps & { sedEditInfo: SedEditInfo }): React.ReactNode {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)

  // One read per target, asynchronous, with encoding detection and CRLF
  // normalised to LF. ENOENT means "does not exist" with empty content; any
  // other error propagates.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const encoding = detectEncodingForResolvedPath(sedEditInfo.filePath)
        const raw = await fs.readFile(sedEditInfo.filePath, encoding)
        if (!cancelled) setLoaded({ exists: true, content: raw.replaceAll('\r\n', '\n') })
      } catch (error) {
        if (cancelled) return
        if (isENOENT(error)) setLoaded({ exists: false, content: '' })
        else setLoadError(error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sedEditInfo.filePath])
  if (loadError) throw loadError

  const oldContent = loaded?.content ?? ''
  const newContent = useMemo(
    () => (loaded === null ? '' : applySedSubstitution(oldContent, sedEditInfo)),
    [loaded, oldContent, sedEditInfo],
  )
  const isNoOp = loaded !== null && oldContent === newContent

  const parseInput = useCallback(
    (input: unknown): ToolInput => ({
      ...(input as ToolInput),
      _simulatedSedEdit: { filePath: sedEditInfo.filePath, newContent },
    }),
    [sedEditInfo.filePath, newContent],
  )

  return (
    <FilePermissionDialog<ToolInput>
      toolUseConfirm={toolUseConfirm}
      toolUseContext={toolUseContext}
      onDone={onDone}
      onReject={onReject}
      title="Edit file"
      subtitle={relative(getFocusedSessionConnector().workspace().cwd, sedEditInfo.filePath)}
      question={
        <Text bold>
          Do you want to edit <Text bold>{basename(sedEditInfo.filePath)}</Text>?
        </Text>
      }
      content={
        loaded === null ? null : isNoOp ? (
          <Text dimColor>
            {loaded.exists
              ? 'The pattern did not match any content'
              : 'The file does not exist'}
          </Text>
        ) : (
          <ConsentFileEditDiff
            file_path={sedEditInfo.filePath}
            edits={[{ old_string: oldContent, new_string: newContent, replace_all: false }]}
          />
        )
      }
      completionType="str_replace_single"
      path={sedEditInfo.filePath}
      parseInput={parseInput}
      workerBadge={workerBadge}
    />
  )
}
