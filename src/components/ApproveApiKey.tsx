import React, { useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { notBuilt } from '../pi/holes.js'

export function ApproveApiKey(arg0: {
  customApiKeyTruncated: string
  onDone: (approved: boolean) => void
}): React.ReactNode {
  return notBuilt('src/components/ApproveApiKey.tsx:8')
}

export default ApproveApiKey
