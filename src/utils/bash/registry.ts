/**
 * Command-spec lookup: the built-in specs first, then an optional
 * third-party autocomplete-spec package, memoised by command name.
 */
import { memoizeWithLRU } from '../memoize.js'
import localSpecs from './specs/index.js'

/** One command's static description (subcommands, arguments, options). */
export type CommandSpec = {
  name: string
  description?: string
  subcommands?: CommandSpec[]
  args?: Argument | Argument[]
  options?: Option[]
}

/** One argument of a command or subcommand; every field is optional. */
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

/** One option of a command; its name may be a single string or a list. */
export type Option = {
  name: string | string[]
  description?: string
  args?: Argument | Argument[]
  isRequired?: boolean
}

/**
 * Load a third-party command spec from the autocomplete package, by command
 * name. Contract data: the package layout is
 * `@withfig/autocomplete/build/<command>.js`, taking the module's default
 * export when present and otherwise the module namespace. A name that is
 * empty, contains `/` or `\` or `..`, or starts with `-` (unless it is
 * exactly `-`) is rejected before any import attempt; a failed import yields
 * null rather than throwing.
 */
export async function loadFigSpec(command: string): Promise<CommandSpec | null> {
  if (command === '') return null
  if (command.includes('/') || command.includes('\\') || command.includes('..')) return null
  if (command.startsWith('-') && command !== '-') return null
  try {
    const imported = (await import(
      /* @vite-ignore */ `@withfig/autocomplete/build/${command}.js`
    )) as { default?: CommandSpec } & CommandSpec
    return (imported.default ?? imported) as CommandSpec
  } catch {
    return null
  }
}

/**
 * Resolve a command's spec: the first built-in spec whose name matches, then
 * the third-party package, then null. Memoised by command name.
 */
export const getCommandSpec = memoizeWithLRU(
  async (command: string): Promise<CommandSpec | null> => {
    const builtIn = (localSpecs as CommandSpec[]).find(spec => spec.name === command)
    if (builtIn) return builtIn
    return loadFigSpec(command)
  },
  (command: string) => command,
)
