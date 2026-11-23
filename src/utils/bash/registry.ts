import { isRecord } from '../isRecord.js'
import { memoizeWithLRU } from '../memoize.js'
import { passedOver } from '../passedOver.js'
import localSpecs from './specs/index.js'

export type Argument = {
  name?: string
  description?: string
  isDangerous?: boolean
  isVariadic?: boolean
  isOptional?: boolean
  isCommand?: boolean
  isScript?: boolean
  isModule?: string | boolean
}

export type Option = {
  name: string | string[]
  description?: string
  args?: Argument | Argument[]
  isRequired?: boolean
}

export type CommandSpec = {
  name: string
  description?: string
  subcommands?: CommandSpec[]
  args?: Argument | Argument[]
  options?: Option[]
}

function parseStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items: readonly unknown[] = value
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function parseArgument(value: unknown): Argument | null {
  if (!isRecord(value)) return null
  return {
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.isDangerous === 'boolean' ? { isDangerous: value.isDangerous } : {}),
    ...(typeof value.isVariadic === 'boolean' ? { isVariadic: value.isVariadic } : {}),
    ...(typeof value.isOptional === 'boolean' ? { isOptional: value.isOptional } : {}),
    ...(typeof value.isCommand === 'boolean' ? { isCommand: value.isCommand } : {}),
    ...(typeof value.isScript === 'boolean' ? { isScript: value.isScript } : {}),
    ...(typeof value.isModule === 'string' || typeof value.isModule === 'boolean'
      ? { isModule: value.isModule }
      : {}),
  }
}

function parseArgs(value: unknown): Argument | Argument[] | undefined {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value
    const list: Argument[] = []
    for (const item of items) {
      const parsed = parseArgument(item)
      if (parsed !== null) list.push(parsed)
    }
    return list
  }
  return parseArgument(value) ?? undefined
}

function parseOption(value: unknown): Option | null {
  if (!isRecord(value)) return null
  const name = typeof value.name === 'string' ? value.name : parseStringList(value.name)
  if (name === null) return null
  const args = parseArgs(value.args)
  return {
    name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(typeof value.isRequired === 'boolean' ? { isRequired: value.isRequired } : {}),
  }
}

function parseCommandSpec(value: unknown): CommandSpec | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null
  let subcommands: CommandSpec[] | undefined
  if (Array.isArray(value.subcommands)) {
    const items: readonly unknown[] = value.subcommands
    subcommands = []
    for (const item of items) {
      const parsed = parseCommandSpec(item)
      if (parsed !== null) subcommands.push(parsed)
    }
  }
  const args = parseArgs(value.args)
  let options: Option[] | undefined
  if (Array.isArray(value.options)) {
    const items: readonly unknown[] = value.options
    options = []
    for (const item of items) {
      const parsed = parseOption(item)
      if (parsed !== null) options.push(parsed)
    }
  }
  return {
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(subcommands !== undefined ? { subcommands } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(options !== undefined ? { options } : {}),
  }
}

export const getCommandSpec = memoizeWithLRU(
  async (command: string): Promise<CommandSpec | null> => {
    const local = localSpecs.find(spec => spec.name === command)
    if (local !== undefined) return local

    if (
      command === '' ||
      command.includes('/') ||
      command.includes('\\') ||
      command.includes('..') ||
      (command.startsWith('-') && command !== '-')
    ) {
      return null
    }

    try {
      const imported: unknown = await import(`@withfig/autocomplete/build/${command}.js`)
      if (!isRecord(imported)) return null
      return parseCommandSpec(imported.default ?? imported)
    } catch (error) {
      passedOver(error)
      return null
    }
  },
  (command: string) => command,
)
