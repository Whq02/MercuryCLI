import { preparedSecurityParse, checkSemantics } from '../../utils/permissions/decision/commandAnalysis.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type SedEditInfo = Unbuilt

export function parseSedEditCommand(command: string): SedEditInfo | null {
  return notBuilt('src/tools/BashTool/sedEditParser.ts:14')
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

function translatePattern(pattern: string, extendedRegex: boolean): string {
  return notBuilt('src/tools/BashTool/sedEditParser.ts:157')
}

function translateReplacement(replacement: string): string {
  return notBuilt('src/tools/BashTool/sedEditParser.ts:188')
}
