import React, { useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import useInput from '../../ink/hooks/use-input.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { usePublish } from '../../hooks/effects.js'
import type { PastedContent } from '../../utils/config.js'
import { getImageFromClipboard } from '../../utils/imagePaste.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import { ClickableImageRef } from '../ClickableImageRef.js'
import Byline from '../design-system/Byline.js'
import TextInput from '../TextInput.js'
import { SelectOption } from './select-option.js'
import type { InputOption } from './option-map.js'
import { logError } from '../../utils/log.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const INPUT_WRAP_COLUMNS = 80

export function runSelectImagePaste(io: {
  read?: typeof getImageFromClipboard
  onImagePaste?: SelectInputOptionProps['onImagePaste']
  onError: (sentence: string | null) => void
}): Promise<void> {
  return (io.read ?? getImageFromClipboard)()
    .then(image => {
      io.onError(null)
      if (image) {
        io.onImagePaste?.(image.base64, image.mediaType, undefined, image.dimensions)
      }
    })
    .catch(error => {
      logError(error)
      io.onError(
        `Could not paste image from clipboard (${error instanceof Error ? error.message : String(error)}) — copy the image again and retry`,
      )
    })
}

type SelectInputOptionProps<T = string> = Unbuilt

export function SelectInputOption<T>(arg0: SelectInputOptionProps<T>): React.ReactNode {
  return notBuilt('src/components/CustomSelect/select-input-option.tsx:70')
}

export default SelectInputOption
