import { parse as parseShellQuote } from 'shell-quote'
import { notBuilt } from '../pi/holes.js'


export function parseArguments(args: string): string[] {
  return notBuilt('src/utils/argumentSubstitution.ts:4')
}

export function parseArgumentNames(argumentNames: string | string[] | undefined): string[] {
  return notBuilt('src/utils/argumentSubstitution.ts:14')
}

export function generateProgressiveArgumentHint(
  argNames: string[],
  typedArgs: string[],
): string | undefined {
  return notBuilt('src/utils/argumentSubstitution.ts:30')
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ARGUMENTS_LABEL = 'ARGUMENTS: '

export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder?: boolean,
  argumentNames?: string[],
): string {
  return notBuilt('src/utils/argumentSubstitution.ts:45')
}
