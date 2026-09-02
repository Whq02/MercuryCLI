import type { ActionGraph } from './actionGraph.js'
/**
 * Core type definitions for the keybindings subsystem.
 *
 * This module is the single source of truth for the shapes used across
 * `src/keybindings/*` (parser, resolver, matcher, loader, validator) and the
 * React surface (`KeybindingContext`, `useKeybinding`, the shortcut hints).
 *
 * The runtime *validation* lists (the Zod `KeybindingBlockSchema`, the
 * `KEYBINDING_CONTEXTS` / `KEYBINDING_ACTIONS` const tuples, the per-context
 * descriptions) live in `./schema.ts`. This file owns the static *types*.
 */

/**
 * A single parsed keystroke: one key plus its modifier state.
 *
 * Produced by `parseKeystroke()` (parser.ts) from a string like `"ctrl+shift+k"`
 * and by `buildKeystroke()` (resolver.ts) from Ink's `(input, Key)` pair.
 *
 * Modifier notes (see match.ts / resolver.ts):
 * - `alt` and `meta` are aliases for the same physical modifier in terminals
 *   (the vendored Ink sets `key.meta` for Alt/Option). `buildKeystroke` writes
 *   the same value to both; matching treats `alt || meta` as one logical flag.
 * - `super` (Cmd/Win) is distinct and only arrives via the kitty keyboard
 *   protocol on supporting terminals.
 * - `key` is the normalized key name (e.g. `"escape"`, `"enter"`, `"up"`, a
 *   single lowercase character, or `" "` for the space key). Empty string
 *   before a key part has been parsed.
 */
export interface ParsedKeystroke {
  /** Normalized key name, e.g. "escape", "enter", "up", "a", or " " for space. */
  key: string
  /** Control modifier. */
  ctrl: boolean
  /** Alt/Option modifier (terminal alias of `meta`). */
  alt: boolean
  /** Shift modifier. */
  shift: boolean
  /** Meta modifier (terminal alias of `alt`). */
  meta: boolean
  /** Super modifier (Cmd/Win) — only via the kitty keyboard protocol. */
  super: boolean
}

/**
 * A chord: an ordered sequence of keystrokes (e.g. `"ctrl+k ctrl+s"` → two).
 * A single-keystroke binding is a `Chord` of length 1.
 */
export type Chord = ParsedKeystroke[]

/**
 * The name of a UI context in which keybindings apply.
 *
 * The recognized/validated context names are enumerated by
 * `KEYBINDING_CONTEXTS` in schema.ts (`Global`, `Chat`, `Confirmation`, …) and
 * cross-checked by `VALID_CONTEXTS` / `isValidContext()` in validate.ts. The
 * static type is deliberately the open `string` set, not a closed literal
 * union: `DEFAULT_BINDINGS` (defaultBindings.ts) also declares non-schema
 * contexts such as `"Scroll"` and `"MessageActions"` that are gated behind
 * `feature()` flags and never written to `keybindings.json`. Keeping the type
 * open lets those flow through `KeybindingBlock` → `ParsedBinding` →
 * `Set<KeybindingContextName>` while validation enforces the closed list for
 * *user* config.
 */
export type KeybindingContextName = string

/**
 * The identifier of a built-in keybinding action.
 *
 * This is the closed union of the action ids declared by `KEYBINDING_ACTIONS`
 * in schema.ts. It is the type accepted by the configurable-shortcut surface
 * (`ConfigurableShortcutHint`'s `action` prop, `PermissionPromptOption.keybinding`).
 *
 * Note: `command:<name>` bindings and `null` (unbind) are *binding values*, not
 * actions — they are represented in `KeybindingBlock['bindings']` (see below),
 * not here.
 */
export type KeybindingAction = keyof ActionGraph

/**
 * A `command:<name>` binding value. Executes the slash command as if typed.
 * Validated against `/^command:[a-zA-Z0-9:\-_]+$/` in schema.ts / validate.ts.
 */
export type KeybindingCommand = `command:${string}`

/**
 * The value side of a binding entry: a built-in action, a `command:<name>`
 * binding, or `null` to unbind a default shortcut.
 *
 * Kept as the broad `string | null` so that:
 * - `DEFAULT_BINDINGS` can carry non-`KEYBINDING_ACTIONS` ids (e.g. the
 *   `feature()`-gated `scroll:*`, `selection:*`, `messageActions:*` entries),
 * - `template.ts`'s `Record<string, string | null>` round-trips through
 *   `KeybindingBlock` cleanly,
 * - the raw value from `Object.entries(block.bindings)` can be stored directly
 *   on `ParsedBinding.action` (parser.ts / validate.ts).
 *
 * The narrower `KeybindingAction | KeybindingCommand | null` is the *validated*
 * shape (enforced by `KeybindingBlockSchema`); the static type stays open.
 */
export type KeybindingValue = string | null

/**
 * A block of keybindings scoped to a single context, as it appears in
 * `keybindings.json` and in `DEFAULT_BINDINGS`.
 *
 * `bindings` maps a keystroke pattern string (e.g. `"ctrl+k"`, `"ctrl+x ctrl+e"`)
 * to its action/command/`null`. Parsed into `ParsedBinding[]` by
 * `parseBindings()` (parser.ts).
 */
export interface KeybindingBlock {
  /** UI context where these bindings apply (see `KeybindingContextName`). */
  context: KeybindingContextName
  /** Map of keystroke pattern → action id, `command:<name>`, or `null`. */
  bindings: Record<string, KeybindingValue>
}

/**
 * A single binding after parsing: the keystroke pattern expanded into a chord,
 * paired with its action and context.
 *
 * Produced by `parseBindings()` (parser.ts) and `getUserBindingsForValidation()`
 * (validate.ts). `action` is `null` when the entry unbinds a default shortcut
 * (the resolver returns `{ type: 'unbound' }` for it).
 */
export interface ParsedBinding {
  /** The keystroke sequence this binding fires on. */
  chord: Chord
  /** The action id / `command:<name>` to fire, or `null` to unbind. */
  action: KeybindingValue
  /** The context this binding belongs to. */
  context: KeybindingContextName
}
