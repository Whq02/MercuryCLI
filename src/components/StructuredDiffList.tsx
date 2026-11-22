import React from 'react'
import { Box, Text } from '../ink.js'
import { NoSelect } from '../ink/components/NoSelect.js'
import type { StructuredPatchHunk } from '../utils/diff.js'
import { StructuredDiff } from './StructuredDiff.js'
import { notBuilt } from '../pi/holes.js'

export function StructuredDiffList(arg0: {
  hunks: StructuredPatchHunk[]
  dim: boolean
  width: number
  filePath: string
  firstLine: string | null
  fileContent?: string
}): React.ReactNode {
  return notBuilt('src/components/StructuredDiffList.tsx:8')
}

export default StructuredDiffList
