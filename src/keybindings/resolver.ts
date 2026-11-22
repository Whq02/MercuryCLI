import type { Key } from '../ink/events/input-event.js'
import type { DisplayPlatform } from './parser.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type ResolveResult =
  Unbuilt

export type ChordResolveResult =
  Unbuilt

export function resolveKey(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
): ResolveResult {
  return notBuilt('src/keybindings/resolver.ts:17')
}

export function resolveKeyWithChordState(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null,
): ChordResolveResult {
  return notBuilt('src/keybindings/resolver.ts:74')
}

export function unboundConsumes(input: string, key: Key): boolean {
  return notBuilt('src/keybindings/resolver.ts:121')
}

export function getBindingDisplayText(
  action: string,
  context: KeybindingContextName,
  bindings: ParsedBinding[],
  platform?: DisplayPlatform,
): string | undefined {
  return notBuilt('src/keybindings/resolver.ts:131')
}

export function matchingBindings(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending?: ParsedKeystroke[] | null,
): ParsedBinding[] {
  return notBuilt('src/keybindings/resolver.ts:146')
}
