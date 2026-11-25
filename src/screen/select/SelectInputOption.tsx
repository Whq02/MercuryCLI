import React, { useRef, useState } from 'react'
import { Box, Text } from '../themedRenderer.js'
import useInput from '../renderer/bindings/use-input.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { usePublish } from '../effects/effects.js'
import type { PastedContent } from '../../platform/settings/config.js'
import { getImageFromClipboard } from '../composer/imagePaste.js'
import type { ImageDimensions } from '../../platform/images/imageResizer.js'
import { ClickableImageRef } from './ClickableImageRef.js'
import { Byline } from '../theme/Byline.js'
import TextInput from '../composer/text-input/TextInput.js'
import { SelectOption } from './select-option.js'
import { ordinalPrefix, type InputOption } from './optionMap.js'
import { logError } from '../../platform/logs/errorLog.js'

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

type SelectInputOptionProps<T = string> = {
  option: InputOption<T>
  isFocused: boolean
  isSelected?: boolean
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
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
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const [pasteError, setPasteError] = useState<string | null>(null)
  const { columns: termCols } = useTerminalSize()
  const inputColumns = Math.max(20, Math.min(INPUT_WRAP_COLUMNS, termCols - 6))

  const keystrokeRef = useRef(false)
  const prevValueRef = useRef(value)
  const prevFocusedRef = useRef(isFocused)
  if (option.resetCursorOnUpdate) {
    const valueChanged = value !== prevValueRef.current
    const focusGained = isFocused && !prevFocusedRef.current
    if (isFocused && ((valueChanged && !keystrokeRef.current) || focusGained) && cursorOffset !== value.length) {
      setCursorOffset(value.length)
    }
    if (valueChanged) keystrokeRef.current = false
  }
  prevValueRef.current = value
  prevFocusedRef.current = isFocused

  const handleChange = (text: string): void => {
    keystrokeRef.current = true
    if (pasteError !== null) setPasteError(null)
    onChange(text)
  }

  const images = Object.values(pastedContents ?? {}).filter(item => item.type === 'image')

  const openEditor = (): void => {
    onOpenEditor?.(value, onChange)
  }
  useKeybinding('chat:externalEditor', openEditor, {
    context: 'Chat',
    isActive: isFocused && onOpenEditor !== undefined,
  })
  useKeybinding('chat:externalEditor', openEditor, {
    context: 'Confirmation',
    isActive: isFocused && onOpenEditor !== undefined,
  })

  useKeybinding(
    'chat:imagePaste',
    () => {
      void runSelectImagePaste({ onImagePaste, onError: setPasteError })
    },
    { context: 'Chat', isActive: isFocused && onImagePaste !== undefined },
  )

  useKeybinding(
    'attachments:remove',
    () => {
      if (isImageSelectionMode) {
        const target = images[selectedImageIndex]
        if (target === undefined) return
        onRemoveImage?.(target.id)
        if (images.length <= 1) {
          onExitImageSelection?.()
        } else if (selectedImageIndex >= images.length - 1) {
          onSelectImage?.(images.length - 2)
        }
        return
      }
      if (value !== '') return
      const newest = images.reduce((best, img) => (img.id > best.id ? img : best))
      onRemoveImage?.(newest.id)
    },
    {
      context: 'Attachments',
      isActive: isFocused && images.length > 0 && onRemoveImage !== undefined,
    },
  )
  useKeybinding(
    'attachments:next',
    () => {
      if (images.length > 1) onSelectImage?.((selectedImageIndex + 1) % images.length)
    },
    { context: 'Attachments', isActive: isFocused && isImageSelectionMode },
  )
  useKeybinding(
    'attachments:previous',
    () => {
      if (images.length > 1) {
        onSelectImage?.((((selectedImageIndex - 1) % images.length) + images.length) % images.length)
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
      if (!key.upArrow) return
      event.stopImmediatePropagation()
      onExitImageSelection?.()
    },
    { isActive: isFocused && isImageSelectionMode },
  )

  usePublish(() => {
    if (!isFocused && isImageSelectionMode) onExitImageSelection?.()
  }, [isFocused, isImageSelectionMode, onExitImageSelection])

  const nextKey = useShortcutDisplay('attachments:next', 'Attachments', '→')
  const previousKey = useShortcutDisplay('attachments:previous', 'Attachments', '←')
  const removeKey = useShortcutDisplay('attachments:remove', 'Attachments', 'backspace')
  const exitKey = useShortcutDisplay('attachments:exit', 'Attachments', 'esc')

  const number = ordinalPrefix(option, index, reservedIndexWidth + 2)
  const placeholder =
    option.placeholder ?? (typeof option.label === 'string' ? option.label : undefined)
  const separator = option.labelValueSeparator ?? ', '
  const separatorWords = separator.trimEnd()
  const showsLabel = showLabelWithValue || option.showLabelWithValue === true
  const indent = reservedIndexWidth + (layout === 'expanded' ? 3 : 4)
  const description =
    option.description !== undefined && option.description !== '' ? option.description : undefined

  const field = isFocused ? (
    <TextInput
      value={value}
      onChange={handleChange}
      onSubmit={text => onSubmit(text)}
      columns={showsLabel ? Math.max(1, Math.min(inputColumns, termCols - 6 - indent)) : inputColumns}
      cursorOffset={cursorOffset}
      onChangeCursorOffset={setCursorOffset}
      multiline
      showCursor
      focus={!isImageSelectionMode}
      placeholder={showsLabel ? undefined : placeholder}
    />
  ) : value !== '' ? (
    <Text>{value}</Text>
  ) : showsLabel ? null : (
    <Text color="inactive">{placeholder ?? ''}</Text>
  )

  return (
    <Box flexDirection="column">
      <SelectOption
        isFocused={isFocused}
        isSelected={isSelected}
        shouldShowDownArrow={shouldShowDownArrow}
        shouldShowUpArrow={shouldShowUpArrow}
        declareCursor={false}
      >
        <Box>
          <Box flexShrink={0}><Text dimColor>{number}</Text></Box>
          {children ? <Box marginRight={1}>{children}</Box> : null}
          <Box flexWrap="wrap" columnGap={separator.length - separatorWords.length}>
            {showsLabel ? (
              <Text color={isFocused ? 'suggestion' : undefined}>
                {option.label}
                {isFocused || value !== '' ? separatorWords : ''}
              </Text>
            ) : null}
            {field}
          </Box>
        </Box>
      </SelectOption>
      {description !== undefined ? (
        <Box paddingLeft={indent}>
          <Text color="inactive" dimColor={option.dimDescription !== false}>
            {description}
          </Text>
        </Box>
      ) : null}
      {isFocused && images.length > 0 ? (
        <Box flexDirection="column" paddingLeft={indent}>
          <Box gap={1}>
            {images.map((img, place) => (
              <ClickableImageRef
                key={img.id}
                imageId={img.id}
                isSelected={isImageSelectionMode && place === selectedImageIndex}
              />
            ))}
          </Box>
          {isImageSelectionMode ? (
            <Text dimColor>
              <Byline>
                {images.length > 1 ? <Text dimColor>{nextKey} next</Text> : null}
                {images.length > 1 ? <Text dimColor>{previousKey} previous</Text> : null}
                <Text dimColor>{removeKey} remove</Text>
                <Text dimColor>{exitKey} cancel</Text>
              </Byline>
            </Text>
          ) : (
            <Text dimColor>(press ↓ to select images)</Text>
          )}
        </Box>
      ) : null}
      {isFocused && pasteError !== null ? (
        <Box paddingLeft={indent}>
          <Text color="error">{pasteError}</Text>
        </Box>
      ) : null}
      {layout === 'expanded' ? <Box height={1} /> : null}
    </Box>
  )
}
