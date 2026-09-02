
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import useInput from '../../ink/hooks/use-input.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { PastedContent } from '../../utils/config.js'
import { getImageFromClipboard } from '../../utils/imagePaste.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import { ClickableImageRef } from '../ClickableImageRef.js'
import Byline from '../design-system/Byline.js'
import TextInput from '../TextInput.js'
import { SelectOption } from './select-option.js'
import type { InputOption } from './option-map.js'

const INPUT_WRAP_COLUMNS = 80

export type SelectInputOptionProps<T = string> = {
  option: InputOption<T>
  isFocused: boolean
  isSelected?: boolean
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  reservedIndexWidth: number
  index: number
  showLabelWithValue?: boolean
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  shouldShowDownArrow?: boolean
  shouldShowUpArrow?: boolean
  children?: React.ReactNode
  onOpenEditor?: (value: string, setValue: (value: string) => void) => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
  ) => void
  pastedContents?: Record<number, PastedContent>
  onRemoveImage?: (id: number) => void
  isImageSelectionMode?: boolean
  selectedImageIndex?: number
  onSelectImage?: (index: number) => void
  onExitImageSelection?: () => void
}

export function SelectInputOption<T>({
  option,
  isFocused,
  isSelected = false,
  value,
  onChange,
  onSubmit,
  reservedIndexWidth,
  index,
  showLabelWithValue = false,
  layout = 'compact',
  shouldShowDownArrow = false,
  shouldShowUpArrow = false,
  children,
  onOpenEditor,
  onImagePaste,
  pastedContents,
  onRemoveImage,
  isImageSelectionMode = false,
  selectedImageIndex = 0,
  onSelectImage,
  onExitImageSelection,
}: SelectInputOptionProps<T>): React.ReactNode {
  const [offset, setOffset] = useState(value.length)
  const { columns: termCols } = useTerminalSize()
  const inputColumns = Math.max(20, Math.min(INPUT_WRAP_COLUMNS, termCols - 6))
  const keystrokeRef = useRef(false)
  const previousValueRef = useRef(value)
  const previousFocusedRef = useRef(isFocused)
  if (option.resetCursorOnUpdate) {
    const valueChanged = previousValueRef.current !== value
    const gainedFocus = isFocused && !previousFocusedRef.current
    if (isFocused && ((valueChanged && !keystrokeRef.current) || gainedFocus)) {
      if (offset !== value.length) setOffset(value.length)
    }
    if (valueChanged) keystrokeRef.current = false
  }
  previousValueRef.current = value
  previousFocusedRef.current = isFocused

  const handleChange = (next: string): void => {
    keystrokeRef.current = true
    onChange(next)
  }

  const images: PastedContent[] = Object.values(pastedContents ?? {}).filter(
    content => content.type === 'image',
  )
  const hasImages = images.length > 0

  useKeybinding(
    'chat:externalEditor',
    () => {
      onOpenEditor?.(value, onChange)
    },
    { context: 'Chat', isActive: isFocused && Boolean(onOpenEditor) },
  )

  useKeybinding(
    'chat:imagePaste',
    () => {
      void getImageFromClipboard().then(image => {
        if (image) {
          onImagePaste?.(image.base64, image.mediaType, undefined, image.dimensions)
        }
      })
    },
    { context: 'Chat', isActive: isFocused && Boolean(onImagePaste) },
  )

  useKeybinding(
    'attachments:remove',
    () => {
      if (isImageSelectionMode) {
        const selected = images[selectedImageIndex]
        if (!selected) return
        onRemoveImage?.(selected.id)
        if (images.length <= 1) {
          onExitImageSelection?.()
        } else if (selectedImageIndex >= images.length - 1) {
          onSelectImage?.(images.length - 2)
        }
        return
      }
      if (value === '' && hasImages) {
        const mostRecent = images.reduce((a, b) => (b.id > a.id ? b : a))
        onRemoveImage?.(mostRecent.id)
      }
    },
    {
      context: 'Attachments',
      isActive: isFocused && hasImages && Boolean(onRemoveImage),
    },
  )
  useKeybinding(
    'attachments:next',
    () => {
      if (images.length > 1) {
        onSelectImage?.((selectedImageIndex + 1) % images.length)
      }
    },
    { context: 'Attachments', isActive: isFocused && isImageSelectionMode },
  )
  useKeybinding(
    'attachments:previous',
    () => {
      if (images.length > 1) {
        onSelectImage?.(
          (selectedImageIndex - 1 + images.length) % images.length,
        )
      }
    },
    { context: 'Attachments', isActive: isFocused && isImageSelectionMode },
  )
  useKeybinding(
    'attachments:exit',
    () => {
      onExitImageSelection?.()
    },
    { context: 'Attachments', isActive: isFocused && isImageSelectionMode },
  )
  useInput(
    (_input, key, event) => {
      if (key.upArrow) {
        onExitImageSelection?.()
        event.stopImmediatePropagation()
      }
    },
    { isActive: isFocused && isImageSelectionMode },
  )
  useEffect(() => {
    if (!isFocused && isImageSelectionMode) onExitImageSelection?.()
  }, [isFocused, isImageSelectionMode, onExitImageSelection])

  const prefixText =
    option.indexLabel !== undefined
      ? option.indexLabel.padEnd(
          Math.max(reservedIndexWidth + 2, option.indexLabel.length + 1),
        )
      : (index <= 9 ? `${index}.` : '').padEnd(reservedIndexWidth + 2)

  const labelIsString = typeof option.label === 'string'
  const placeholder =
    option.placeholder ?? (labelIsString ? (option.label as string) : undefined)
  const separator = option.labelValueSeparator ?? ', '
  const showLabel = showLabelWithValue || option.showLabelWithValue === true

  let field: React.ReactNode
  if (isFocused) {
    field = (
      <TextInput
        value={value}
        onChange={handleChange}
        onSubmit={() => {
          onSubmit()
        }}
        columns={inputColumns}
        cursorOffset={offset}
        onChangeCursorOffset={next => {
          setOffset(next)
        }}
        multiline={true}
        showCursor={true}
        focus={!isImageSelectionMode}
        placeholder={showLabel ? undefined : placeholder}
      />
    )
  } else if (value !== '') {
    field = <Text>{value}</Text>
  } else if (!showLabel) {
    field = <Text color="inactive">{placeholder ?? ''}</Text>
  } else {
    field = null
  }

  const labelBlock = showLabel ? (
    <Text color={isFocused ? 'suggestion' : undefined}>
      {option.label}
      {isFocused || value !== '' ? separator : ''}
    </Text>
  ) : null

  const descriptionIndent =
    reservedIndexWidth + (layout === 'expanded' ? 3 : 4)

  const shortcutNext = useShortcutDisplay('attachments:next', 'Attachments', '→')
  const shortcutPrevious = useShortcutDisplay(
    'attachments:previous',
    'Attachments',
    '←',
  )
  const shortcutRemove = useShortcutDisplay(
    'attachments:remove',
    'Attachments',
    'backspace',
  )
  const shortcutExit = useShortcutDisplay('attachments:exit', 'Attachments', 'esc')

  return (
    <Box flexDirection="column">
      <SelectOption
        isFocused={isFocused}
        isSelected={isSelected}
        shouldShowDownArrow={shouldShowDownArrow}
        shouldShowUpArrow={shouldShowUpArrow}
        declareCursor={false}
      >
        <Text dimColor>{prefixText}</Text>
        {children}
        {labelBlock}
        {field}
      </SelectOption>
      {option.description !== undefined && option.description !== '' ? (
        <Box paddingLeft={descriptionIndent}>
          <Text
            color="inactive"
            dimColor={option.dimDescription !== false}
          >
            {option.description}
          </Text>
        </Box>
      ) : null}
      {isFocused && hasImages ? (
        <Box flexDirection="column" paddingLeft={descriptionIndent}>
          <Box gap={1}>
            {images.map((image, imageIndex) => (
              <ClickableImageRef
                key={image.id}
                imageId={image.id}
                isSelected={isImageSelectionMode && imageIndex === selectedImageIndex}
              />
            ))}
          </Box>
          {isImageSelectionMode ? (
            <Text dimColor>
              <Byline>
                {images.length > 1 ? (
                  <Text dimColor>{shortcutNext} next</Text>
                ) : null}
                {images.length > 1 ? (
                  <Text dimColor>{shortcutPrevious} previous</Text>
                ) : null}
                <Text dimColor>{shortcutRemove} remove</Text>
                <Text dimColor>{shortcutExit} cancel</Text>
              </Byline>
            </Text>
          ) : (
            <Text dimColor>(press ↓ to select images)</Text>
          )}
        </Box>
      ) : null}
      {layout === 'expanded' ? <Box height={1} /> : null}
    </Box>
  )
}

export default SelectInputOption
