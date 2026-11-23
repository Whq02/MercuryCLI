import { z } from 'zod'
import { KEYBINDING_ACTIONS } from './actionGraph.js'
export { KEYBINDING_ACTIONS } from './actionGraph.js'
import { lazySchema } from '../utils/lazySchema.js'
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
  Task: 'A task or crewmate is running in the foreground',
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

export const KeybindingBlockSchema = lazySchema(() =>
  z.object({
    context: z.enum(KEYBINDING_CONTEXTS),
    bindings: z.record(
      z.string(),
      z.union([
        z.enum(KEYBINDING_ACTIONS),
        z.string().regex(/^command:[a-zA-Z0-9:\-_]+$/),
        z.null(),
      ]),
    ),
  }),
)

const KeybindingsSchema = lazySchema(() =>
  z.object({
    $schema: z.string().optional(),
    $docs: z.string().optional(),
    bindings: z.array(KeybindingBlockSchema()),
  }),
)

export type KeybindingsSchemaType = z.infer<ReturnType<typeof KeybindingsSchema>>
