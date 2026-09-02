import { memoizeWithLRU } from '../memoize.js'
import localSpecs from './specs/index.js'

export type CommandSpec = {
  name: string
  description?: string
  subcommands?: CommandSpec[]
  args?: Argument | Argument[]
  options?: Option[]
}

export type Argument = {
  name?: string
  description?: string
  isDangerous?: boolean
  isVariadic?: boolean
  isOptional?: boolean
  isCommand?: boolean
  isModule?: string | boolean
  isScript?: boolean
}

export type Option = {
  name: string | string[]
  description?: string
  args?: Argument | Argument[]
  isRequired?: boolean
}

export async function loadFigSpec(command: string): Promise<CommandSpec | null> {
  if (command === '') return null
  if (command.includes('/') || command.includes('\\') || command.includes('..')) return null
  if (command.startsWith('-') && command !== '-') return null
  try {
    const imported = (await import(
       `@withfig/autocomplete/build/${command}.js`
    )) as { default?: CommandSpec } & CommandSpec
    return (imported.default ?? imported) as CommandSpec
  } catch {
    return null
  }
}

export const getCommandSpec = memoizeWithLRU(
  async (command: string): Promise<CommandSpec | null> => {
    const builtIn = (localSpecs as CommandSpec[]).find(spec => spec.name === command)
    if (builtIn) return builtIn
    return loadFigSpec(command)
  },
  (command: string) => command,
)
