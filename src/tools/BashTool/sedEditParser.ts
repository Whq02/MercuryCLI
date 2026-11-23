import { preparedSecurityParse, checkSemantics } from '../../utils/permissions/decision/commandAnalysis.js'
import { passedOver } from '../../utils/passedOver.js'

export type SedEditInfo = {
  filePath: string
  pattern: string
  replacement: string
  flags: string
  extendedRegex: boolean
}

export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()
  if (!/^sed\s/.test(trimmed)) return null

  const rawParsed = preparedSecurityParse(command)
  const parsed = rawParsed.kind === 'simple' ? rawParsed : preparedSecurityParse(trimmed)
  if (parsed.kind !== 'simple' || parsed.commands.length !== 1) return null
  if (!checkSemantics(parsed.commands).ok) return null

  const simple = parsed.commands[0]
  if (!simple || simple.argv[0] !== 'sed' || simple.envVars.length > 0 || simple.redirects.length > 0) {
    return null
  }

  let inPlace = false
  let extendedRegex = false
  let program: string | null = null
  let filePath: string | null = null

  const args = simple.argv.slice(1)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-i' || arg === '--in-place') {
      inPlace = true
      const next = args[i + 1]
      if (next !== undefined && (next === '' || next.startsWith('.'))) {
        i++
      }
      continue
    }
    if (arg.startsWith('--in-place=')) return null
    if (arg.startsWith('-i') && arg.length > 2) {
      inPlace = true
      continue
    }
    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      extendedRegex = true
      continue
    }
    if (arg === '-e' || arg === '--expression') {
      if (program !== null) return null
      const next = args[i + 1]
      if (next === undefined) return null
      program = next
      i++
      continue
    }
    if (arg.startsWith('--expression=')) {
      if (program !== null) return null
      program = arg.slice('--expression='.length)
      continue
    }
    if (arg.startsWith('-')) return null
    if (program === null) {
      program = arg
    } else if (filePath === null) {
      filePath = arg
    } else {
      return null
    }
  }

  if (!inPlace || program === null || filePath === null) return null
  if (!program.startsWith('s/')) return null

  const sections: string[] = []
  let current = ''
  for (let i = 2; i < program.length; i++) {
    const ch = program[i]!
    if (ch === '\\' && i + 1 < program.length) {
      current += ch + program[i + 1]!
      i++
      continue
    }
    if (ch === '/') {
      sections.push(current)
      current = ''
      continue
    }
    current += ch
  }
  sections.push(current)

  if (sections.length !== 3) return null
  const [pattern, replacement, flags] = sections as [string, string, string]
  if (!/^[gpimIM1-9]*$/.test(flags)) return null

  return { filePath, pattern, replacement, flags, extendedRegex }
}

export function isSedInPlaceEdit(command: string): boolean {
  return parseSedEditCommand(command) !== null
}


const WHOLE_MATCH_MARKER = '\x00MERCURY_SED_WHOLE_MATCH\x00'
const REPLACEMENT_MARKER = /\x00MERCURY_SED_(?:WHOLE_MATCH|GROUP_([1-9]))\x00/g

export function applySedSubstitution(content: string, sedInfo: SedEditInfo): string | null {
  const global = sedInfo.flags.includes('g')
  const caseInsensitive = sedInfo.flags.includes('i') || sedInfo.flags.includes('I')
  const print = sedInfo.flags.includes('p')
  const occurrence = Number(sedInfo.flags.replace(/[^0-9]/g, '') || '1')

  const pattern = translatePattern(sedInfo.pattern, sedInfo.extendedRegex)
  const replacement = translateReplacement(sedInfo.replacement)

  let regex: RegExp
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
  } catch (error) {
    passedOver(error)
    return null
  }
  const lines = content.split('\n')
  const last = lines.length - 1
  return lines
    .map((line, index) => {
      if (index === last && line === '') return line
      let seen = 0
      let substituted = false
      let previousMatchEnd = -1
      const next = line.replace(regex, (match: string, ...rest: unknown[]) => {
        const offset = rest[rest.length - 2] as number
        if (match === '' && offset === previousMatchEnd) return match
        previousMatchEnd = offset + match.length
        seen++
        if (seen < occurrence || (!global && seen > occurrence)) return match
        substituted = true
        const groups = rest.slice(0, -2) as Array<string | undefined>
        return replacement.replace(REPLACEMENT_MARKER, (_marker: string, digit: string | undefined) =>
          digit === undefined ? match : (groups[Number(digit) - 1] ?? ''),
        )
      })
      return print && substituted ? `${next}\n${next}` : next
    })
    .join('\n')
}

const BRE_SPECIALS: ReadonlySet<string> = new Set(['+', '?', '|', '(', ')', '{', '}'])

function translatePattern(pattern: string, extendedRegex: boolean): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]!
      if (next === '/') {
        out += '/'
        i++
        continue
      }
      if (next === '\\') {
        out += '\\\\'
        i++
        continue
      }
      if (!extendedRegex && BRE_SPECIALS.has(next)) {
        out += next
        i++
        continue
      }
      out += '\\' + next
      i++
      continue
    }
    if (!extendedRegex && BRE_SPECIALS.has(ch)) {
      out += '\\' + ch
      continue
    }
    out += ch
  }
  return out
}

function translateReplacement(replacement: string): string {
  let out = ''
  for (let i = 0; i < replacement.length; i++) {
    const ch = replacement[i]!
    if (ch === '\\' && i + 1 < replacement.length) {
      const next = replacement[i + 1]!
      if (next === '/') {
        out += '/'
      } else if (next === '&') {
        out += '&'
      } else if (next === '\\') {
        out += '\\'
      } else if (next >= '1' && next <= '9') {
        out += `\x00MERCURY_SED_GROUP_${next}\x00`
      } else {
        out += '\\' + next
      }
      i++
      continue
    }
    if (ch === '&') {
      out += WHOLE_MATCH_MARKER
      continue
    }
    out += ch
  }
  return out
}
