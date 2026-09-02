import { tryParseShellCommand } from '../../utils/permissions/decision/commandAnalysis.js'

export type SedEditInfo = {
  filePath: string
  pattern: string
  replacement: string
  flags: string
  extendedRegex: boolean
}

const ALLOWED_SED_FLAGS = /^[gpimIM1-9]*$/

export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()
  if (!/^sed\s/.test(trimmed)) return null
  const parse = tryParseShellCommand(trimmed.replace(/^sed\s+/, ''))
  if (!parse.success) return null

  const words: string[] = []
  for (const token of parse.tokens) {
    if (typeof token === 'string') {
      words.push(token)
      continue
    }
    if (isGlobToken(token)) return null
  }

  let inPlace = false
  let extendedRegex = false
  let program: string | null = null
  let filePath: string | null = null

  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    if (word === '-i' || word === '--in-place') {
      inPlace = true
      const next = words[i + 1]
      if (next !== undefined && !next.startsWith('-') && (next === '' || next.startsWith('.'))) {
        i++
      }
      continue
    }
    if (word.startsWith('-i')) {
      if (word.startsWith('--in-place=')) return null
      inPlace = true
      continue
    }
    if (word === '-E' || word === '-r' || word === '--regexp-extended') {
      extendedRegex = true
      continue
    }
    if (word === '-e' || word === '--expression') {
      const next = words[i + 1]
      if (next === undefined) return null
      if (program !== null) return null
      program = next
      i++
      continue
    }
    if (word.startsWith('--expression=')) {
      if (program !== null) return null
      program = word.slice('--expression='.length)
      continue
    }
    if (word.startsWith('-')) return null
    if (program === null) {
      program = word
    } else if (filePath === null) {
      filePath = word
    } else {
      return null
    }
  }

  if (!inPlace || !program || !filePath) return null

  const parsed = parseSubstitutionProgram(program)
  if (!parsed) return null
  return { filePath, pattern: parsed.pattern, replacement: parsed.replacement, flags: parsed.flags, extendedRegex }
}

function parseSubstitutionProgram(program: string): { pattern: string; replacement: string; flags: string } | null {
  if (!program.startsWith('s/')) return null
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern'
  let pattern = ''
  let replacement = ''
  let flags = ''
  for (let i = 2; i < program.length; i++) {
    const ch = program[i] as string
    if (ch === '\\' && i + 1 < program.length) {
      const pair = ch + (program[i + 1] as string)
      if (state === 'pattern') pattern += pair
      else if (state === 'replacement') replacement += pair
      else flags += pair
      i++
      continue
    }
    if (ch === '/') {
      if (state === 'pattern') state = 'replacement'
      else if (state === 'replacement') state = 'flags'
      else return null
      continue
    }
    if (state === 'pattern') pattern += ch
    else if (state === 'replacement') replacement += ch
    else flags += ch
  }
  if (state !== 'flags') return null
  if (!ALLOWED_SED_FLAGS.test(flags)) return null
  return { pattern, replacement, flags }
}

export function isSedInPlaceEdit(command: string): boolean {
  return parseSedEditCommand(command) !== null
}


const WHOLE_MATCH_MARKER = '\x00MERCURY_SED_WHOLE_MATCH\x00'

export function applySedSubstitution(content: string, sedInfo: SedEditInfo): string {
  const global = sedInfo.flags.includes('g')
  const caseInsensitive = sedInfo.flags.includes('i') || sedInfo.flags.includes('I')
  const multiline = sedInfo.flags.includes('m') || sedInfo.flags.includes('M')
  let regexFlags = ''
  if (global) regexFlags += 'g'
  if (caseInsensitive) regexFlags += 'i'
  if (multiline) regexFlags += 'm'

  const pattern = translatePattern(sedInfo.pattern, sedInfo.extendedRegex)
  const replacement = translateReplacement(sedInfo.replacement)

  let regex: RegExp
  try {
    regex = new RegExp(pattern, regexFlags)
  } catch {
    return content
  }
  return content.replace(regex, match =>
    replacement.split(WHOLE_MATCH_MARKER).join(match),
  )
}

function translatePattern(pattern: string, extendedRegex: boolean): string {
  let out = pattern.replace(/\\\//g, '/')
  if (extendedRegex) return out
  let result = ''
  for (let i = 0; i < out.length; i++) {
    const ch = out[i] as string
    if (ch === '\\') {
      const next = out[i + 1]
      if (next === '\\') {
        result += '\\\\'
        i++
        continue
      }
      if (next !== undefined && '+?|()'.includes(next)) {
        result += next
        i++
        continue
      }
      result += '\\' + (next ?? '')
      if (next !== undefined) i++
      continue
    }
    if ('+?|()'.includes(ch)) {
      result += '\\' + ch
      continue
    }
    result += ch
  }
  return result
}

function translateReplacement(replacement: string): string {
  let result = ''
  for (let i = 0; i < replacement.length; i++) {
    const ch = replacement[i] as string
    if (ch === '\\' && i + 1 < replacement.length) {
      const next = replacement[i + 1] as string
      if (next === '/') result += '/'
      else if (next === '&') result += '&'
      else result += '\\' + next
      i++
      continue
    }
    if (ch === '&') {
      result += WHOLE_MATCH_MARKER
      continue
    }
    result += ch
  }
  return result
}

function isGlobToken(token: unknown): boolean {
  return typeof token === 'object' && token !== null && (token as { op?: string }).op === 'glob'
}
