import { parse as parseShellQuote } from 'shell-quote'


export function parseArguments(args: string): string[] {
  if (!args || args.trim() === '') return []
  try {
    const tokens = parseShellQuote(args, (key: string) => `$${key}`)
    return tokens.filter((token): token is string => typeof token === 'string')
  } catch {
    return args.split(/\s+/).filter(token => token.length > 0)
  }
}

export function parseArgumentNames(argumentNames: string | string[] | undefined): string[] {
  if (!argumentNames) return []
  let candidates: unknown[]
  if (typeof argumentNames === 'string') {
    candidates = argumentNames.split(/\s+/)
  } else if (Array.isArray(argumentNames)) {
    candidates = argumentNames
  } else {
    return []
  }
  return candidates.filter(
    (name): name is string =>
      typeof name === 'string' && name.trim().length > 0 && !/^\d+$/.test(name),
  )
}

export function generateProgressiveArgumentHint(
  argNames: string[],
  typedArgs: string[],
): string | undefined {
  const remaining = argNames.slice(typedArgs.length)
  if (remaining.length === 0) return undefined
  return remaining.map(name => `[${name}]`).join(' ')
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ARGUMENTS_LABEL = 'ARGUMENTS: '

export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder: boolean = true,
  argumentNames?: string[],
): string {
  if (args === undefined || args === null) return content

  const parsedArgs = parseArguments(args)
  let result = content

  if (argumentNames) {
    for (let i = 0; i < argumentNames.length; i++) {
      const name = argumentNames[i]
      if (!name) continue
      const value = parsedArgs[i] ?? ''
      const pattern = new RegExp(`\\$${escapeForRegExp(name)}(?![\\w\\[])`, 'g')
      result = result.replace(pattern, value)
    }
  }

  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => {
    return parsedArgs[Number(index)] ?? ''
  })

  result = result.replace(/\$(\d+)(?!\w)/g, (_match, index: string) => {
    return parsedArgs[Number(index)] ?? ''
  })

  result = result.replace(/\$ARGUMENTS/g, args)

  if (result === content && appendIfNoPlaceholder && args !== '') {
    return `${content}\n\n${ARGUMENTS_LABEL}${args}`
  }
  return result
}
