import figures from 'figures'
import * as React from 'react'
import type { PrimitiveSchemaDefinition } from '../../../integrations/mcp-shapes/sdk.js'
import { Box, Text, type Key } from '../../themedRenderer.js'
import { PopupListViewport, type popupListWindow } from '../../select/popup-list.js'
import type { ElicitationRequestEvent } from '../../../integrations/mcp/elicitationHandler.js'
import { getEnumLabel, getEnumLabels, getEnumValues, getMultiSelectLabel, getMultiSelectLabels, getMultiSelectValues, isDateTimeSchema, validateElicitationInput, validateElicitationInputAsync } from '../../../integrations/mcp/elicitationValidation.js'
import { Dialog } from '../../theme/Dialog.js'
import TextInput from '../../composer/text-input/TextInput.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export type FieldValue = string | number | boolean | string[]

export type FieldKind = 'multi' | 'enum' | 'boolean' | 'text' | 'raw'

export type FieldState = {
  name: string
  schema: PrimitiveSchemaDefinition
  kind: FieldKind
  required: boolean
  value: FieldValue | undefined
  text: string
  error: string | undefined
  resolving: boolean
}

export type ElicitationDialogProps = {
  event: ElicitationRequestEvent
  onResponse: (
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ) => void
  onWaitingDismiss: (action: 'cancel' | 'retry' | 'dismiss') => void
}

export function scheduleDateResolveOf({
  resolveTimersRef,
  resolveAbortsRef,
  typedSinceResolveRef,
  patchField,
  unmountedRef,
  RESOLVE_DEBOUNCE_MS,
}: {
  resolveTimersRef: React.RefObject<Map<string, ReturnType<typeof setTimeout>>>
  resolveAbortsRef: React.RefObject<Map<string, AbortController>>
  typedSinceResolveRef: React.RefObject<Set<string>>
  patchField: (name: string, patch: Partial<FieldState>) => void
  unmountedRef: React.RefObject<boolean>
  RESOLVE_DEBOUNCE_MS: number
}, field: FieldState, immediately: boolean): void {
  const existingTimer = resolveTimersRef.current.get(field.name)
  if (existingTimer) stopTimeout(existingTimer)
  const run = () => {
    resolveTimersRef.current.delete(field.name)
    resolveAbortsRef.current.get(field.name)?.abort()
    const controller = new AbortController()
    resolveAbortsRef.current.set(field.name, controller)
    typedSinceResolveRef.current.delete(field.name)
    patchField(field.name, { resolving: true })
    void validateElicitationInputAsync(field.text, field.schema, controller.signal)
      .then(result => {
        if (unmountedRef.current || controller.signal.aborted) return
        if (result.isValid) {
          const typedSince = typedSinceResolveRef.current.has(field.name)
          patchField(field.name, {
            resolving: false,
            value: result.value,
            error: undefined,
            ...(typedSince ? {} : { text: String(result.value ?? '') }),
          })
        } else {
          patchField(field.name, { resolving: false, error: result.error })
        }
      })
      .catch(() => {
        if (!unmountedRef.current && !controller.signal.aborted) patchField(field.name, { resolving: false })
      })
  }
  if (immediately) run()
  else {
    resolveTimersRef.current.set(
      field.name,
      startTimeout(run, RESOLVE_DEBOUNCE_MS),
    )
  }
}

export function commitTextOf({
  resolveTimersRef,
  resolveAbortsRef,
  patchField,
  typedSinceResolveRef,
  scheduleDateResolve,
}: {
  resolveTimersRef: React.RefObject<Map<string, ReturnType<typeof setTimeout>>>
  resolveAbortsRef: React.RefObject<Map<string, AbortController>>
  patchField: (name: string, patch: Partial<FieldState>) => void
  typedSinceResolveRef: React.RefObject<Set<string>>
  scheduleDateResolve: (field: FieldState, immediately: boolean) => void
}, field: FieldState, text: string): void {
  const timer = resolveTimersRef.current.get(field.name)
  if (timer !== undefined) stopTimeout(timer)
  resolveTimersRef.current.delete(field.name)
  resolveAbortsRef.current.get(field.name)?.abort()
  resolveAbortsRef.current.delete(field.name)
  patchField(field.name, { resolving: false })
  typedSinceResolveRef.current.add(field.name)
  const type = (field.schema as { type?: string }).type
  if (text === '') {
    if (type === 'string' && field.value !== undefined) {
      const result = validateElicitationInput(text, field.schema)
      patchField(field.name, { text, value: result.isValid ? result.value : undefined, error: result.error })
    } else {
      patchField(field.name, { text, value: undefined, error: undefined })
    }
    return
  }
  const result = validateElicitationInput(text, field.schema)
  if (result.isValid) {
    patchField(field.name, { text, value: result.value, error: undefined })
  } else {
    patchField(field.name, { text, value: undefined, error: result.error })
    if (isDateTimeSchema(field.schema)) {
      scheduleDateResolve({ ...field, text }, false)
    }
  }
}

export function formKeysOf({
  buttonFocused,
  setCursor,
  cursor,
  acceptIndex,
  declineIndex,
  moveCursor,
  submitAccept,
  onResponse,
  focusedField,
  accordionOpen,
  accordionIndex,
  setAccordionOpen,
  setAccordionIndex,
  toggleMultiValue,
  patchField,
  typeahead,
  expandAccordion,
}: {
  buttonFocused: boolean
  setCursor: React.Dispatch<React.SetStateAction<number>>
  cursor: number
  acceptIndex: number
  declineIndex: number
  moveCursor: (delta: 1 | -1, commit?: boolean) => void
  submitAccept: () => void
  onResponse: ElicitationDialogProps['onResponse']
  focusedField: FieldState | undefined
  accordionOpen: boolean
  accordionIndex: number
  setAccordionOpen: React.Dispatch<React.SetStateAction<boolean>>
  setAccordionIndex: React.Dispatch<React.SetStateAction<number>>
  toggleMultiValue: (field: FieldState, value: string, checkOnly: boolean) => void
  patchField: (name: string, patch: Partial<FieldState>) => void
  typeahead: (field: FieldState, input: string) => void
  expandAccordion: (field: FieldState, jumpTo?: number) => void
}, input: string, key: Key): void {
  if (buttonFocused) {
    if (key.leftArrow || key.rightArrow) {
      setCursor(cursor === acceptIndex ? declineIndex : acceptIndex)
    } else if (key.upArrow) {
      moveCursor(-1)
    } else if (key.downArrow) {
      moveCursor(1)
    } else if (key.return) {
      if (cursor === acceptIndex) submitAccept()
      else onResponse('decline')
    }
    return
  }
  const field = focusedField
  if (!field) return

  if (accordionOpen) {
    const values =
      field.kind === 'multi'
        ? getMultiSelectValues(field.schema)
        : getEnumValues(field.schema)
    if (key.upArrow) {
      if (accordionIndex === 0) setAccordionOpen(false)
      else setAccordionIndex(accordionIndex - 1)
    } else if (key.downArrow) {
      if (accordionIndex >= values.length - 1) {
        setAccordionOpen(false)
        moveCursor(1)
      } else {
        setAccordionIndex(accordionIndex + 1)
      }
    } else if (key.leftArrow || key.escape) {
      setAccordionOpen(false)
    } else if (input === ' ') {
      const value = values[accordionIndex]
      if (value === undefined) return
      if (field.kind === 'multi') {
        toggleMultiValue(field, value, false)
      } else {
        patchField(field.name, { value, error: undefined })
        setAccordionOpen(false)
      }
    } else if (key.return) {
      const value = values[accordionIndex]
      if (value === undefined) return
      if (field.kind === 'multi') {
        toggleMultiValue(field, value, true)
      } else {
        patchField(field.name, { value, error: undefined })
      }
      setAccordionOpen(false)
      moveCursor(1, field.kind !== 'multi')
    } else if (input && !key.ctrl && !key.meta) {
      typeahead(field, input)
    }
    return
  }

  if (key.upArrow) {
    moveCursor(-1)
    return
  }
  if (key.downArrow) {
    moveCursor(1)
    return
  }

  switch (field.kind) {
    case 'boolean':
      if (input === ' ') {
        patchField(field.name, {
          value: field.value === undefined ? true : !field.value,
          error: undefined,
        })
      } else if (key.backspace || key.delete) {
        patchField(field.name, { value: undefined, error: undefined })
      } else if (key.return) {
        moveCursor(1)
      } else if (input && !key.ctrl && !key.meta) {
        typeahead(field, input)
      }
      return
    case 'enum':
    case 'multi':
      if (key.rightArrow) expandAccordion(field)
      else if (key.return) moveCursor(1)
      else if (key.backspace || key.delete) {
        patchField(field.name, { value: undefined, error: undefined })
      } else if (input && !key.ctrl && !key.meta) {
        typeahead(field, input)
      }
      return
    case 'text':
      if ((key.backspace || key.delete) && field.text === '') {
        patchField(field.name, { value: undefined, error: undefined })
      }
      return
    default:
      if (key.return) moveCursor(1)
  }
}

export function valueDisplayOf({
  displayDate,
}: {
  displayDate: (value: string, isDateTime: boolean) => string
}): (field: FieldState) => React.ReactNode {
  const valueDisplay = (field: FieldState): React.ReactNode => {
    switch (field.kind) {
      case 'boolean':
        return (
          <Text dimColor={field.value === undefined}>
            {field.value === undefined ? 'not set' : field.value ? 'yes' : 'no'}
          </Text>
        )
      case 'enum':
        return (
          <Text dimColor={field.value === undefined}>
            {'▸ '}
            {typeof field.value === 'string'
              ? getEnumLabel(field.schema, field.value)
              : 'not set'}
          </Text>
        )
      case 'multi': {
        const selected = Array.isArray(field.value) ? field.value : []
        return (
          <Text dimColor={selected.length === 0}>
            {'▸ '}
            {selected.length > 0
              ? selected
                  .map(value => getMultiSelectLabel(field.schema, value))
                  .join(', ')
              : 'not set'}
          </Text>
        )
      }
      case 'raw':
        return <Text dimColor>{JSON.stringify(field.value) ?? 'not set'}</Text>
      default: {
        if (
          isDateTimeSchema(field.schema) &&
          typeof field.value === 'string' &&
          field.value !== ''
        ) {
          const isDateTime =
            (field.schema as { format?: string }).format === 'date-time'
          return <Text>{displayDate(field.value, isDateTime)}</Text>
        }
        return field.text !== '' ? (
          <Text>{field.text}</Text>
        ) : (
          <Text dimColor>not set</Text>
        )
      }
    }
  }
  return valueDisplay
}

export function formDialogView({
  event,
  onResponse,
  fieldFocused,
  buttonFocused,
  accordionOpen,
  footerHint,
  windowStart,
  fields,
  windowEnd,
  cursor,
  statusCell,
  descriptionOf,
  titleOf,
  commitText,
  columns,
  moveCursor,
  valueDisplay,
  accordionWindow,
  accordionIndex,
  acceptIndex,
  declineIndex,
}: {
  event: ElicitationRequestEvent
  onResponse: ElicitationDialogProps['onResponse']
  fieldFocused: boolean
  buttonFocused: boolean
  accordionOpen: boolean
  footerHint: string
  windowStart: number
  fields: FieldState[]
  windowEnd: number
  cursor: number
  statusCell: (field: FieldState, focused: boolean) => { cell: React.ReactNode; tone: string | undefined }
  descriptionOf: (field: FieldState) => string | undefined
  titleOf: (field: FieldState) => string
  commitText: (field: FieldState, text: string) => void
  columns: number
  moveCursor: (delta: 1 | -1, commit?: boolean) => void
  valueDisplay: (field: FieldState) => React.ReactNode
  accordionWindow: ReturnType<typeof popupListWindow>
  accordionIndex: number
  acceptIndex: number
  declineIndex: number
}): React.ReactNode {
  return (
    <Dialog
      title={`"${event.serverName}"`}
      subtitle={event.params.message}
      onCancel={() => onResponse('cancel')}
      isCancelActive={(!fieldFocused || buttonFocused) && !accordionOpen}
      inputGuide={() => <Text italic dimColor>{footerHint}</Text>}
    >
      <Box flexDirection="column">
        {windowStart > 0 ? (
          <Text dimColor>{windowStart} more above</Text>
        ) : null}
        {fields.slice(windowStart, windowEnd).map((field, sliceIndex) => {
          const index = windowStart + sliceIndex
          const focused = index === cursor
          const { cell, tone } = statusCell(field, focused)
          const description = descriptionOf(field)
          const values =
            field.kind === 'multi'
              ? getMultiSelectValues(field.schema)
              : field.kind === 'enum'
                ? getEnumValues(field.schema)
                : []
          const labels =
            field.kind === 'multi'
              ? getMultiSelectLabels(field.schema)
              : field.kind === 'enum'
                ? getEnumLabels(field.schema)
                : []
          return (
            <Box key={field.name} flexDirection="column">
              <Box>
                <Text color={focused ? (tone ?? 'permission') : undefined}>
                  {focused ? `${figures.pointer} ` : '  '}
                </Text>
                {cell}
                <Text bold={focused}> {titleOf(field)} </Text>
                {focused && field.kind === 'text' ? (
                  <TextInput
                    value={field.text}
                    onChange={text => commitText(field, text)}
                    cursorOffset={field.text.length}
                    onChangeCursorOffset={() => {}}
                    columns={Math.max(20, columns - titleOf(field).length - 10)}
                    onSubmit={() => moveCursor(1)}
                  />
                ) : (
                  valueDisplay(field)
                )}
              </Box>
              {description ? (
                <Box paddingLeft={4}>
                  <Text dimColor wrap="wrap">
                    {description}
                  </Text>
                </Box>
              ) : null}
              {focused && accordionOpen ? (
                <Box flexDirection="column" paddingLeft={4}>
                  <PopupListViewport above={accordionWindow.above} below={accordionWindow.below} rows={accordionWindow.end - accordionWindow.start}>
                  {values.slice(accordionWindow.start, accordionWindow.end).map((value, sliceOptionIndex) => {
                    const optionIndex = accordionWindow.start + sliceOptionIndex
                    const selectedValues = Array.isArray(field.value)
                      ? field.value
                      : []
                    const checked =
                      field.kind === 'multi'
                        ? selectedValues.includes(value)
                        : field.value === value
                    return (
                      <Text
                        key={value}
                        inverse={optionIndex === accordionIndex}
                      >
                        {field.kind === 'multi'
                          ? checked
                            ? '[x] '
                            : '[ ] '
                          : checked
                            ? '◉ '
                            : '○ '}
                        {labels[optionIndex] ?? value}
                      </Text>
                    )
                  })}
                  </PopupListViewport>
                </Box>
              ) : null}
              {}
              <Box paddingLeft={4} height={1}>
                <Text color="error">{field.error ?? ' '}</Text>
              </Box>
            </Box>
          )
        })}
        {windowEnd < fields.length ? (
          <Text dimColor>{fields.length - windowEnd} more below</Text>
        ) : null}
        <Box gap={2} marginTop={1}>
          <Text inverse={cursor === acceptIndex}> Accept </Text>
          <Text inverse={cursor === declineIndex}> Decline </Text>
        </Box>
      </Box>
    </Dialog>
  )
}
