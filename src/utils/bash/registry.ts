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
      const imported = (await import(`@withfig/autocomplete/build/${command}.js`)) as {
        default?: CommandSpec
      } & CommandSpec
      return imported.default ?? imported
    } catch (error) {
      passedOver(error)
      return null
    }
  },
  (command: string) => command,
)
