// MCP elicitation — the whole operator-facing side of a server asking for
// input mid-tool-call. One entry point dispatches on the request mode
// (contract data: `form` vs `url`). The parts that look optional are each
// load-bearing: the async date resolution, the per-field abort, the disarmed
// shell cancel while a field is focused, and the two-phase URL flow.

import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PrimitiveSchemaDefinition } from '../../services/mcp/sdk.js'
import { Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import useInput from '../../ink/hooks/use-input.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { ElicitationRequestEvent } from '../../services/mcp/elicitationHandler.js'
import { useNotifyAfterTimeout } from '../../hooks/useNotifyAfterTimeout.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import {
  getEnumLabel,
  getEnumLabels,
  getEnumValues,
  getMultiSelectLabel,
  getMultiSelectLabels,
  getMultiSelectValues,
  isDateTimeSchema,
  isEnumSchema,
  isMultiSelectEnumSchema,
  validateElicitationInput,
  validateElicitationInputAsync,
  type MultiSelectEnumSchema,
} from '../../utils/mcp/elicitationValidation.js'
import { openBrowser } from '../../utils/browser.js'
import { Dialog } from '../design-system/Dialog.js'
import { useNowTick } from '../mercury-ui/components.js'
import TextInput from '../TextInput.js'

const RESOLVE_DEBOUNCE_MS = 2_000
const TYPEAHEAD_RESET_MS = 2_000
const FIELD_LINE_ESTIMATE = 3
const DIALOG_OVERHEAD_LINES = 14

type FieldValue = string | number | boolean | string[]

type FieldKind = 'multi' | 'enum' | 'boolean' | 'text' | 'raw'

type FieldState = {
  name: string
  schema: PrimitiveSchemaDefinition
  kind: FieldKind
  required: boolean
  /** The committed value; undefined = unset. */
  value: FieldValue | undefined
  /** The visible text for text-kind fields. */
  text: string
  error: string | undefined
  resolving: boolean
}

function schemaOf(raw: unknown): PrimitiveSchemaDefinition {
  return (raw ?? { type: 'string' }) as PrimitiveSchemaDefinition
}

function kindOf(schema: PrimitiveSchemaDefinition): FieldKind {
  // Dispatch order is contract: multi-select enum, single-select enum,
  // boolean, text, else raw display.
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

/** Human-readable rendering of a stored ISO date/date-time; verbatim when
 *  unparseable. */
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

/** The resolving spinner: an ~80 ms cadence leaf so a tick repaints only
 *  this glyph, never the whole form. */
function ResolvingSpinner(): React.ReactNode {
  const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  useNowTick(80)
  const frame = Math.floor(Date.now() / 80) % FRAMES.length
  return <Text color="warning">{FRAMES[frame]}</Text>
}

/** Bold the host segment of a URL; an unparseable URL renders whole as the
 *  host. */
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

// ---------------------------------------------------------------------------
// The URL dialog — two phases.
// ---------------------------------------------------------------------------

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

  const showCancel = event.waitingState?.showCancel === true
  const actionLabel =
    event.waitingState?.actionLabel ?? 'Continue without waiting'
  const waitingButtons = [
    'Reopen the URL',
    actionLabel,
    ...(showCancel ? ['Cancel'] : []),
  ]
  const settledDismissal = showCancel ? ('retry' as const) : ('dismiss' as const)

  // The abort signal: in the prompt phase it answers cancel; in the waiting
  // phase the elicitation is already answered, so it reports a cancel
  // dismissal instead.
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  useEffect(() => {
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

  // Server-signalled completion reports the same dismissal as the action
  // button would.
  useEffect(() => {
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
          void openBrowser(url)
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
        void openBrowser(url)
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
      </Box>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// The form dialog.
// ---------------------------------------------------------------------------

type ElicitationDialogProps = {
  event: ElicitationRequestEvent
  onResponse: (
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ) => void
  onWaitingDismiss: (action: 'cancel' | 'retry' | 'dismiss') => void
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
          // A present-but-invalid text default surfaces its error at mount,
          // so a bad server default is visible before submit.
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

  // Cursor over fields + accept + decline, wrapping in both directions; with
  // no fields the accept button starts focused.
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

  useNotifyAfterTimeout(
    `${event.serverName} needs your input`,
    'elicitation_dialog',
  )

  // Unmount aborts every in-flight resolve and clears the debounce timers.
  useEffect(
    () => () => {
      unmountedRef.current = true
      for (const timer of resolveTimersRef.current.values()) clearTimeout(timer)
      for (const controller of resolveAbortsRef.current.values()) {
        controller.abort()
      }
    },
    [],
  )

  // The abort signal answers cancel (also when already aborted at mount).
  useEffect(() => {
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

  const scheduleDateResolve = (field: FieldState, immediately: boolean) => {
    const existingTimer = resolveTimersRef.current.get(field.name)
    if (existingTimer) clearTimeout(existingTimer)
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
              // The canonical text replaces the typed text ONLY if the
              // operator has not typed since.
              ...(typedSince ? {} : { text: String(result.value ?? '') }),
            })
          } else {
            patchField(field.name, { resolving: false, error: result.error })
          }
        })
        .catch(() => {
          if (!unmountedRef.current) patchField(field.name, { resolving: false })
        })
    }
    if (immediately) run()
    else {
      resolveTimersRef.current.set(
        field.name,
        setTimeout(run, RESOLVE_DEBOUNCE_MS),
      )
    }
  }

  const commitText = (field: FieldState, text: string) => {
    typedSinceResolveRef.current.add(field.name)
    const type = (field.schema as { type?: string }).type
    if (text === '') {
      if (type === 'string' && field.value !== undefined) {
        // A plain string that was already set stores the empty string.
        patchField(field.name, { text, value: '', error: undefined })
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

  /** Moving off a field commits it: bounds revalidate, accordions collapse,
   *  pending date resolves run immediately. */
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
    // The minimum check is skipped when the field is optional and nothing
    // is selected.
    if (selected.length === 0 && !field.required) return undefined
    if (schema.minItems !== undefined && selected.length < schema.minItems) {
      return `Select at least ${schema.minItems}`
    }
    if (schema.maxItems !== undefined && selected.length > schema.maxItems) {
      return `Select at most ${schema.maxItems}`
    }
    return undefined
  }

  const moveCursor = (delta: 1 | -1) => {
    commitOnLeave(cursor)
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
    // The wire payload keeps JSON types, never display strings.
    const content: Record<string, string | number | boolean | string[]> = {}
    for (const field of fields) {
      if (field.value !== undefined) content[field.name] = field.value
    }
    onResponse('accept', content)
  }

  const focusedField = cursor < fields.length ? fields[cursor] : undefined
  const fieldFocused = focusedField !== undefined
  const buttonFocused = cursor >= fields.length

  // Escape while a field is focused and no accordion is open resolves
  // through the confirm-no action in the shared settings context — the
  // dialog shell's own cancel is deliberately disarmed in that state.
  useKeybinding(
    'confirm:no',
    () => {
      if (focusedField && focusedField.kind === 'text') {
        // Revert uncommitted text to the stored value first.
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
      // A single-select opens focused on its current value.
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
    // Bounds are enforced on every toggle.
    patchField(field.name, {
      value: selected,
      error: multiBoundsError(next as FieldState),
    })
  }

  useInput((input, key) => {
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
        // Off the top collapses and stays on the field.
        if (accordionIndex === 0) setAccordionOpen(false)
        else setAccordionIndex(accordionIndex - 1)
      } else if (key.downArrow) {
        // Off the bottom collapses AND advances.
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
          // Enter checks, never unchecks.
          toggleMultiValue(field, value, true)
        } else {
          patchField(field.name, { value, error: undefined })
        }
        setAccordionOpen(false)
        moveCursor(1)
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
          // An unset field toggles to true.
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
        // Backspace on an already-empty text field unsets it; every other
        // keystroke belongs to the mounted text input.
        if ((key.backspace || key.delete) && field.text === '') {
          patchField(field.name, { value: undefined, error: undefined })
        }
        return
      default:
        if (key.return) moveCursor(1)
    }
  })

  // Item-count scroll window: fixed per-field estimate against the terminal
  // rows, floor 2; centred on focus, clamped, pinned to the end while a
  // button is focused (Q4 — an expanded accordion can exceed this).
  const maxVisible = Math.max(
    2,
    Math.floor((rows - DIALOG_OVERHEAD_LINES) / FIELD_LINE_ESTIMATE),
  )
  let windowStart = 0
  if (fields.length > maxVisible) {
    if (buttonFocused) {
      windowStart = fields.length - maxVisible
    } else {
      windowStart = Math.min(
        Math.max(0, cursor - Math.floor(maxVisible / 2)),
        fields.length - maxVisible,
      )
    }
  }
  const windowEnd = Math.min(fields.length, windowStart + maxVisible)

  const statusCell = (field: FieldState, focused: boolean) => {
    // Five-way priority: resolving spinner, error mark, set mark, required
    // mark, blank. The colour role doubles as the row's selection colour.
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

  const footerHint = (() => {
    const parts = ['esc cancel', '↑↓ move']
    if (focusedField) {
      parts.push('⌫ unset')
      if (focusedField.kind === 'boolean') parts.push('space toggle')
      if (focusedField.kind === 'enum' || focusedField.kind === 'multi') {
        parts.push(accordionOpen ? 'space select · ↵ pick' : '→ expand')
      }
    }
    return parts.join(' · ')
  })()

  return (
    <Dialog
      title={`"${event.serverName}"`}
      subtitle={event.params.message}
      onCancel={() => onResponse('cancel')}
      // The shell's cancel is armed only when no field is focused (or a
      // button is), and no accordion is open.
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
                  {values.map((value, optionIndex) => {
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
                </Box>
              ) : null}
              {/* The fixed one-row error slot: present whether or not there
                  is an error, so the form never jumps. */}
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

// ---------------------------------------------------------------------------
// Entry point: dispatch on the request mode (contract data: form vs url).
// ---------------------------------------------------------------------------

export function ElicitationDialog(props: ElicitationDialogProps): React.ReactNode {
  const mode = props.event.params.mode
  // Both dialogs raise the idle "needs your input" notification; the form
  // dialog registers its own (it owns more state), the URL dialog here.
  const isUrl = mode === 'url'
  return isUrl ? (
    <UrlNotifyWrapper {...props} />
  ) : (
    <FormElicitationDialog {...props} />
  )
}

function UrlNotifyWrapper(props: ElicitationDialogProps): React.ReactNode {
  useNotifyAfterTimeout(
    `${props.event.serverName} needs your input`,
    'elicitation_url_dialog',
  )
  return <UrlElicitationDialog {...props} />
}

export default ElicitationDialog
