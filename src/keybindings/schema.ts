// The validation schema for keybindings.json plus the context-name
// vocabulary. The action-id vocabulary is derived from the action registry —
// never hand-listed.

import { z } from 'zod'
import { KEYBINDING_ACTIONS } from './actionGraph.js'
export { KEYBINDING_ACTIONS } from './actionGraph.js'
import { lazySchema } from '../utils/lazySchema.js'


/** The validated context names, in this order. The validator carries the
 *  same list on its own (it does not import this module). */
export const KEYBINDING_CONTEXTS = [
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

export const KEYBINDING_CONTEXT_DESCRIPTIONS: Record<(typeof KEYBINDING_CONTEXTS)[number], string> = {
  Global: 'Active everywhere, regardless of focus',
  Chat: 'The chat input is focused',
  Autocomplete: 'The autocomplete menu is visible',
  Confirmation: 'A confirmation or permission dialog is shown',
  Help: 'The help overlay is open',
  Transcript: 'The transcript is being viewed',
  HistorySearch: 'Command-history search is active',
  Task: 'A task or agent is running in the foreground',
  ThemePicker: 'The theme picker is open',
  Settings: 'The settings menu is open',
  Tabs: 'Tab navigation is active',
  Attachments: 'Image attachments are being navigated in a select dialog',
  Footer: 'Footer indicators are focused',
  MessageSelector: 'The message selector (rewind) is open',
  DiffDialog: 'The diff dialog is open',
  ModelPicker: 'The model picker is open',
  Select: 'A select/list component is focused',
  Extensions: 'The extensions board is open',
  Atlas: 'The /keys input atlas is open',
}

const COMMAND_BINDING_RE = /^command:[a-zA-Z0-9:\-_]+$/

export const KeybindingBlockSchema = lazySchema(() =>
  z.object({
    context: z
      .enum(KEYBINDING_CONTEXTS)
      .describe('The UI context in which these bindings apply'),
    bindings: z
      .record(
        z.string().describe('A keystroke pattern such as "ctrl+k" or "ctrl+x p"'),
        z
          .union([
            z.enum(KEYBINDING_ACTIONS as unknown as [string, ...string[]]),
            z.string().regex(COMMAND_BINDING_RE),
            z.null(),
          ])
          .describe(
            'A built-in action id, a command:<name> binding that runs the slash command as if typed, or null to unbind a default shortcut',
          ),
      )
      .describe('Keystroke pattern → action'),
  }),
)

export const KeybindingsSchema = lazySchema(() =>
  z.object({
    $schema: z.string().optional().describe('A JSON-Schema URL for editor validation'),
    $docs: z.string().optional().describe('A documentation URL'),
    bindings: z.array(KeybindingBlockSchema()).describe('The binding blocks, in override order'),
  }),
)

export type KeybindingsSchemaType = z.infer<ReturnType<typeof KeybindingsSchema>>
