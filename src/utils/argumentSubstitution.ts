import { parse as parseShellQuote } from 'shell-quote'

/**
 * Parsing and substitution of the `$ARGUMENTS`-family placeholders in
 * skill/command prompts.
 */

/**
 * Parse a raw argument string into tokens. Quoted arguments parse as single
 * tokens; variable references are kept in their literal `$NAME` form rather
 * than expanded; non-string tokens (operators, globs, redirections) are
 * discarded. A parse failure falls back to whitespace splitting.
 */
export function parseArguments(args: string): string[] {
  if (!args || args.trim() === '') return []
  try {
    const tokens = parseShellQuote(args, (key: string) => `$${key}`)
    return tokens.filter((token): token is string => typeof token === 'string')
  } catch {
    return args.split(/\s+/).filter(token => token.length > 0)
  }
}

/**
 * Parse declared argument names from frontmatter: a whitespace-separated
 * string or an array. Names must be non-empty strings after trimming and
 * must not be entirely digits — numeric names would collide with the
 * positional shorthand.
 */
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

/**
 * The names not yet supplied, each wrapped in square brackets and joined by
 * single spaces; undefined when nothing remains.
 */
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

// Model-visible label for the appended-arguments block; prompt authors match
// on it.
const ARGUMENTS_LABEL = 'ARGUMENTS: '

/**
 * Substitute arguments into content. Passes run in order — named arguments,
 * `$ARGUMENTS[n]`, `$n`, bare `$ARGUMENTS` — each over the output of the
 * previous one, so text inserted by an earlier pass is rescanned by the
 * later passes, while the raw string the final pass inserts is never
 * rescanned.
 *
 * Replacement-value semantics differ by pass and are load-bearing: the
 * named-argument and bare-`$ARGUMENTS` passes insert with string-replacement
 * semantics (`$$` in a value becomes one `$`), while the two indexed passes
 * insert the value literally.
 *
 * `undefined`/`null` arguments leave the content untouched. The empty
 * string counts as arguments having been supplied: every placeholder is
 * replaced by nothing and no block is appended.
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder: boolean = true,
  argumentNames?: string[],
): string {
  if (args === undefined || args === null) return content

  const parsedArgs = parseArguments(args)
  let result = content

  // Pass 1: named arguments. Name i maps to parsed argument i; missing
  // arguments substitute empty. Anchored so `$name` matches but `$name[...]`
  // and `$nameSuffix` do not. The declared name is regex-escaped — an
  // unescaped metacharacter in a frontmatter-supplied name would build a
  // broken or injected pattern.
  if (argumentNames) {
    for (let i = 0; i < argumentNames.length; i++) {
      const name = argumentNames[i]
      if (!name) continue
      const value = parsedArgs[i] ?? ''
      const pattern = new RegExp(`\\$${escapeForRegExp(name)}(?![\\w\\[])`, 'g')
      result = result.replace(pattern, value)
    }
  }

  // Pass 2: $ARGUMENTS[n] — decimal index, literal insertion.
  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => {
    return parsedArgs[Number(index)] ?? ''
  })

  // Pass 3: $n shorthand — a run of digits not followed by a word character,
  // literal insertion.
  result = result.replace(/\$(\d+)(?!\w)/g, (_match, index: string) => {
    return parsedArgs[Number(index)] ?? ''
  })

  // Pass 4: bare $ARGUMENTS — every occurrence replaced with the RAW
  // argument string under string-replacement semantics.
  result = result.replace(/\$ARGUMENTS/g, args)

  if (result === content && appendIfNoPlaceholder && args !== '') {
    return `${content}\n\n${ARGUMENTS_LABEL}${args}`
  }
  return result
}
