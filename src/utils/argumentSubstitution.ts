import { parse as parseShellQuote } from 'shell-quote'

export function parseArguments(args: string): string[] {
  if (!args.trim()) return []
  try {
    return parseShellQuote(args, name => `$${name}`).filter(word => typeof word === 'string')
  } catch {
    return args.split(/\s+/).filter(Boolean)
  }
}

export function parseArgumentNames(argumentNames: string | string[] | undefined): string[] {
  const entries = typeof argumentNames === 'string' ? argumentNames.split(/\s+/) : argumentNames
  if (!Array.isArray(entries)) return []
  return entries.filter(name => typeof name === 'string' && name.trim() !== '' && !/^\d+$/.test(name))
}

export function generateProgressiveArgumentHint(
  argNames: string[],
  typedArgs: string[],
): string | undefined {
  return argNames.slice(typedArgs.length).map(name => `[${name}]`).join(' ') || undefined
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ARGUMENTS_LABEL = 'ARGUMENTS: '

export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
  argumentNames?: string[],
): string {
  if (args == null) return content
  const words = parseArguments(args)
  let result = content
  argumentNames?.forEach((name, index) => {
    if (!name) return
    const marker = new RegExp(`\\$${escapeForRegExp(name)}(?![\\w\\[])`, 'g')
    result = result.replace(marker, () => words[index] ?? '')
  })
  const wordAt = (_: string, digits: string): string => words[Number(digits)] ?? ''
  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, wordAt).replace(/\$(\d+)(?!\w)/g, wordAt).replaceAll('$ARGUMENTS', () => args)
  return appendIfNoPlaceholder && result === content && args ? `${content}\n\n${ARGUMENTS_LABEL}${args}` : result
}
