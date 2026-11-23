import { chordToString, parseBindings } from './parser.js'
import { getReservedShortcuts, normalizeKeyForComparison } from './reservedShortcuts.js'
import type { KeybindingBlock, ParsedBinding } from './types.js'
import { isRecord } from '../utils/isRecord.js'

export type KeybindingWarning = {
  type: 'parse_error' | 'duplicate' | 'reserved' | 'invalid_context' | 'invalid_action'
  severity: 'error' | 'warning'
  message: string
  key?: string
  context?: string
  action?: string
  suggestion?: string
}

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

export function isUserConfigContext(context: string): boolean {
  return isValidContext(context)
}


const RECOGNISED_MODIFIERS = new Set(['ctrl', 'control', 'alt', 'opt', 'option', 'shift', 'meta'])
const IGNORED_MODIFIERS = new Set(['cmd', 'command', 'super', 'win'])

function validateKeystroke(keystroke: string, context: string | undefined): KeybindingWarning[] {
  const parts = keystroke.split('+')
  let hasModifier = false
  let hasKey = false
  for (const rawPart of parts) {
    const part = rawPart.trim().toLowerCase()
    if (!part) {
      return [
        {
          type: 'parse_error',
          severity: 'error',
          key: keystroke,
          context,
          message: `Invalid keystroke "${keystroke}": empty key part`,
          suggestion: 'Remove extra "+" characters',
        },
      ]
    }
    if (RECOGNISED_MODIFIERS.has(part)) {
      hasModifier = true
    } else if (!IGNORED_MODIFIERS.has(part)) {
      hasKey = true
    }
  }
  if (!hasModifier && !hasKey) {
    return [
      {
        type: 'parse_error',
        severity: 'error',
        key: keystroke,
        context,
        message: `Invalid keystroke "${keystroke}": no key or modifier`,
      },
    ]
  }
  return []
}

function validateBlock(block: unknown, index: number): KeybindingWarning[] {
  const blockNumber = index + 1
  if (!isRecord(block)) {
    return [
      {
        type: 'parse_error',
        severity: 'error',
        message: `Block ${blockNumber} is not an object`,
      },
    ]
  }
  const warnings: KeybindingWarning[] = []
  let context: string | undefined
  if (typeof block.context !== 'string') {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Block ${blockNumber} is missing a "context" string`,
    })
  } else {
    context = block.context
    if (!isValidContext(context)) {
      warnings.push({
        type: 'invalid_context',
        severity: 'error',
        context,
        message: `Unknown context "${context}" in block ${blockNumber}`,
        suggestion: `Valid contexts: ${VALID_CONTEXTS.join(', ')}`,
      })
    }
  }
  if (!isRecord(block.bindings)) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      context,
      message: `Block ${blockNumber} is missing a "bindings" object`,
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
        key: keystroke,
        context,
        message: `Invalid action for "${keystroke}": expected a string or null`,
      })
      continue
    }
    if (action.startsWith('command:')) {
      if (!COMMAND_BINDING_RE.test(action)) {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          key: keystroke,
          context,
          action,
          message: `Invalid command binding "${action}": only letters, digits, ":", "-" and "_" are allowed after "command:"`,
        })
      } else if (context !== undefined && context !== 'Chat' && context !== 'Global') {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          key: keystroke,
          context,
          action,
          message: `Command binding "${action}" is declared in the ${context} context but commands only run from the chat input (a Chat or Global binding)`,
          suggestion: 'Move it into a "Chat" or "Global" block',
        })
      }
    }
  }
  return warnings
}

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


function readJsonString(src: string, start: number): { value: string; end: number } | null {
  if (src[start] !== '"') return null
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"') {
      const raw = src.slice(start, i + 1)
      let value: string
      try {
        value = JSON.parse(raw) as string
      } catch {
        value = src.slice(start + 1, i)
      }
      return { value, end: i + 1 }
    }
    i++
  }
  return null
}

function skipWhitespace(src: string, pos: number): number {
  let i = pos
  while (i < src.length) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++
    else break
  }
  return i
}

function findPrecedingContext(prefix: string): string {
  const matches = [...prefix.matchAll(/"context"\s*:\s*"((?:\\.|[^"\\])*)"/g)]
  const last = matches.at(-1)
  if (!last) return '(unknown context)'
  try {
    return JSON.parse(`"${last[1]}"`) as string
  } catch {
    return last[1] ?? '(unknown context)'
  }
}

export function checkDuplicateKeysInJson(jsonString: string): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  let i = 0
  while (i < jsonString.length) {
    if (jsonString[i] !== '"') {
      i++
      continue
    }
    const keyStart = i
    const token = readJsonString(jsonString, i)
    if (!token) break
    i = token.end
    const colonPos = skipWhitespace(jsonString, i)
    if (token.value !== 'bindings' || jsonString[colonPos] !== ':') continue
    const openPos = skipWhitespace(jsonString, colonPos + 1)
    if (jsonString[openPos] !== '{') continue
    const context = findPrecedingContext(jsonString.slice(0, keyStart))
    const counts = new Map<string, number>()
    let depth = 1
    let p = openPos + 1
    while (p < jsonString.length && depth > 0) {
      const ch = jsonString[p]
      if (ch === '"') {
        const str = readJsonString(jsonString, p)
        if (!str) break
        p = str.end
        if (depth === 1) {
          const after = skipWhitespace(jsonString, p)
          if (jsonString[after] === ':') {
            const count = (counts.get(str.value) ?? 0) + 1
            counts.set(str.value, count)
            if (count === 2) {
              warnings.push({
                type: 'duplicate',
                severity: 'warning',
                key: str.value,
                context,
                message: `Duplicate key "${str.value}" in ${context} bindings — JSON keeps the last value`,
              })
            }
            p = after + 1
          }
        }
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') depth--
      p++
    }
    i = p
  }
  return warnings
}

const CASE_KEPT_CONTEXTS: ReadonlySet<string> = new Set(['Extensions'])

function duplicateKeyOf(context: string, key: string): string {
  const bare = key.trim()
  return CASE_KEPT_CONTEXTS.has(context) && bare.length === 1 ? bare : normalizeKeyForComparison(key)
}

function checkDuplicates(blocks: KeybindingBlock[]): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const seenByContext = new Map<string, Map<string, string | null>>()
  for (const block of blocks) {
    let seen = seenByContext.get(block.context)
    if (!seen) {
      seen = new Map()
      seenByContext.set(block.context, seen)
    }
    for (const [key, action] of Object.entries(block.bindings)) {
      const normalized = duplicateKeyOf(block.context, key)
      if (seen.has(normalized)) {
        const previous = seen.get(normalized) ?? null
        if (previous !== action) {
          warnings.push({
            type: 'duplicate',
            severity: 'warning',
            key,
            context: block.context,
            action: action ?? undefined,
            message: `"${key}" in ${block.context} was already bound to ${previous ?? '(unbind)'}; only the last binding is used`,
          })
        }
      }
      seen.set(normalized, action)
    }
  }
  return warnings
}

export function checkReservedShortcuts(bindings: ParsedBinding[]): KeybindingWarning[] {
  const reservedByKey = new Map(
    getReservedShortcuts().map(entry => [normalizeKeyForComparison(entry.key), entry]),
  )
  const warnings: KeybindingWarning[] = []
  for (const binding of bindings) {
    const rendered = chordToString(binding.chord)
    const entry = reservedByKey.get(normalizeKeyForComparison(rendered))
    if (!entry) continue
    warnings.push({
      type: 'reserved',
      severity: entry.severity,
      key: rendered,
      context: binding.context,
      action: binding.action ?? undefined,
      message: `"${rendered}" is reserved: ${entry.reason}`,
    })
  }
  return warnings
}

function userBindingsForValidation(blocks: KeybindingBlock[]): ParsedBinding[] {
  return parseBindings(blocks)
}

function isBlockShape(value: unknown): value is KeybindingBlock {
  return isRecord(value) && typeof value.context === 'string' && isRecord(value.bindings)
}

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
