import type { TsNode } from './bashParser.js'

export type Node = TsNode

export interface ParsedCommandData {
  rootNode: Node
  envVars: string[]
  commandNode: Node | null
  originalCommand: string
}

const MAX_PARSEABLE_COMMAND_LENGTH = 10_000

export const PARSE_ABORTED: unique symbol = Symbol('PARSE_ABORTED')

export async function parseCommand(command: string): Promise<ParsedCommandData | null> {
  if (!command || command.length > MAX_PARSEABLE_COMMAND_LENGTH) {
    return null
  }
  return null
}

export async function parseCommandRaw(
  command: string,
): Promise<Node | null | typeof PARSE_ABORTED> {
  if (!command || command.length > MAX_PARSEABLE_COMMAND_LENGTH) {
    return null
  }
  return null
}
