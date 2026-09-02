import type { ActionGraph } from './actionGraph.js'

export interface ParsedKeystroke {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type Chord = ParsedKeystroke[]

export type KeybindingContextName = string

export type KeybindingAction = keyof ActionGraph

export type KeybindingCommand = `command:${string}`

export type KeybindingValue = string | null

export interface KeybindingBlock {
  context: KeybindingContextName
  bindings: Record<string, KeybindingValue>
}

export interface ParsedBinding {
  chord: Chord
  action: KeybindingValue
  context: KeybindingContextName
}
