import React from 'react'
import { Box, Text } from '../../ink.js'
import {
  agentModelPickOutcome,
  getAgentModelPickerRows,
} from '../../services/model/agentModelPicker.js'
import { parseUserSpecifiedModel } from '../../services/model/model.js'
import { AMBER } from '../mercuryPalette.js'
import { Select } from '../CustomSelect/index.js'
import { notBuilt } from '../../pi/holes.js'

export function ModelSelector(arg0: {
  initialModel?: string
  onComplete: (model: string | undefined) => void
  onCancel?: () => void
}): React.ReactNode {
  return notBuilt('src/components/agents/ModelSelector.tsx:12')
}

export default ModelSelector
