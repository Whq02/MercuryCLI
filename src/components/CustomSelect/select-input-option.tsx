// The inline free-text option row: a live single-field editor while
// focused, the current text (or placeholder/label) otherwise, plus the
// image-attachment strip and its key grammar. The index prefix is ALWAYS
// rendered here — input rows ignore the container's hideIndexes, a
// preserved quirk — and the terminal cursor is declared by the
// text field, never by the row chrome.

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

/** The editor's wrap CAP: 80 stays the ceiling on
 *  wide terminals (unchanged behavior), but the live width bounds it below
 *  — the old fixed 80 wrapped past a narrower terminal and the extra rows
 *  clipped. */
const INPUT_WRAP_COLUMNS = 80

export type SelectInputOptionProps<T = string> = {
  option: InputOption<T>
  isFocused: boolean
  isSelected?: boolean
  /** Current text — the containing component owns the value map. */
  value: string
  /** Reports to both the component's value map and the option's own change
   *  callback (the component's handler does both). */
  onChange: (value: string) => void
  /** The field submitted, with the text it holds AT the submit — a
   *  coalesced keystroke lands text and ↵ in one event, ahead of any
   *  render, so the container must not read its own stale map. */
  onSubmit: (value: string) => void
  /** The reserved index width — arrives 0 when the container hides indexes,
   *  in which case the prefix still occupies its two cells. */
  reservedIndexWidth: number
  /** 1-based absolute index in the full option list. */
  index: number
  /** Component-wide inline descriptions OR the option's own force flag. */
  showLabelWithValue?: boolean
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  shouldShowDownArrow?: boolean
  shouldShowUpArrow?: boolean
  /** Rendered between the index prefix and the field (the multi-select
   *  checkbox rides here). */
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
  // Caret: local offset state, initialised to the end of the incoming
  // value. With resetCursorOnUpdate, a focus gain or a non-keystroke value
  // change snaps it to the end; the field's own change handler sets a
  // one-shot flag so a keystroke-driven change leaves the caret alone.
  const [offset, setOffset] = useState(value.length)
  // C3 (PD-7): the wrap width follows the terminal under the 80 cap.
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

  // External editor: bound while the row is focused and a callback exists.
  useKeybinding(
    'chat:externalEditor',
    () => {
      onOpenEditor?.(value, onChange)
    },
    { context: 'Chat', isActive: isFocused && Boolean(onOpenEditor) },
  )

  // Clipboard image paste: reads an image and reports base64 content, media
  // type, no filename, and dimensions.
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

  // Attachment grammar. Outside selection mode, remove acts only with an
  // EMPTY field and at least one image, deleting the most recently added.
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
  // The Up arrow also leaves selection mode — bound raw, since it is not
  // part of the attachment binding set.
  useInput(
    (_input, key, event) => {
      if (key.upArrow) {
        onExitImageSelection?.()
        event.stopImmediatePropagation()
      }
    },
    { isActive: isFocused && isImageSelectionMode },
  )
  // Losing focus while in selection mode must exit selection mode.
  useEffect(() => {
    if (!isFocused && isImageSelectionMode) onExitImageSelection?.()
  }, [isFocused, isImageSelectionMode, onExitImageSelection])

  // Index prefix: always rendered, dimmed, padded to the reserved width + 2
  // (a hidden-index container hands 0 and the prefix still takes two cells).
  // An option-declared display ordinal (indexLabel — the Apollo letter
  // grammar) replaces the numeric prefix and guarantees ONE trailing space,
  // matching the declared-ordinal grammar on text rows.
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
        onSubmit={text => {
          onSubmit(text)
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

  // Description/strip indent: index width + 3 in the expanded layout,
  // index width + 4 in compact.
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
