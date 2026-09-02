
import React from 'react'
import { Box, Text } from '../ink.js'
import { NoSelect } from '../ink/components/NoSelect.js'
import type { StructuredPatchHunk } from '../utils/diff.js'
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
        <Box key={hunk.newStart} flexDirection="column">
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
        </Box>
      ))}
    </Box>
  )
}

export default StructuredDiffList
