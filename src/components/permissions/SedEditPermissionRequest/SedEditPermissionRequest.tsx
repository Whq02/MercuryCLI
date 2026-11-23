import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useLoad } from '../../../hooks/effects.js'
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

type LoadedFile = { exists: boolean; content: string; beforeBytes?: string }

export function SedEditPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
  sedEditInfo,
}: PermissionRequestProps & { sedEditInfo: SedEditInfo }): React.ReactNode {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null)
  const [readError, setReadError] = useState<unknown>(null)

  useLoad(() => {
    let cancelled = false
    setLoaded(null)
    setReadError(null)
    fs.readFile(sedEditInfo.filePath)
      .then(raw => {
        if (cancelled) return
        const encoding = detectEncodingForResolvedPath(sedEditInfo.filePath)
        const content = raw.toString(encoding).replace(/\r\n/g, '\n')
        setLoaded({ exists: true, content, beforeBytes: raw.toString('base64') })
      })
      .catch(error => {
        if (cancelled) return
        if (isENOENT(error)) {
          setLoaded({ exists: false, content: '' })
          return
        }
        setReadError(error)
      })
    return () => {
      cancelled = true
    }
  }, [sedEditInfo.filePath])

  const oldContent = loaded?.content ?? ''
  const newContent = useMemo(
    () => (loaded === null ? null : applySedSubstitution(loaded.content, sedEditInfo)),
    [loaded, sedEditInfo],
  )

  const parseInput = useCallback(
    (input: unknown): ToolInput => {
      const base: ToolInput = typeof input === 'object' && input !== null ? { ...input } : {}
      if (newContent === null || loaded?.beforeBytes === undefined) return base
      return {
        ...base,
        _simulatedSedEdit: {
          filePath: sedEditInfo.filePath,
          newContent,
          beforeBytes: loaded.beforeBytes,
        },
      }
    },
    [newContent, loaded, sedEditInfo.filePath],
  )

  if (readError !== null) {
    throw readError
  }

  const content =
    loaded === null ? null : newContent === null ? (
      <Text dimColor>
        {sedEditInfo.filePath}: this sed pattern could not be previewed — approving runs sed directly
      </Text>
    ) : oldContent === newContent ? (
      <Text dimColor>
        {loaded.exists ? 'The pattern did not match any content' : 'The file does not exist'}
      </Text>
    ) : (
      <ConsentFileEditDiff
        file_path={sedEditInfo.filePath}
        edits={[{ old_string: oldContent, new_string: newContent }]}
      />
    )

  return (
    <FilePermissionDialog<ToolInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title="Edit file"
      subtitle={relative(getFocusedSessionConnector().workspace().cwd, sedEditInfo.filePath)}
      question={
        <Text bold>
          Do you want to edit <Text bold>{basename(sedEditInfo.filePath)}</Text>?
        </Text>
      }
      content={content}
      path={sedEditInfo.filePath}
      parseInput={parseInput}
      workerBadge={workerBadge}
      canApprove={loaded !== null}
    />
  )
}
