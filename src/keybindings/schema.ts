import { z } from 'zod'
import { KEYBINDING_ACTIONS } from './actionGraph.js'
export { KEYBINDING_ACTIONS } from './actionGraph.js'
import { lazySchema } from '../utils/lazySchema.js'
import { unbuilt, type Unbuilt } from '../pi/holes.js'


export const KEYBINDING_CONTEXTS: Unbuilt = unbuilt('src/keybindings/schema.ts:8')

export const KEYBINDING_CONTEXT_DESCRIPTIONS: Record<(typeof KEYBINDING_CONTEXTS)[number], string> = unbuilt('src/keybindings/schema.ts:30')

export const KeybindingBlockSchema: Unbuilt = unbuilt('src/keybindings/schema.ts:54')

const KeybindingsSchema: Unbuilt = unbuilt('src/keybindings/schema.ts:76')

export type KeybindingsSchemaType = z.infer<ReturnType<typeof KeybindingsSchema>>
