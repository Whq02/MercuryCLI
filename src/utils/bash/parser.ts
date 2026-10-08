import { AsyncLocalStorage } from 'node:async_hooks'
import type { TSNode } from '../../services/structure/grammarFacility.js'
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
type RawParse = Node | null | typeof PARSE_ABORTED
const parseScope = new AsyncLocalStorage<Map<string, Promise<RawParse>>>()
let lastCommand: string | undefined
let lastParse: Promise<RawParse> | undefined

export function withBashParseScope<T>(run: () => T): T {
  return parseScope.getStore() ? run() : parseScope.run(new Map(), run)
}

function snapshot(root: TSNode): Node {
  const copy = (node: TSNode): Node => ({
    type: node.isMissing ? 'ERROR' : node.type,
    text: node.text,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    children: node.children.filter((child): child is TSNode => child !== null).map(copy),
  })
  const result = copy(root)
  if (root.hasError) result.type = 'ERROR'
  return result
}

async function parseRaw(command: string): Promise<RawParse> {
  if (command === '' || command.length > LONGEST_PARSEABLE_COMMAND) return null
  try {
    const { languageByName, loadGrammarEngine, parsePolyglot } = await import('../../services/structure/grammarFacility.js')
    const engine = await loadGrammarEngine()
    const language = languageByName('bash')
    if (engine.state !== 'ok' || !language) return null
    const parsed = await parsePolyglot(engine, language, command)
    if ('state' in parsed) return null
    try {
      return snapshot(parsed.tree.rootNode)
    } finally {
      parsed.tree.delete()
    }
  } catch {
    return null
  }
}

export function parseCommandRaw(command: string): Promise<RawParse> {
  const scoped = parseScope.getStore()
  if (scoped) {
    const existing = scoped.get(command)
    if (existing) return existing
    const pending = parseRaw(command)
    scoped.set(command, pending)
    return pending
  }
  if (lastCommand === command && lastParse) return lastParse
  lastCommand = command
  lastParse = parseRaw(command)
  return lastParse
}

export async function parseCommand(command: string): Promise<ParsedCommandData | null> {
  const rootNode = await parseCommandRaw(command)
  if (!rootNode || rootNode === PARSE_ABORTED || rootNode.type === 'ERROR') return null
  const commands: Node[] = []
  const visit = (node: Node): void => {
    if (node.type === 'command') commands.push(node)
    else for (const child of node.children) visit(child)
  }
  visit(rootNode)
  const commandNode = commands.length === 1 ? commands[0]! : null
  const envVars = commandNode?.children.filter(child => child.type === 'variable_assignment').map(child => child.text) ?? []
  return { rootNode, envVars, commandNode, originalCommand: command }
}
