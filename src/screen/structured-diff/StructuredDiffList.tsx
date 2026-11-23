import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { NoSelect } from '../renderer/elements/NoSelect.js'
import type { StructuredPatchHunk } from '../../platform/text/diff.js'
import { StructuredDiff } from './StructuredDiff.js'

export function StructuredDiffList({
  hunks,
  dim,
  width,
  filePath,
  firstLine,
  fileContent,
}: {
  hunks: StructuredPatchHunk[]
  dim: boolean
  width: number
  filePath: string
  firstLine: string | null
  fileContent?: string
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      {hunks.map((hunk, index) => (
        <React.Fragment key={hunk.newStart}>
          {index > 0 ? (
            <NoSelect>
              <Text dimColor>...</Text>
            </NoSelect>
          ) : null}
          <StructuredDiff
            patch={hunk}
            dim={dim}
            width={width}
            filePath={filePath}
            firstLine={firstLine}
            fileContent={fileContent}
          />
        </React.Fragment>
      ))}
    </Box>
  )
}

export default StructuredDiffList
