// Validation of user keybinding configuration into typed warnings, and the
// warning formatter. The combined validator walks the USER bindings only —
// never the merged default+user list, which would report Mercury's own
// defaults back to the user as their errors.

import { GLYPH } from '../components/mercury-ui/glyphs.js'
import { chordToString } from './parser.js'
import { getReservedShortcuts, normalizeKeyForComparison } from './reservedShortcuts.js'
import type { KeybindingBlock, ParsedBinding } from './types.js'

export type KeybindingWarningType =
  | 'parse_error'
  | 'duplicate'
  | 'reserved'
  | 'invalid_context'
  | 'invalid_action'

export type KeybindingWarning = {
  type: KeybindingWarningType
  severity: 'error' | 'warning'
  message: string
  key?: string
  context?: string
  action?: string
  suggestion?: string
}

// The validator carries its own copy of the validated context list; the two
// lists must agree (the schema module is deliberately not imported here).
const VALID_CONTEXTS = [
  'Global',
  'Chat',
  'Autocomplete',
  'Confirmation',
  'Help',
  'Transcript',
  'HistorySearch',
  'Task',
  'ThemePicker',
  'Settings',
  'Tabs',
  'Attachments',
  'Footer',
  'MessageSelector',
  'DiffDialog',
  'ModelPicker',
  'Select',
  'Extensions',
  'Atlas',
] as const

const COMMAND_BINDING_RE = /^command:[a-zA-Z0-9:\-_]+$/

function isValidContext(context: string): boolean {
  return (VALID_CONTEXTS as readonly string[]).includes(context)
}

/** The closed USER-config context list, for writers: DEFAULT_BINDINGS also
 *  carries feature-gated contexts (Scroll, MessageActions) that must never
 *  reach keybindings.json — the starter template wrote them and then failed
 *  its own validation (TASK-014 w2-f14-04). */
export function isUserConfigContext(context: string): boolean {
  return isValidContext(context)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── keystroke validation ───────────────────────────────────────────────────

/** An empty `+`-separated part, or a keystroke that parses to nothing at
 *  all (no key, no ctrl/alt/shift/meta — super is ignored on purpose). The
 *  whole string is checked as written; multi-step chords are not split. */
function validateKeystroke(keystroke: string, context?: string): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const withContext = (w: KeybindingWarning): KeybindingWarning =>
    context === undefined ? w : { ...w, context }
  const parts = keystroke.split('+')
  if (parts.some(part => part.trim() === '')) {
    warnings.push(
      withContext({
        type: 'parse_error',
        severity: 'error',
        message: `Invalid keystroke "${keystroke}": empty key part`,
        key: keystroke,
        suggestion: 'Remove extra "+" characters',
      }),
    )
    return warnings
  }
  let hasKey = false
  let hasModifier = false
  for (const rawPart of parts) {
    const part = rawPart.trim().toLowerCase()
    if (
      part === 'ctrl' ||
      part === 'control' ||
      part === 'alt' ||
      part === 'opt' ||
      part === 'option' ||
      part === 'shift' ||
      part === 'meta'
    ) {
      hasModifier = true
    } else if (part === 'cmd' || part === 'command' || part === 'super' || part === 'win') {
      // Super does not count toward the emptiness test.
    } else if (part !== '') {
      hasKey = true
    }
  }
  if (!hasKey && !hasModifier) {
    warnings.push(
      withContext({
        type: 'parse_error',
        severity: 'error',
        message: `Invalid keystroke "${keystroke}": no key or modifier`,
        key: keystroke,
      }),
    )
  }
  return warnings
}

// ── structure validation ───────────────────────────────────────────────────

function validateBlock(block: unknown, index: number): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const number = index + 1
  if (!isRecord(block)) {
    return [
      {
        type: 'parse_error',
        severity: 'error',
        message: `Block ${number} is not an object`,
      },
    ]
  }
  let context: string | undefined
  if (typeof block.context !== 'string') {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Block ${number} is missing a "context" string`,
    })
  } else if (!isValidContext(block.context)) {
    warnings.push({
      type: 'invalid_context',
      severity: 'error',
      message: `Unknown context "${block.context}" in block ${number}`,
      context: block.context,
      suggestion: `Valid contexts: ${VALID_CONTEXTS.join(', ')}`,
    })
  } else {
    context = block.context
  }
  if (!isRecord(block.bindings)) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Block ${number} is missing a "bindings" object`,
      ...(context !== undefined ? { context } : {}),
    })
    return warnings
  }
  for (const [keystroke, action] of Object.entries(block.bindings)) {
    warnings.push(...validateKeystroke(keystroke, context))
    if (action === null) continue
    if (typeof action !== 'string') {
      warnings.push({
        type: 'invalid_action',
        severity: 'error',
        message: `Invalid action for "${keystroke}": expected a string or null`,
        key: keystroke,
        ...(context !== undefined ? { context } : {}),
      })
      continue
    }
    if (action.startsWith('command:')) {
      if (!COMMAND_BINDING_RE.test(action)) {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Invalid command binding "${action}": only letters, digits, ":", "-" and "_" are allowed after "command:"`,
          key: keystroke,
          action,
          ...(context !== undefined ? { context } : {}),
        })
      } else if (context !== undefined && context !== 'Chat') {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Command binding "${action}" is declared in the ${context} context but commands only run from the chat input`,
          key: keystroke,
          action,
          context,
          suggestion: 'Move it into a "Chat" block',
        })
      }
    }
  }
  return warnings
}

/** Structure validation of the raw user blocks value. */
export function validateUserConfig(userBlocks: unknown): KeybindingWarning[] {
  if (!Array.isArray(userBlocks)) {
    return [
      {
        type: 'parse_error',
        severity: 'error',
        message: 'The keybindings file must contain an array of binding blocks',
        suggestion: 'Wrap the blocks in brackets: "bindings": [ ... ]',
      },
    ]
  }
  const warnings: KeybindingWarning[] = []
  userBlocks.forEach((block, index) => {
    warnings.push(...validateBlock(block, index))
  })
  return warnings
}

// ── duplicate detection ────────────────────────────────────────────────────

/** JSON parsing keeps the last value for a duplicated key, so duplicates
 *  are found in the raw text: per `bindings` object, count key occurrences
 *  and warn on the SECOND occurrence only. */
export function checkDuplicateKeysInJson(jsonString: string): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const bindingsRe = /"bindings"\s*:\s*\{/g
  let match: RegExpExecArray | null
  while ((match = bindingsRe.exec(jsonString)) !== null) {
    const objectStart = match.index + match[0].length
    // Find the matching close brace.
    let depth = 1
    let i = objectStart
    let inString = false
    for (; i < jsonString.length && depth > 0; i++) {
      const ch = jsonString[i]!
      if (inString) {
        if (ch === '\\') i++
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    const body = jsonString.slice(objectStart, i - 1)
    const before = jsonString.slice(0, match.index)
    const contextMatch = /"context"\s*:\s*"([^"]*)"(?![\s\S]*"context"\s*:\s*")/.exec(before)
    const context = contextMatch?.[1] ?? '(unknown context)'
    const seen = new Map<string, number>()
    const keyRe = /"((?:[^"\\]|\\.)*)"\s*:/g
    let keyMatch: RegExpExecArray | null
    while ((keyMatch = keyRe.exec(body)) !== null) {
      const key = keyMatch[1]!
      const count = (seen.get(key) ?? 0) + 1
      seen.set(key, count)
      if (count === 2) {
        warnings.push({
          type: 'duplicate',
          severity: 'warning',
          message: `Duplicate key "${key}" in ${context} bindings — JSON keeps the last value`,
          key,
          context,
        })
      }
    }
  }
  return warnings
}

/** Cross-entry duplicates within the SAME context that map to DIFFERENT
 *  actions (a null value counts as the string "null"). */
export function checkDuplicates(blocks: KeybindingBlock[]): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const seen = new Map<string, Map<string, string>>()
  for (const block of blocks) {
    const perContext = seen.get(block.context) ?? new Map<string, string>()
    seen.set(block.context, perContext)
    for (const [key, value] of Object.entries(block.bindings)) {
      const normalized = normalizeKeyForComparison(key)
      const action = value === null ? 'null' : value
      const previous = perContext.get(normalized)
      if (previous !== undefined && previous !== action) {
        warnings.push({
          type: 'duplicate',
          severity: 'warning',
          message: `"${key}" in ${block.context} was already bound to ${previous === 'null' ? '(unbind)' : previous}; only the last binding is used`,
          key,
          context: block.context,
          action: previous === 'null' ? '(unbind)' : previous,
        })
      }
      perContext.set(normalized, action)
    }
  }
  return warnings
}

// ── reserved shortcuts ─────────────────────────────────────────────────────

export function checkReservedShortcuts(bindings: ParsedBinding[]): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const reserved = getReservedShortcuts().map(entry => ({
    ...entry,
    normalized: normalizeKeyForComparison(entry.key),
  }))
  for (const binding of bindings) {
    const rendered = chordToString(binding.chord)
    const normalized = normalizeKeyForComparison(rendered)
    for (const entry of reserved) {
      if (entry.normalized !== normalized) continue
      warnings.push({
        type: 'reserved',
        severity: entry.severity,
        message: `"${rendered}" is reserved: ${entry.reason}`,
        key: rendered,
        context: binding.context,
        ...(binding.action !== null ? { action: binding.action } : {}),
      })
    }
  }
  return warnings
}

// ── combined ───────────────────────────────────────────────────────────────

/** Re-parse the user blocks for validation with a simple single-space split
 *  per chord step, independent of the main parser. */
function userBindingsForValidation(blocks: KeybindingBlock[]): ParsedBinding[] {
  const out: ParsedBinding[] = []
  for (const block of blocks) {
    for (const [pattern, action] of Object.entries(block.bindings)) {
      const chord = pattern.split(' ').map(step => {
        const keystroke = {
          key: '',
          ctrl: false,
          alt: false,
          shift: false,
          meta: false,
          super: false,
        }
        for (const rawToken of step.split('+')) {
          const token = rawToken.trim().toLowerCase()
          if (token === 'ctrl' || token === 'control') keystroke.ctrl = true
          else if (token === 'alt' || token === 'opt' || token === 'option') keystroke.alt = true
          else if (token === 'shift') keystroke.shift = true
          else if (token === 'meta') keystroke.meta = true
          else if (token === 'cmd' || token === 'command' || token === 'super' || token === 'win') {
            keystroke.super = true
          } else if (token !== '') keystroke.key = token
        }
        return keystroke
      })
      out.push({ chord, action, context: block.context })
    }
  }
  return out
}

function isBlockShape(value: unknown): value is KeybindingBlock {
  return isRecord(value) && typeof value.context === 'string' && isRecord(value.bindings)
}

/**
 * Structure validation, then — only for a structurally valid array of
 * blocks — duplicate and reserved-shortcut checks over the USER bindings.
 * The second parameter is part of the signature and deliberately unused.
 */
export function validateBindings(userBlocks: unknown, parsedBindings: ParsedBinding[]): KeybindingWarning[] {
  void parsedBindings
  const warnings = validateUserConfig(userBlocks)
  if (Array.isArray(userBlocks) && userBlocks.every(isBlockShape)) {
    warnings.push(...checkDuplicates(userBlocks))
    warnings.push(...checkReservedShortcuts(userBindingsForValidation(userBlocks)))
  }
  const seen = new Set<string>()
  return warnings.filter(w => {
    const id = `${w.type}\x00${w.key ?? ''}\x00${w.context ?? ''}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

// ── formatting ─────────────────────────────────────────────────────────────

export function formatWarning(w: KeybindingWarning): string {
  const glyph = w.severity === 'error' ? GLYPH.fail : GLYPH.warn
  const head = `${glyph} Keybinding ${w.severity}: ${w.message}`
  return w.suggestion ? `${head}\n    ${w.suggestion}` : head
}

export function formatWarnings(ws: KeybindingWarning[]): string {
  if (ws.length === 0) return ''
  const errors = ws.filter(w => w.severity === 'error')
  const warnings = ws.filter(w => w.severity === 'warning')
  const sections: string[] = []
  if (errors.length > 0) {
    sections.push(
      `${errors.length} keybinding error${errors.length === 1 ? '' : 's'}:\n${errors.map(formatWarning).join('\n')}`,
    )
  }
  if (warnings.length > 0) {
    sections.push(
      `${warnings.length} keybinding warning${warnings.length === 1 ? '' : 's'}:\n${warnings.map(formatWarning).join('\n')}`,
    )
  }
  return sections.join('\n\n')
}
