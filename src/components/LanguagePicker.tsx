import React, { useState } from 'react'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { notBuilt } from '../pi/holes.js'

const FIELD_COLUMNS = 60

export function LanguagePicker(arg0: {
  initialLanguage: string | undefined
  onComplete: (language: string | undefined) => void
  onCancel: () => void
}): React.ReactNode {
  return notBuilt('src/components/LanguagePicker.tsx:10')
}

export default LanguagePicker
