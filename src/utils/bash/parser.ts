import type { TsNode } from './bashParser.js'

export type Node = TsNode

interface ParsedCommandData {
  rootNode: Node
  envVars: string[]
  commandNode: Node | null
  originalCommand: string
}

const LONGEST_PARSEABLE_COMMAND = 10_000

export const PARSE_ABORTED: unique symbol = Symbol('PARSE_ABORTED')

function parseable(command: string): boolean {
  return command !== '' && command.length <= LONGEST_PARSEABLE_COMMAND
}

export async function parseCommand(command: string): Promise<ParsedCommandData | null> {
  if (!parseable(command)) return null
  return null
}

export async function parseCommandRaw(command: string): Promise<Node | null | typeof PARSE_ABORTED> {
  if (!parseable(command)) return null
  return null
}
