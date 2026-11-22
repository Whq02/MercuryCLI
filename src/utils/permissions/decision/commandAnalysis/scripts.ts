import { shellCommandText } from '../../../bash/ast.js'
import { inSameShell, layersOf, wordKnown } from './layers.js'
import type { Layer, ReadCommand, ShellDialect } from './reading.js'
import { notBuilt } from '../../../../pi/holes.js'

export const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'mksh', 'yash', 'csh', 'tcsh'])
const POWERSHELLS = new Set(['pwsh', 'powershell'])

function scriptWordAfter(argv: string[], option: RegExp, valued: ReadonlySet<string>): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '--' || !/^[-+]/.test(word)) return undefined
    if (option.test(word)) {
      const next = argv[i + 1] === '--' ? argv[i + 2] : argv[i + 1]
      return next
    }
    if (valued.has(word)) i++
  }
  return undefined
}

const SHELL_VALUED = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])

export function readsStdin(argv: string[]): boolean {
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '-' || word === '-s' || /^-[a-zA-Z]*s[a-zA-Z]*$/.test(word)) return true
    if (word === '--') return i + 1 >= argv.length
    if (!/^[-+]/.test(word)) return false
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) return false
    if (SHELL_VALUED.has(word)) i++
  }
  return true
}

export function stdinProgram(layer: Layer): boolean {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/scripts.ts:35')
}

export function scriptSentToProgram(argv: string[], text: string): string | undefined {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/scripts.ts:41')
}

export type Pending = { text: string; dialect: ShellDialect; from: number; body?: string; cmd?: boolean; same?: boolean }

export function printedBy(command: ReadCommand | undefined): string | undefined {
  const layer = command === undefined ? undefined : layersOf(command.argv).at(-1)
  if (layer === undefined) return undefined
  return layer.program === 'echo' ? echoText(layer.argv) : layer.program === 'printf' ? printfText(layer.argv) : undefined
}

export function nestedScripts(command: ReadCommand, from: number, commands: readonly ReadCommand[]): Pending[] {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/scripts.ts:58')
}

const START_VALUED = ['workingdirectory', 'verb', 'windowstyle', 'credential', 'redirectstandardinput', 'redirectstandardoutput', 'redirectstandarderror', 'environment']

function startedBy(words: readonly string[]): string | undefined {
  let file: string | undefined
  const handed: string[] = []
  let taking = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const named = /^-([A-Za-z]+)(?::(.*))?$/.exec(word)
    if (named === null) {
      if (file === undefined && !taking) file = word
      else handed.push(word.replace(/,$/, ''))
      continue
    }
    const name = named[1]!.toLowerCase()
    taking = false
    if (name === 'whatif') return undefined
    if ('filepath'.startsWith(name)) file = named[2] ?? words[++i]
    else if ('argumentlist'.startsWith(name) || name === 'args') {
      taking = true
      if (named[2] !== undefined) handed.push(named[2])
    } else if (named[2] === undefined && START_VALUED.some(full => full.startsWith(name))) i++
  }
  return file === undefined || !wordKnown(file) ? undefined : `& '${file.replaceAll("'", "''")}' ${handed.join(' ')}`.trim()
}

export function ansiC(text: string): string {
  return text.replace(/\\(?:x([0-9A-Fa-f]{1,2})|([0-7]{1,3})|([\s\S]))/g, (_all, hex: string | undefined, octal: string | undefined, ch: string | undefined) => {
    if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16))
    if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8))
    return ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch === 'e' || ch === 'E' ? '\u001b' : (ch ?? '')
  })
}

function echoText(argv: string[]): string {
  let i = 1
  let escapes = false
  while (i < argv.length && /^-[neE]+$/.test(argv[i]!)) {
    if (argv[i]!.includes('e')) escapes = true
    i++
  }
  const text = argv.slice(i).join(' ')
  return escapes ? ansiC(text) : text
}

function printfText(argv: string[]): string {
  let i = 1
  if (argv[i] === '--') i++
  const format = argv[i]
  if (format === undefined) return ''
  const values = argv.slice(i + 1)
  let out = ''
  let at = 0
  for (let pass = 0; pass < 64; pass++) {
    out += format.replace(/%(?:%|[-+ #0]*\d*(?:\.\d+)?[sbqdiouxXcfeEgG])/g, conversion => (conversion === '%%' ? '%' : (values[at++] ?? '')))
    if (at >= values.length) break
  }
  return ansiC(out)
}

export function buriedScripts(text: string, quoted: boolean): string[] {
  const out: string[] = []
  const closes = (from: number, quote: string): number => {
    let end = from
    while (end < text.length && text[end] !== quote) end += text[end] === '\\' && quote !== "'" ? 2 : 1
    return end
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') i++
    else if (quoted && ch === "'") i = closes(i + 1, "'")
    else if (ch === '`') {
      const end = closes(i + 1, '`')
      out.push(text.slice(i + 1, end))
      i = end
    } else if (ch === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      let depth = 0
      let end = i + 1
      for (; end < text.length; end++) {
        const inside = text[end]
        if (inside === '\\') end++
        else if (inside === "'" || inside === '"') end = closes(end + 1, inside)
        else if (inside === '(') depth++
        else if (inside === ')' && --depth === 0) break
      }
      out.push(text.slice(i + 2, end))
      i = end
    }
  }
  return out.filter(script => script.trim() !== '')
}
