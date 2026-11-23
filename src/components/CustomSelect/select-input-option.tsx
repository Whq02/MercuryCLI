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
  shouldShowDownArrow?: boolean
  shouldShowUpArrow?: boolean
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onExit?: () => void
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  index?: number
  reservedIndexWidth?: number
  hideIndexes?: boolean
  inlineDescription?: boolean
  showLabelWithValue?: boolean
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
  onSelectedImageIndexChange?: (index: number) => void
  onExitImageSelection?: () => void
}

function inputOrdinalPrefix(
  option: { indexLabel?: string },
  index: number | undefined,
  reservedIndexWidth: number,
  hideIndexes: boolean,
): string {
  if (hideIndexes) return ''
  if (option.indexLabel !== undefined) {
    const width = Math.max(reservedIndexWidth + 2, option.indexLabel.length + 1)
    return option.indexLabel.padEnd(width)
  }
  if (index === undefined) return ''
  const raw = index >= 1 && index <= 9 ? `${index}.` : ''
  return raw.padEnd(reservedIndexWidth + 2)
}

export function SelectInputOption<T>({
  option,
  isFocused,
  isSelected = false,
  shouldShowDownArrow = false,
  shouldShowUpArrow = false,
  value,
  onChange,
  onSubmit,
  onExit,
  layout = 'compact',
  index,
  reservedIndexWidth = 0,
  hideIndexes = false,
  inlineDescription = false,
  showLabelWithValue = false,
  children,
  onOpenEditor,
  onImagePaste,
  pastedContents,
  onRemoveImage,
  isImageSelectionMode = false,
  selectedImageIndex = 0,
  onSelectedImageIndexChange,
  onExitImageSelection,
}: SelectInputOptionProps<T>): React.ReactNode {
  const { columns: termCols } = useTerminalSize()
  const inputColumns = Math.max(20, Math.min(INPUT_WRAP_COLUMNS, termCols - 6))
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const [pasteError, setPasteError] = useState<string | null>(null)

  const lastEditedValueRef = useRef<string | null>(null)
  const prevValueRef = useRef(value)
  const prevFocusedRef = useRef(isFocused)

  if (option.resetCursorOnUpdate) {
    if (value !== prevValueRef.current) {
      if (value !== lastEditedValueRef.current) {
        setCursorOffset(value.length)
      }
      lastEditedValueRef.current = null
      prevValueRef.current = value
    }
    if (isFocused && !prevFocusedRef.current) {
      setCursorOffset(value.length)
    }
  } else {
    prevValueRef.current = value
  }
  prevFocusedRef.current = isFocused

  const images = Object.values(pastedContents ?? {}).filter(item => item.type === 'image')
  const hasImages = images.length > 0
  const inImageMode = Boolean(isImageSelectionMode && isFocused && hasImages)
  const clampedImageIndex = hasImages
    ? Math.max(0, Math.min(selectedImageIndex, images.length - 1))
    : 0

  usePublish(() => {
    if (!isFocused && isImageSelectionMode) {
      onExitImageSelection?.()
    }
  }, [isFocused, isImageSelectionMode, onExitImageSelection])

  const handleChange = (next: string): void => {
    lastEditedValueRef.current = next
    if (pasteError !== null) setPasteError(null)
    onChange(next)
  }

  const handleOpenEditor = (): void => {
    onOpenEditor?.(value, next => {
      if (pasteError !== null) setPasteError(null)
      onChange(next)
    })
  }

  useKeybinding('chat:externalEditor', handleOpenEditor, {
    context: 'Chat',
    isActive: isFocused && !inImageMode && Boolean(onOpenEditor),
  })
  useKeybinding('chat:externalEditor', handleOpenEditor, {
    context: 'Confirmation',
    isActive: isFocused && !inImageMode && Boolean(onOpenEditor),
  })

  useKeybinding(
    'chat:imagePaste',
    () => {
      void runSelectImagePaste({
        onImagePaste,
        onError: setPasteError,
      })
    },
    {
      context: 'Chat',
      isActive: isFocused && !inImageMode && Boolean(onImagePaste),
    },
  )

  useKeybinding(
    'attachments:next',
    () => {
      if (images.length > 0) {
        onSelectedImageIndexChange?.((clampedImageIndex + 1) % images.length)
      }
    },
    { context: 'Attachments', isActive: inImageMode },
  )
  useKeybinding(
    'attachments:previous',
    () => {
      if (images.length > 0) {
        onSelectedImageIndexChange?.((clampedImageIndex - 1 + images.length) % images.length)
      }
    },
    { context: 'Attachments', isActive: inImageMode },
  )
  useKeybinding(
    'attachments:remove',
    () => {
      const target = images[clampedImageIndex]
      if (!target) return
      onRemoveImage?.(target.id)
      if (images.length <= 1) {
        onExitImageSelection?.()
      } else if (clampedImageIndex >= images.length - 1) {
        onSelectedImageIndexChange?.(images.length - 2)
      }
    },
    { context: 'Attachments', isActive: inImageMode },
  )
  useKeybinding(
    'attachments:exit',
    () => {
      onExitImageSelection?.()
    },
    { context: 'Attachments', isActive: inImageMode },
  )

  useInput(
    (_input, key, event) => {
      if (inImageMode) {
        if (key.upArrow) {
          event.stopImmediatePropagation()
          onExitImageSelection?.()
        }
        return
      }
      if (
        isFocused &&
        (key.backspace || key.delete) &&
        value === '' &&
        hasImages &&
        onRemoveImage
      ) {
        let newest = images[0]!
        for (const img of images) {
          if (img.id > newest.id) newest = img
        }
        event.stopImmediatePropagation()
        onRemoveImage(newest.id)
      }
    },
    { isActive: isFocused && (inImageMode || (hasImages && Boolean(onRemoveImage))) },
  )

  const removeKey = useShortcutDisplay('attachments:remove', 'Attachments', 'backspace')
  const nextKey = useShortcutDisplay('attachments:next', 'Attachments', '→')
  const prevKey = useShortcutDisplay('attachments:previous', 'Attachments', '←')

  const prefix = inputOrdinalPrefix(option, index, reservedIndexWidth, hideIndexes)
  const effectiveShowLabel = Boolean(showLabelWithValue || option.showLabelWithValue)
  const separator = option.labelValueSeparator ?? ', '
  const effectivePlaceholder =
    option.placeholder ?? (typeof option.label === 'string' ? option.label : undefined)
  const belowIndent = reservedIndexWidth + (layout === 'expanded' ? 3 : 4)
  const description =
    option.description !== undefined && option.description !== '' ? option.description : undefined
  const dimDescription = option.dimDescription !== false

  return (
    <Box flexDirection="column">
      <SelectOption
        isFocused={isFocused}
        isSelected={isSelected}
        shouldShowDownArrow={shouldShowDownArrow}
        shouldShowUpArrow={shouldShowUpArrow}
        declareCursor={false}
      >
        <Box flexShrink={1} minWidth={0}>
          {prefix !== '' ? <Text dimColor>{prefix}</Text> : null}
          {children}
          {effectiveShowLabel ? (
            <Text
              color={isFocused ? 'suggestion' : isSelected ? 'success' : undefined}
              dimColor={option.disabled}
            >
              {option.label}
              {separator}
            </Text>
          ) : null}
          {isFocused && !option.disabled ? (
            <TextInput
              value={value}
              onChange={handleChange}
              onSubmit={onSubmit}
              onExit={onExit}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              columns={inputColumns}
              placeholder={effectivePlaceholder}
              multiline
              focus={!inImageMode}
              showCursor={!inImageMode}
              disableCursorMovementForUpDownKeys
              disablePageKeyCursorMovement
            />
          ) : value !== '' ? (
            <Text color={isSelected ? 'success' : undefined} dimColor={option.disabled}>
              {value}
            </Text>
          ) : (
            <Text dimColor>{effectivePlaceholder ?? option.label}</Text>
          )}
          {description !== undefined && inlineDescription ? (
            <Text dimColor={dimDescription}> {description}</Text>
          ) : null}
        </Box>
      </SelectOption>
      {description !== undefined && !inlineDescription ? (
        <Box paddingLeft={belowIndent}>
          <Text dimColor={dimDescription}>{description}</Text>
        </Box>
      ) : null}
      {hasImages ? (
        <Box paddingLeft={belowIndent} gap={1} flexWrap="wrap">
          {images.map((img, idx) => (
            <ClickableImageRef
              key={img.id}
              imageId={img.id}
              isSelected={inImageMode && idx === clampedImageIndex}
            />
          ))}
          {inImageMode ? (
            <Byline>
              {images.length > 1 ? (
                <Text dimColor>
                  {prevKey}/{nextKey} select
                </Text>
              ) : null}
              <Text dimColor>{removeKey} remove</Text>
              <Text dimColor>esc cancel</Text>
            </Byline>
          ) : isFocused ? (
            <Text dimColor>(press ↓ to select images)</Text>
          ) : null}
        </Box>
      ) : null}
      {pasteError !== null ? (
        <Box paddingLeft={belowIndent}>
          <Text color="error">{pasteError}</Text>
        </Box>
      ) : null}
      {layout === 'expanded' ? <Box height={1} /> : null}
    </Box>
  )
}

export default SelectInputOption
