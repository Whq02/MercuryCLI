import { chordToString } from './parser.js'
import { getReservedShortcuts, normalizeKeyForComparison } from './reservedShortcuts.js'
import type { KeybindingBlock, ParsedBinding } from './types.js'
import { isRecord } from '../utils/isRecord.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type KeybindingWarning = Unbuilt

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


function validateBlock(block: unknown, index: number): KeybindingWarning[] {
  return notBuilt('src/keybindings/validate.ts:107')
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


export function checkDuplicateKeysInJson(jsonString: string): KeybindingWarning[] {
  return notBuilt('src/keybindings/validate.ts:204')
}

const CASE_KEPT_CONTEXTS: ReadonlySet<string> = new Set(['Extensions'])

function duplicateKeyOf(context: string, key: string): string {
  const bare = key.trim()
  return CASE_KEPT_CONTEXTS.has(context) && bare.length === 1 ? bare : normalizeKeyForComparison(key)
}

function checkDuplicates(blocks: KeybindingBlock[]): KeybindingWarning[] {
  return notBuilt('src/keybindings/validate.ts:256')
}


export function checkReservedShortcuts(bindings: ParsedBinding[]): KeybindingWarning[] {
  return notBuilt('src/keybindings/validate.ts:283')
}


function userBindingsForValidation(blocks: KeybindingBlock[]): ParsedBinding[] {
  return notBuilt('src/keybindings/validate.ts:308')
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
