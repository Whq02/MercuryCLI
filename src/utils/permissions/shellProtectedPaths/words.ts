import { shellTextOutsideFileHeredocs } from '../../wards/wards.js'
import { type Layer, type ReadCommand, type ShellRead, layersOf, pinnedCommandAnalysis, wordsAsWritten } from '../decision/commandAnalysis.js'
import { fileUrlPaths } from './homes.js'

const PIPED_PRINTERS = new Set(['echo', 'printf', 'write-output'])
const WRITTEN_USER_VAR = /^\$(?:USER|LOGNAME|USERNAME|UID|EUID)$/

export function expandedLayerArgvs(layer: Layer): string[][] {
  if (layer.findRoots === undefined || layer.program === 'find') return [layer.argv]
  const roots = layer.findRoots.length > 0 ? layer.findRoots : ['.']
  return roots.map(root => layer.argv.map(word => (word === '{}' ? root : word.replace(/\{\}/g, root))))
}

export function pipedPrinterOperands(feeders: readonly ReadCommand[]): string[] {
  const out: string[] = []
  for (const feeder of feeders) {
    for (const fed of layersOf(feeder.argv)) {
      if (!PIPED_PRINTERS.has(fed.program)) continue
      for (const word of fed.argv.slice(1)) {
        if (!word.startsWith('-') && !(fed.program === 'printf' && word.includes('%'))) out.push(word)
      }
    }
  }
  return out
}

function unquoteWritten(raw: string): string {
  let out = ''
  let quote = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      else out += ch
    } else if (quote === '"') {
      if (ch === '"') quote = ''
      else if (ch === '\\' && i + 1 < raw.length && (raw[i + 1] === '"' || raw[i + 1] === '\\' || raw[i + 1] === '$' || raw[i + 1] === '`')) out += raw[++i]!
      else out += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === '\\' && i + 1 < raw.length) {
      out += raw[++i]!
    } else {
      out += ch
    }
  }
  return out.replace(/\$\{([A-Za-z_][\w:]*)\}/g, '$$$1')
}

export function writtenLayerArgv(simple: ReadCommand, layer: Layer): string[] | undefined {
  const raw = wordsAsWritten(simple)
  if (raw === undefined || raw.length !== simple.argv.length) return undefined
  const offset = simple.argv.length - layer.argv.length
  if (offset < 0) return undefined
  for (let i = 0; i < layer.argv.length; i++) {
    if (simple.argv[offset + i] !== layer.argv[i]) return undefined
  }
  return raw.slice(offset).map(unquoteWritten)
}

export function spelledUserArgv(argv: string[], written: readonly string[] | undefined): string[] {
  if (written === undefined || written.length !== argv.length) return argv
  return argv.map((word, index) => (WRITTEN_USER_VAR.test(written[index]!) ? written[index]! : word))
}

export function spelledTargetWord(value: string, argv: readonly string[], written: readonly string[] | undefined, matches: (candidate: string) => boolean): string {
  if (written === undefined || written.length !== argv.length) return value
  const index = argv.indexOf(value)
  if (index < 0) return value
  const candidate = written[index]!
  return candidate !== value && matches(candidate) ? candidate : value
}

function words(text: string, powershell: boolean): Array<string | { op?: string }> {
  const prepared = powershell ? text.replace(/`\r?\n/g, '').replace(/`([^\r\n])/g, '$1').replace(/\\/g, '\\\\') : text
  const parsed = pinnedCommandAnalysis.tryParseShellCommand(prepared, name => `$${name}`)
  return parsed.success ? parsed.tokens.flatMap<string | { op?: string }>(token => {
    if (typeof token === 'string') return [token]
    if ('op' in token && token.op === 'glob' && 'pattern' in token) return [token.pattern]
    return 'op' in token ? [token] : []
  }) : []
}

export function groups(text: string, powershell: boolean, operandEnds?: Map<string[], number>): string[][] {
  const result: string[][] = []
  let group: string[] = []
  for (const word of words(text, powershell)) {
    if (operandEnds !== undefined && typeof word !== 'string' && ['>', '>>', '>|', '&>', '<', '>&', '<&'].includes(word.op ?? '') && !operandEnds.has(group)) {
      const descriptor = /^\d+$/.test(group.at(-1) ?? '') && group.slice(1, -1).some(part => !part.startsWith('-'))
      operandEnds.set(group, group.length - (descriptor ? 1 : 0))
    }
    if (typeof word === 'string') group.push(word)
    else if (word.op === '>' || word.op === '>>' || word.op === '>|' || word.op === '&>') group.push('>', '')
    else if (word.op === '<') group.push('<', '')
    else if (word.op !== undefined) {
      if (group.length) result.push(group)
      group = []
    }
  }
  if (group.length) result.push(group)
  return result
}

export function verb(word: string): string {
  return word.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '')
}

function splitFusedOptions(argv: string[]): string[] {
  return argv.flatMap(word => {
    const fused = /^(-(?:literalpath|path|destination|filepath|newname)):(.+)$/i.exec(word)
    return fused ? [fused[1]!, fused[2]!] : [word]
  })
}

export function unwrapCommand(argv: string[]): string[] {
  const bare = argv[0] === '&' ? argv.slice(1) : argv
  const layers = layersOf(bare)
  const target = layers.find(layer => ['find', 'xargs', 'do', 'then', 'else'].includes(layer.program)) ?? layers.at(-1)
  return splitFusedOptions(target !== undefined ? target.argv : bare)
}

const COPY_SWITCHES = ['force', 'recurse', 'container', 'passthru', 'verbose', 'debug', 'whatif', 'confirm']
const COPY_VALUED = ['destination', 'erroraction', 'warningaction', 'informationaction', 'progressaction', 'errorvariable', 'warningvariable', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable', 'filter', 'include', 'exclude', 'credential', 'fromsession', 'tosession']
const COPY_VALUED_ALIASES = new Set(['ea', 'wa', 'infa', 'proga', 'ev', 'wv', 'iv', 'ov', 'ob', 'pv'])

function powershellCopyTargets(args: readonly string[]): string[] {
  const loose: string[] = []
  const valued: string[] = []
  let sourced = false
  let destined = false
  let sure = true
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!
    if (!word.startsWith('-') || word === '-') {
      loose.push(word)
      continue
    }
    if (word.startsWith('--')) {
      const equals = word.indexOf('=')
      const value = equals >= 0 ? word.slice(equals + 1) : word === '--target-directory' ? args[++i] : undefined
      if (value !== undefined) valued.push(value)
      continue
    }
    const colon = word.indexOf(':')
    const name = (colon < 0 ? word.slice(1) : word.slice(1, colon)).toLowerCase()
    const fused = colon < 0 ? undefined : word.slice(colon + 1)
    const named = (full: string): boolean => name !== '' && full.startsWith(name)
    const switched = COPY_SWITCHES.some(named)
    const takesValue = COPY_VALUED_ALIASES.has(name) || COPY_VALUED.some(named)
    if (name === 'pspath' || name === 'lp' || named('literalpath') || (name.length > 1 && named('path'))) {
      sourced = true
      if (fused === undefined) i++
    } else if (takesValue && !switched) {
      const value = fused ?? args[++i]
      if (value !== undefined) valued.push(value)
      if (named('destination')) destined = true
    } else if (takesValue || !(switched || /^[adfhinprsuvx]{1,4}$/.test(name))) {
      sure = false
      if (fused !== undefined) valued.push(fused)
    }
  }
  return [...valued, ...(sourced || !sure ? loose : destined || loose.length < 2 ? [] : loose.slice(-1))]
}

export const WRITERS = new Set([
  'tee', 'chmod', 'icacls', 'cp', 'mv', 'copy', 'move', 'copy-item', 'move-item', 'ci', 'cpi', 'mi',
  'sed', 'set-content', 'add-content', 'out-file', 'tee-object', 'ac', 'sc',
  'install', 'dd', 'rsync', 'ln', 'truncate', 'rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase',
  'remove-item', 'clear-content', 'clc', 'new-item', 'ni', 'ren', 'rename', 'rename-item', 'sqlite3', 'find',
  'export-csv', 'epcsv', 'export-clixml', 'start-transcript',
])
export const OTHER_WRITERS = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'expand-archive', 'new-object'])
export const TREE_MOVERS = ['rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase', 'remove-item', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item']
export const RUNTIME_WRITERS = new Set(['tar', 'bsdtar', 'gtar', 'unzip', 'curl', 'wget', 'patch', 'git', 'npm', 'pnpm', 'yarn', 'bun', 'ditto', 'chown', 'chgrp', 'chflags', 'xattr', 'touch', 'setfacl', 'lchown', 'shred'])
export const UNREAD_ADVICE = 'Mercury could not read this command, so it was not checked: write it as separate, simpler commands'
export const WRITE_REDIRECT = /(?:^|[^-=0-9&>])[0-9]?>>?(?![&=>])/

const UNREAD_WORD = /[^\s;|&<>(){}"'`=,]+/g

export function unreadWords(read: ShellRead, command: string, powershell: boolean): string[] {
  if (read.unread === undefined) return []
  const outside = powershell ? command : shellTextOutsideFileHeredocs(command)
  const nested = read.unread.text === command ? '' : read.unread.text
  const text = `${outside} ${nested}`
  const words = new Set<string>()
  for (const found of text.matchAll(UNREAD_WORD)) {
    const word = found[0]
    const escape = !powershell && word === '\\' && text[found.index + 1] !== "'"
    if (word.length < 4096 && !escape) words.add(word)
  }
  return [...words]
}

export function pathLike(word: string): boolean {
  return /[\\/]/.test(word) || /^[~$%.]/.test(word)
}

const CURL_UPLOAD_SHORT = /^-[sSfLkivn#46gNqaBGIjlOpR0]*T([\s\S]*)$/
const CURL_OUTPUT_SHORT = /^-[sSfLkivn#46gNqaBGIjlOpR0]*o([\s\S]*)$/
const CURL_REMOTE_NAME = /^-[sSfLkivn#46gNqaBGIjlOpR0]*O/

function curlWriteTargets(args: readonly string[]): string[] {
  const named: string[] = []
  const urls: string[] = []
  let hasUpload = false
  let remoteName = false
  let literal = false
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!
    if (literal) {
      urls.push(word)
      continue
    }
    if (word === '--') {
      literal = true
      continue
    }
    if (word === '-o' || word === '--output' || word === '--output-dir') {
      if (args[i + 1] !== undefined) named.push(args[++i]!)
      continue
    }
    if (word.startsWith('--output=') || word.startsWith('--output-dir=')) {
      named.push(word.slice(word.indexOf('=') + 1))
      continue
    }
    if (word === '-T' || word === '--upload-file') {
      hasUpload = true
      if (args[i + 1] !== undefined) i++
      continue
    }
    if (word.startsWith('--upload-file=')) {
      hasUpload = true
      continue
    }
    if (word === '--url') {
      if (args[i + 1] !== undefined) urls.push(args[++i]!)
      continue
    }
    if (word.startsWith('--url=')) {
      urls.push(word.slice('--url='.length))
      continue
    }
    if (word === '--remote-name' || word === '--remote-name-all') {
      remoteName = true
      continue
    }
    if (!word.startsWith('--') && word.startsWith('-')) {
      const upload = CURL_UPLOAD_SHORT.exec(word)
      if (upload !== null) {
        hasUpload = true
        if (upload[1] === '' && args[i + 1] !== undefined) i++
        continue
      }
      const output = CURL_OUTPUT_SHORT.exec(word)
      if (output !== null) {
        if (output[1] !== '') named.push(output[1]!)
        else if (args[i + 1] !== undefined) named.push(args[++i]!)
        continue
      }
      if (CURL_REMOTE_NAME.test(word)) {
        remoteName = true
        continue
      }
    }
    if (!word.startsWith('-')) urls.push(word)
  }
  const out = [...named]
  if (named.length === 0 && remoteName) out.push('.')
  if (hasUpload) {
    for (const url of urls) out.push(...fileUrlPaths(url))
  }
  return out
}

export function writeOperands(argv: string[], powershell = false): string[] {
  const out: string[] = []
  const command: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '>' || argv[i] === '<') {
      if (argv[i] === '>' && argv[i + 2]) out.push(argv[i + 2]!)
      i += 2
    } else command.push(argv[i]!)
  }
  const unwrapped = unwrapCommand(command)
  const name = verb(unwrapped[0] ?? '')
  const args = unwrapped.slice(1)
  if (args.some(arg => /^-whatif$/i.test(arg))) return []
  const writers = WRITERS
  const valued = (full: string, least: number): string[] =>
    args.flatMap((arg, at) => {
      const named = /^-([A-Za-z]+)(?::(.*))?$/.exec(arg)
      return named !== null && named[1]!.length >= least && full.startsWith(named[1]!.toLowerCase()) ? [named[2] ?? args[at + 1] ?? ''] : []
    })
  if (powershell && ['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'].includes(name)) return [...out, ...valued('outfile', 4)]
  if (powershell && name === 'expand-archive') {
    const named = valued('destinationpath', 1)
    return [...out, ...(named.length > 0 ? named : args.filter(arg => !arg.startsWith('-')).slice(1, 2))]
  }
  if (powershell && name === 'new-object') {
    const made = args.filter(arg => !arg.startsWith('-')).map(arg => arg.replace(/,$/, ''))
    if (/^(?:System\.)?IO\.(?:StreamWriter|FileStream)$/i.test(made[0] ?? '') && made[1] !== undefined && !made.slice(2).some(word => /^read$/i.test(word))) out.push(made[1])
    return out
  }
  if (name === 'curl') return [...out, ...curlWriteTargets(args)]
  if (!writers.has(name)) return out
  const operands = args.filter(arg => !arg.startsWith('-') && !/^\/[sq]$/i.test(arg))
  if (powershell) operands.push(...args.flatMap(arg => /^-[A-Za-z]+:(.+)$/.exec(arg)?.[1] ?? []))
  if (name === 'sed') {
    if (args.some(arg => /^-(?:[a-z]*i|-[iI]n-place)/.test(arg))) out.push(...operands.slice(1))
  } else if (name === 'dd') {
    out.push(...args.filter(arg => /^of=/i.test(arg)).map(arg => arg.slice(3)))
  } else if (name === 'sqlite3') {
    if (operands[0]) out.push(operands[0])
  } else if (name === 'find') {
    if (args.includes('-delete')) out.push(...operands)
  } else if (powershell && ['cp', 'copy', 'copy-item', 'ci', 'cpi'].includes(name)) {
    out.push(...powershellCopyTargets(args))
  } else if (['cp', 'copy', 'copy-item', 'ci', 'cpi', 'rsync', 'install', 'ln'].includes(name)) {
    const target = args.findIndex(arg => arg === '-t' || arg === '--target-directory' || /^-dest(?:ination)?$/i.test(arg))
    const fused = args.find(arg => arg.startsWith('--target-directory='))?.slice('--target-directory='.length)
    const destination = fused ?? (target >= 0 ? args[target + 1] : operands.at(-1))
    if (destination) out.push(destination)
  } else if (['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item'].includes(name)) {
    const target = args.findIndex(arg => arg === '-t' || arg === '--target-directory' || /^-dest(?:ination)?$/i.test(arg))
    const fused = args.find(arg => arg.startsWith('--target-directory='))?.slice('--target-directory='.length)
    if (fused) out.push(fused)
    else if (target >= 0 && args[target + 1]) out.push(args[target + 1]!)
    out.push(...operands)
  } else out.push(...operands)
  return out
}

export function readOperands(argv: string[]): string[] {
  const out: string[] = []
  const command: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '<' || argv[i] === '>') {
      if (argv[i] === '<' && argv[i + 2]) out.push(argv[i + 2]!)
      i += 2
    } else command.push(argv[i]!)
  }
  const unwrapped = unwrapCommand(command)
  const name = verb(unwrapped[0] ?? '')
  const readers = new Set([
    'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'base64', 'xxd', 'od', 'hexdump', 'strings', 'grep', 'rg', 'cp', 'copy', 'copy-item', 'ci', 'cpi', 'mv', 'move', 'move-item', 'mi', 'rsync', 'install', 'dd', 'sqlite3',
    'xargs', 'sort', 'uniq', 'wc', 'cut', 'paste', 'column', 'nl', 'diff', 'jq', 'awk', 'sed', 'comm', 'cmp', 'tac', 'rev', 'fold', 'fmt', 'pr', 'expand', 'unexpand', 'tsort', 'info', 'man', 'pyright', 'du', 'date',
  ])
  if (readers.has(name)) {
    const args = unwrapped.slice(1)
    if (name === 'dd') {
      out.push(...args.filter(arg => /^if=/i.test(arg)).map(arg => arg.slice(3)))
    } else {
      const operands = args.filter(arg => !arg.startsWith('-'))
      out.push(...(['cp', 'copy', 'copy-item', 'ci', 'cpi', 'mv', 'move', 'move-item', 'mi', 'rsync', 'install'].includes(name) ? operands.slice(0, -1) : operands))
      out.push(...args.filter(arg => /^--[a-z-]+=./.test(arg)).map(arg => arg.slice(arg.indexOf('=') + 1)))
      out.push(...flaggedReadOperands(name, args))
    }
  }
  return out
}

const READ_FILE_LETTERS: Record<string, string> = { xargs: 'a', grep: 'f', rg: 'f', diff: 'X', du: 'X', jq: 'fL', info: 'fd', man: 'lMC', date: 'rf', pyright: 'p', awk: 'f', sed: 'f' }

export function flaggedReadOperands(program: string, args: readonly string[]): string[] {
  const letters = READ_FILE_LETTERS[program]
  if (letters === undefined) return []
  return args.filter(arg => /^-[A-Za-z]./.test(arg) && letters.includes(arg[1]!)).map(arg => arg.slice(2))
}

export function runtimeOperands(argv: string[], powershell = false): Array<{ path: string; removesTree: boolean }> {
  const unwrapped = unwrapCommand(argv)
  const name = verb(unwrapped[0] ?? '')
  const args = unwrapped.slice(1)
  if (args.some(arg => /^-whatif$/i.test(arg))) return []
  const targets = writeOperands(argv, powershell).map(path => ({ path, removesTree: false }))
  if (TREE_MOVERS.includes(name) || (name === 'find' && args.includes('-delete'))) {
    targets.push(...args.filter(arg => !arg.startsWith('-') && !/^\/[sq]$/i.test(arg)).map(path => ({ path, removesTree: true })))
  }
  return targets
}
