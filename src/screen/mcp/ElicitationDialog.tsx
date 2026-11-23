
import * as React from 'react'
import { useRef, useState } from 'react'
import { useClaim, usePublish } from '../effects/effects.js'
import type { PrimitiveSchemaDefinition } from '../../integrations/mcp-shapes/sdk.js'
import { Box, Text } from '../themedRenderer.js'
import { popupListWindow, usePopupListPaging } from '../select/popup-list.js'
import useInput from '../renderer/bindings/use-input.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { getEnumLabels, getEnumValues, getMultiSelectLabels, getMultiSelectValues, isDateTimeSchema, isEnumSchema, isMultiSelectEnumSchema, validateElicitationInput, type MultiSelectEnumSchema } from '../../integrations/mcp/elicitationValidation.js'
import { openBrowser } from '../../platform/host-os/browser.js'
import { Dialog } from '../theme/Dialog.js'
import { useNowTick } from '../widgets/components.js'
import { scheduleDateResolveOf, commitTextOf, formKeysOf, valueDisplayOf, formDialogView, type FieldValue, type FieldKind, type FieldState, type ElicitationDialogProps } from './elicitation-dialog/form.js'
import { stopTimeout } from '../../platform/async/timers.js'

const RESOLVE_DEBOUNCE_MS = 2_000
const TYPEAHEAD_RESET_MS = 2_000
const FIELD_LINE_ESTIMATE = 3
const DIALOG_OVERHEAD_LINES = 14

function schemaOf(raw: unknown): PrimitiveSchemaDefinition {
  return (raw ?? { type: 'string' }) as PrimitiveSchemaDefinition
}

function kindOf(schema: PrimitiveSchemaDefinition): FieldKind {
  if (isMultiSelectEnumSchema(schema)) return 'multi'
  if (isEnumSchema(schema)) return 'enum'
  const type = (schema as { type?: string }).type
  if (type === 'boolean') return 'boolean'
  if (type === 'string' || type === 'number' || type === 'integer') {
    return 'text'
  }
  return 'raw'
}

function titleOf(field: FieldState): string {
  return (field.schema as { title?: string }).title ?? field.name
}

function descriptionOf(field: FieldState): string | undefined {
  return (field.schema as { description?: string }).description
}

function isEmptyValue(value: FieldValue | undefined): boolean {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'string') return value === ''
  return false
}

function displayDate(value: string, isDateTime: boolean): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(isDateTime
        ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
        : {}),
    }).format(parsed)
  } catch {
    return value
  }
}

function ResolvingSpinner(): React.ReactNode {
  const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  useNowTick(80)
  const frame = Math.floor(Date.now() / 80) % FRAMES.length
  return <Text color="warning">{FRAMES[frame]}</Text>
}

function UrlWithBoldHost({ url }: { url: string }): React.ReactNode {
  try {
    const parsed = new URL(url)
    const hostStart = url.indexOf(parsed.host)
    if (hostStart === -1) throw new Error('host not in string')
    return (
      <Text wrap="wrap">
        {url.slice(0, hostStart)}
        <Text bold>{parsed.host}</Text>
        {url.slice(hostStart + parsed.host.length)}
      </Text>
    )
  } catch {
    return (
      <Text bold wrap="wrap">
        {url}
      </Text>
    )
  }
}


function UrlElicitationDialog({
  event,
  onResponse,
  onWaitingDismiss,
}: ElicitationDialogProps): React.ReactNode {
  const serverName = event.serverName
  const url = event.params.url ?? ''
  const [phase, setPhase] = useState<'prompt' | 'waiting'>('prompt')
  const [promptButton, setPromptButton] = useState<0 | 1>(0)
  const [waitingButton, setWaitingButton] = useState(0)
  const [openError, setOpenError] = useState<string | null>(null)
  const openUrl = (): void => {
    setOpenError(null)
    void openBrowser(url, error => {
      setOpenError(`${url} could not be opened (${error}) — open it yourself`)
    })
  }

  const showCancel = event.waitingState?.showCancel === true
  const actionLabel =
    event.waitingState?.actionLabel ?? 'Continue without waiting'
  const waitingButtons = [
    'Reopen the URL',
    actionLabel,
    ...(showCancel ? ['Cancel'] : []),
  ]
  const settledDismissal = showCancel ? ('retry' as const) : ('dismiss' as const)

  const phaseRef = useRef(phase)
  phaseRef.current = phase
  useClaim(() => {
    const onAbort = () => {
      if (phaseRef.current === 'waiting') onWaitingDismiss('cancel')
      else onResponse('cancel')
    }
    if (event.signal.aborted) {
      onAbort()
      return
    }
    event.signal.addEventListener('abort', onAbort)
    return () => event.signal.removeEventListener('abort', onAbort)
  }, [event.signal, onResponse, onWaitingDismiss])

  usePublish(() => {
    if (phase === 'waiting' && event.completed) {
      onWaitingDismiss(settledDismissal)
    }
  }, [phase, event.completed, onWaitingDismiss, settledDismissal])

  useInput((_input, key) => {
    if (phase === 'prompt') {
      if (key.leftArrow) setPromptButton(0)
      else if (key.rightArrow) setPromptButton(1)
      else if (key.return) {
        if (promptButton === 0) {
          openUrl()
          onResponse('accept')
          setWaitingButton(0)
          setPhase('waiting')
        } else {
          onResponse('decline')
        }
      }
      return
    }
    if (key.leftArrow) {
      setWaitingButton(index =>
        (index + waitingButtons.length - 1) % waitingButtons.length,
      )
    } else if (key.rightArrow) {
      setWaitingButton(index => (index + 1) % waitingButtons.length)
    } else if (key.return) {
      if (waitingButton === 0) {
        openUrl()
      } else if (showCancel && waitingButton === waitingButtons.length - 1) {
        onWaitingDismiss('cancel')
      } else {
        onWaitingDismiss(settledDismissal)
      }
    }
  })

  return (
    <Dialog
      title={`"${serverName}"`}
      subtitle={event.params.message}
      onCancel={() => {
        if (phase === 'waiting') onWaitingDismiss('cancel')
        else onResponse('cancel')
      }}
    >
      <Box flexDirection="column" gap={1}>
        {phase === 'prompt' ? (
          <>
            <UrlWithBoldHost url={url} />
            {event.riskPosture ? <Text dimColor>{event.riskPosture}</Text> : null}
            <Box gap={2}>
              <Text inverse={promptButton === 0}> Open and accept </Text>
              <Text inverse={promptButton === 1}> Decline </Text>
            </Box>
          </>
        ) : (
          <>
            <Text dimColor>
              Waiting for {serverName} to confirm completion…
            </Text>
            <Box gap={2}>
              {waitingButtons.map((label, index) => (
                <Text key={label} inverse={waitingButton === index}>
                  {' '}
                  {label}{' '}
                </Text>
              ))}
            </Box>
          </>
        )}
        {openError !== null ? <Text color="warning">{openError}</Text> : null}
      </Box>
    </Dialog>
  )
}


function FormElicitationDialog({
  event,
  onResponse,
}: ElicitationDialogProps): React.ReactNode {
  const { rows, columns } = useTerminalSize()
  const requestedSchema = event.params.requestedSchema as
    | {
        properties?: Record<string, unknown>
        required?: string[]
      }
    | undefined

  const [fields, setFields] = useState<FieldState[]>(() => {
    const requiredNames = new Set(requestedSchema?.required ?? [])
    return Object.entries(requestedSchema?.properties ?? {}).map(
      ([name, rawSchema]) => {
        const schema = schemaOf(rawSchema)
        const kind = kindOf(schema)
        const defaultValue = (schema as { default?: FieldValue }).default
        let value: FieldValue | undefined = defaultValue
        let text = ''
        let error: string | undefined
        if (defaultValue !== undefined && kind === 'text') {
          text = String(defaultValue)
          const result = validateElicitationInput(text, schema)
          if (result.isValid) {
            value = result.value
          } else {
            value = undefined
            error = result.error
          }
        }
        return {
          name,
          schema,
          kind,
          required: requiredNames.has(name),
          value,
          text,
          error,
          resolving: false,
        }
      },
    )
  })

  const acceptIndex = fields.length
  const declineIndex = fields.length + 1
  const [cursor, setCursor] = useState(() =>
    fields.length === 0 ? acceptIndex : 0,
  )
  const [accordionOpen, setAccordionOpen] = useState(false)
  const [accordionIndex, setAccordionIndex] = useState(0)

  const typeaheadRef = useRef({ buffer: '', at: 0 })
  const resolveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const resolveAbortsRef = useRef(new Map<string, AbortController>())
  const typedSinceResolveRef = useRef(new Set<string>())
  const unmountedRef = useRef(false)

  useClaim(
    () => () => {
      unmountedRef.current = true
      for (const timer of resolveTimersRef.current.values()) stopTimeout(timer)
      for (const controller of resolveAbortsRef.current.values()) {
        controller.abort()
      }
    },
    [],
  )

  useClaim(() => {
    const onAbort = () => onResponse('cancel')
    if (event.signal.aborted) {
      onAbort()
      return
    }
    event.signal.addEventListener('abort', onAbort)
    return () => event.signal.removeEventListener('abort', onAbort)
  }, [event.signal, onResponse])

  const patchField = (name: string, patch: Partial<FieldState>) => {
    setFields(previous =>
      previous.map(field =>
        field.name === name ? { ...field, ...patch } : field,
      ),
    )
  }

  const scheduleDateResolve = (field: FieldState, immediately: boolean) => scheduleDateResolveOf({ resolveTimersRef, resolveAbortsRef, typedSinceResolveRef, patchField, unmountedRef, RESOLVE_DEBOUNCE_MS }, field, immediately)

  const commitText = (field: FieldState, text: string) => commitTextOf({ resolveTimersRef, resolveAbortsRef, patchField, typedSinceResolveRef, scheduleDateResolve }, field, text)

  const commitOnLeave = (index: number) => {
    const field = fields[index]
    if (!field) return
    if (accordionOpen) setAccordionOpen(false)
    if (field.kind === 'multi') {
      const error = multiBoundsError(field)
      patchField(field.name, { error })
    }
    if (
      field.kind === 'text' &&
      isDateTimeSchema(field.schema) &&
      resolveTimersRef.current.has(field.name)
    ) {
      scheduleDateResolve(field, true)
    }
  }

  const multiBoundsError = (field: FieldState): string | undefined => {
    const schema = field.schema as MultiSelectEnumSchema
    const selected = Array.isArray(field.value) ? field.value : []
    if (selected.length === 0 && !field.required) return undefined
    if (schema.minItems !== undefined && selected.length < schema.minItems) {
      return `Select at least ${schema.minItems}`
    }
    if (schema.maxItems !== undefined && selected.length > schema.maxItems) {
      return `Select at most ${schema.maxItems}`
    }
    return undefined
  }

  const moveCursor = (delta: 1 | -1, commit = true) => {
    if (commit) commitOnLeave(cursor)
    setCursor(previous => (previous + delta + fields.length + 2) % (fields.length + 2))
  }

  const submitAccept = () => {
    const missing = fields.filter(
      field => field.required && isEmptyValue(field.value),
    )
    const anyErrors = fields.some(field => field.error !== undefined)
    if (missing.length > 0 || anyErrors) {
      if (missing.length > 0) {
        setFields(previous =>
          previous.map(field =>
            field.required && isEmptyValue(field.value)
              ? { ...field, error: 'Required' }
              : field,
          ),
        )
        const firstIndex = fields.findIndex(
          field => field.required && isEmptyValue(field.value),
        )
        if (firstIndex !== -1) setCursor(firstIndex)
      } else {
        const firstError = fields.findIndex(field => field.error !== undefined)
        if (firstError !== -1) setCursor(firstError)
      }
      return
    }
    const content: Record<string, string | number | boolean | string[]> = {}
    for (const field of fields) {
      if (field.value !== undefined) content[field.name] = field.value
    }
    onResponse('accept', content)
  }

  const focusedField = cursor < fields.length ? fields[cursor] : undefined
  const fieldFocused = focusedField !== undefined
  const buttonFocused = cursor >= fields.length

  useKeybinding(
    'confirm:no',
    () => {
      if (focusedField && focusedField.kind === 'text') {
        patchField(focusedField.name, {
          text: focusedField.value !== undefined ? String(focusedField.value) : '',
        })
      }
      onResponse('cancel')
    },
    { context: 'Settings', isActive: fieldFocused && !accordionOpen },
  )

  const expandAccordion = (field: FieldState, jumpTo?: number) => {
    setAccordionOpen(true)
    if (jumpTo !== undefined) {
      setAccordionIndex(jumpTo)
      return
    }
    if (field.kind === 'enum') {
      const values = getEnumValues(field.schema)
      const current = typeof field.value === 'string' ? values.indexOf(field.value) : -1
      setAccordionIndex(current === -1 ? 0 : current)
    } else {
      setAccordionIndex(0)
    }
  }

  const typeahead = (field: FieldState, input: string): void => {
    const now = Date.now()
    const state = typeaheadRef.current
    state.buffer =
      now - state.at > TYPEAHEAD_RESET_MS ? input : state.buffer + input
    state.at = now
    if (field.kind === 'boolean') {
      const lower = state.buffer.toLowerCase()
      if ('yes'.startsWith(lower)) {
        patchField(field.name, { value: true, error: undefined })
      } else if ('no'.startsWith(lower)) {
        patchField(field.name, { value: false, error: undefined })
      }
      return
    }
    const labels =
      field.kind === 'multi'
        ? getMultiSelectLabels(field.schema)
        : getEnumLabels(field.schema)
    const match = labels.findIndex(label =>
      label.toLowerCase().startsWith(state.buffer.toLowerCase()),
    )
    if (!accordionOpen) expandAccordion(field, match === -1 ? 0 : match)
    else if (match !== -1) setAccordionIndex(match)
  }

  const toggleMultiValue = (field: FieldState, value: string, checkOnly: boolean) => {
    const selected = Array.isArray(field.value) ? [...field.value] : []
    const at = selected.indexOf(value)
    if (at === -1) selected.push(value)
    else if (!checkOnly) selected.splice(at, 1)
    const next = { ...field, value: selected as FieldValue }
    patchField(field.name, {
      value: selected,
      error: multiBoundsError(next as FieldState),
    })
  }

  useInput((input, key) => formKeysOf({ buttonFocused, setCursor, cursor, acceptIndex, declineIndex, moveCursor, submitAccept, onResponse, focusedField, accordionOpen, accordionIndex, setAccordionOpen, setAccordionIndex, toggleMultiValue, patchField, typeahead, expandAccordion }, input, key))

  const maxVisible = accordionOpen ? 1 : Math.max(1, Math.floor((rows - DIALOG_OVERHEAD_LINES) / FIELD_LINE_ESTIMATE))
  const fieldWindow = popupListWindow(fields.length, buttonFocused ? fields.length - 1 : cursor, maxVisible)
  const windowStart = fieldWindow.start
  const windowEnd = fieldWindow.end
  const accordionValues = focusedField?.kind === 'multi' ? getMultiSelectValues(focusedField.schema) : focusedField?.kind === 'enum' ? getEnumValues(focusedField.schema) : []
  const accordionWindow = popupListWindow(accordionValues.length, accordionIndex, Math.max(1, rows - DIALOG_OVERHEAD_LINES - FIELD_LINE_ESTIMATE))
  usePopupListPaging(cursor, fields.length + 2, maxVisible, target => { commitOnLeave(cursor); setCursor(target) }, !accordionOpen)
  usePopupListPaging(accordionIndex, accordionValues.length, accordionWindow.end - accordionWindow.start, setAccordionIndex, accordionOpen)

  const statusCell = (field: FieldState, focused: boolean) => {
    if (field.resolving) {
      return { cell: <ResolvingSpinner />, tone: 'warning' as string | undefined }
    }
    if (field.error !== undefined) {
      return { cell: <Text color="error">✗</Text>, tone: 'error' }
    }
    if (!isEmptyValue(field.value)) {
      return { cell: <Text color="success">✓</Text>, tone: 'success' }
    }
    if (field.required) {
      return { cell: <Text color={focused ? 'error' : 'warning'}>*</Text>, tone: focused ? 'error' : 'warning' }
    }
    return { cell: <Text> </Text>, tone: undefined }
  }

  const valueDisplay = valueDisplayOf({ displayDate })

  const footerHint = (() => {
    const parts = ['esc cancel', '↑↓ move', 'pgup/pgdn page']
    if (focusedField) {
      parts.push('⌫ unset')
      if (focusedField.kind === 'boolean') parts.push('space toggle')
      if (focusedField.kind === 'enum' || focusedField.kind === 'multi') {
        parts.push(accordionOpen ? 'space select · ↵ pick' : '→ expand')
      }
    }
    return parts.join(' · ')
  })()

  return formDialogView({ event, onResponse, fieldFocused, buttonFocused, accordionOpen, footerHint, windowStart, fields, windowEnd, cursor, statusCell, descriptionOf, titleOf, commitText, columns, moveCursor, valueDisplay, accordionWindow, accordionIndex, acceptIndex, declineIndex })
}


export function ElicitationDialog(props: ElicitationDialogProps): React.ReactNode {
  const mode = props.event.params.mode
  const isUrl = mode === 'url'
  return isUrl ? (
    <UrlElicitationDialog {...props} />
  ) : (
    <FormElicitationDialog {...props} />
  )
}

export default ElicitationDialog
