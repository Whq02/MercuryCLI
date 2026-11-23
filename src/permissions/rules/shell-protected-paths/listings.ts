import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { defaultMercuryHome } from '../../../platform/environment/envUtils.js'
import { CREDENTIALS_SERVICE_SUFFIX, getMacOsKeychainStorageServiceName, getRawSpellingKeychainStorageServiceName } from '../../../platform/secure-storage/macOsKeychainHelpers.js'
import { type Layer, type ReadCommand, type ShellRead, UNREAD_PART, layersOf, wordKnown } from '../../wards/wardsShellRead.js'
import { expandPath } from '../../../platform/files/path.js'
import { protectedPathForms, spelling } from './paths.js'
import { GLOB_PART, HOLDS_CONVENTIONAL_HOME, SECRET_NAME_SAMPLES, secretsHeld, wildcardSource } from './homes.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

function gitUnindexedGrep(layer: Layer): { folder: string | undefined; rest: string[] } | undefined {
  if (layer.program !== 'git') return undefined
  const words = layer.argv
  let folder: string | undefined
  let at = 1
  for (; at < words.length && words[at]!.startsWith('-'); at += GIT_OPTION_VALUED.has(words[at]!) ? 2 : 1) {
    const named = words[at] === '-C' ? words[at + 1] : undefined
    if (named !== undefined) folder = folder === undefined || /^(?:[/~]|[A-Za-z]:)/.test(named) ? named : `${folder}/${named}`
  }
  const rest = words.slice(at + 1)
  return words[at] === 'grep' && rest.some(word => /^--no-ind(?:e(?:x)?)?$/.test(word)) ? { folder, rest } : undefined
}

const GIT_GREP_VALUED = /^(?:-[A-Za-z]*[efABCm]|--(?:max-depth|max-count|threads|context|after-context|before-context|parent-basename))$/

export function gitGrepRoots(layer: Layer, cwd: string): string[] | undefined {
  const grep = gitUnindexedGrep(layer)
  if (grep === undefined) return undefined
  const { folder, rest } = grep
  const under = (root: string): string => (folder === undefined || /^(?:[/~]|[A-Za-z]:)/.test(root) ? root : root === '.' ? folder : `${folder}/${root}`)
  const split = rest.indexOf('--')
  const before = split < 0 ? rest : rest.slice(0, split)
  const loose: string[] = []
  let patterned = false
  for (let i = 0; i < before.length; i++) {
    const word = before[i]!
    if (/^-[A-Za-z]*[ef]$/.test(word)) patterned = true
    if (GIT_GREP_VALUED.test(word)) i++
    else if (word !== '' && !word.startsWith('-')) loose.push(word)
  }
  const paths = [...(patterned ? loose : loose.slice(1)), ...(split < 0 ? [] : rest.slice(split + 1).filter(word => word !== ''))]
  const specs = paths.map(spec => under(GLOB_PART.test(spec) || spec.startsWith(':') ? '.' : spec))
  const named = split >= 0 ? specs.length > 0 : specs.some(spec => !wordKnown(spec) || existsSync(expandPath(spelling(spec), cwd)))
  return named ? specs : [...specs, under('.')]
}

export function readsWholeTree(layer: Layer): boolean {
  const { program, argv } = layer
  const flagged = (letters: RegExp, ...long: string[]): boolean => argv.slice(1).some(word => (word.startsWith('--') ? long.includes(word.split('=')[0]!) : /^-[A-Za-z]+$/.test(word) && letters.test(word)))
  switch (program) {
    case 'rg':
    case 'ag':
    case 'ack':
    case 'ditto':
    case 'rclone':
      return true
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'zgrep':
      return flagged(/[rR]/, '--recursive', '--dereference-recursive')
    case 'cp':
    case 'scp':
    case 'copy-item':
    case 'cpi':
      return flagged(/[rRa]/, '--recursive', '--archive') || argv.slice(1).some(word => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(word))
    case 'rsync':
      return flagged(/[ra]/, '--recursive', '--archive')
    case 'tar':
    case 'bsdtar':
    case 'gtar':
      return /^-?[A-Za-z]*[cru]/.test(argv[1] ?? '') || flagged(/[cru]/, '--create', '--append', '--update')
    case 'zip':
      return flagged(/r/, '--recurse-paths')
    case '7z':
    case '7za':
      return argv[1] === 'a'
    case 'find':
      return argv.some(word => /^-(?:exec|execdir|ok|okdir|print0|fprint|fls)$/.test(word))
    case 'findstr':
      return argv.slice(1).some(word => FINDSTR_FLAG.test(word) && /s/i.test(word.split(':')[0]!))
    case 'git':
      return gitUnindexedGrep(layer) !== undefined
    default:
      return false
  }
}

const TREE_COPIERS = new Set(['cp', 'scp', 'copy-item', 'cpi', 'rsync', 'ditto', 'rclone'])
export const FILE_READERS = new Set([
  ...TREE_COPIERS, 'mv', 'move-item', 'mi', 'install', 'ln', 'dd', 'tar', 'bsdtar', 'gtar', 'zip', '7z', '7za', 'gzip', 'gunzip', 'zcat', 'bzip2', 'bzcat', 'xz', 'xzcat', 'zstd', 'zstdcat',
  'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'most', 'bat', 'view', 'strings', 'xxd', 'od', 'hexdump', 'base64', 'base32', 'openssl', 'jq', 'yq', 'awk', 'gawk', 'sed', 'cut', 'sort', 'uniq', 'paste', 'column', 'fold', 'rev', 'diff', 'cmp', 'comm',
  'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'source', '.', 'get-content', 'gc', 'type', 'select-string', 'sls', 'findstr',
])
const TREE_SEARCHERS = new Set(['rg', 'ag', 'ack', 'grep', 'egrep', 'fgrep', 'zgrep', 'findstr'])
const FINDSTR_FLAG = /^(?:\/\/?|-)[A-Za-z]+(?::.*)?$/
export const POWERSHELL_LISTERS = new Set(['get-childitem', 'gci', 'dir', 'ls'])
const PIPED_FILE_READERS = new Set(['get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'copy-item', 'cpi', 'cp', 'copy', 'move-item', 'mi', 'mv', 'move', 'format-hex', 'fhx', 'compress-archive', 'import-csv', 'ipcsv', 'import-clixml'])
const LISTER_VALUED = ['path', 'literalpath', 'filter', 'include', 'exclude', 'depth', 'attributes', 'erroraction', 'errorvariable', 'warningaction', 'warningvariable', 'informationaction', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable']
const LISTER_VALUED_ALIASES = new Set(['pspath', 'lp', 'ea', 'ev', 'wa', 'wv', 'infa', 'iv', 'ov', 'ob', 'pv'])
const LISTER_SWITCHES = ['recurse', 'force', 'name', 'directory', 'file', 'hidden', 'readonly', 'system', 'followsymlink', 'verbose', 'debug']
const LISTER_SWITCH_ALIASES = new Set(['s', 'ad', 'af', 'ah', 'h', 'ar', 'as', 'vb', 'db'])

export function findstrFolderFiles(words: readonly string[]): string[] {
  const flagOf = (word: string): string => (FINDSTR_FLAG.test(word) ? word.replace(/^[-/]+/, '').split(':')[0]!.toLowerCase() : '')
  const folders = words.flatMap(word => (flagOf(word) === 'd' ? word.slice(word.indexOf(':') + 1).split(';').filter(part => part !== '') : []))
  if (folders.length === 0) return []
  const loose = words.filter(word => word !== '' && !FINDSTR_FLAG.test(word))
  const files = words.some(word => flagOf(word) === 'c' || flagOf(word) === 'g') ? loose : loose.slice(1)
  return folders.flatMap(folder => (files.length === 0 ? [folder] : files.map(file => `${folder}/${file}`)))
}

const OPERAND_SEARCHERS = new Set(['findstr', 'grep', 'egrep', 'fgrep', 'rg'])
const RUNTIME_FILE_READ = /ReadAllText|ReadAllBytes|ReadAllLines|ReadLines|OpenText|OpenRead|ReadToEnd|StreamReader/i

export function readsHandedFiles(found: Layer): boolean {
  if (found.argv.some(word => RUNTIME_FILE_READ.test(word))) return true
  if (OPERAND_SEARCHERS.has(found.program)) return found.argv.slice(1).some(word => word.includes('$'))
  return PIPED_FILE_READERS.has(found.program)
}

export function callsUnreadName(later: ReadCommand): boolean {
  return later.dialect === 'powershell' && later.called !== undefined && !wordKnown(later.argv[0] ?? '') && (((later.stages.at(-1)?.stage ?? 0) > 0 && later.called === 'name') || later.argv.slice(1).some(word => !wordKnown(word) || /^@[\w:?]+$/.test(word)))
}

export function receivesListing(at: number, lister: ReadCommand, later: ReadCommand, index: number, read: ShellRead): boolean {
  if (later.inner.flat().includes(at)) return true
  const last = lister.stages.at(-1)
  const next = later.stages[lister.stages.length - 1]
  const beside = lister.stages.slice(0, -1).every((stage, depth) => later.stages[depth]?.pipeline === stage.pipeline && later.stages[depth]?.stage === stage.stage)
  if (last !== undefined && next !== undefined && beside && next.pipeline === last.pipeline && next.stage === last.stage + 1) return true
  return read.commands.some(loop => loop.dialect === 'powershell' && /^foreach$/i.test(loop.argv[0] ?? '') && (loop.inner[1] ?? []).includes(at) && (loop.inner[2] ?? []).includes(index))
}

const FIND_VALUED = new Set(['-maxdepth', '-mindepth', '-type', '-name', '-iname', '-newer', '-mtime', '-mmin', '-size'])
const FIND_PLAIN = new Set(['-a', '-and', '-empty', '-print', '-print0', '(', ')'])

export function findMaxDepth(argv: readonly string[]): number | undefined {
  const depths: string[] = []
  const kinds: string[] = []
  let acted = false
  let files = false
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '-exec' || word === '-execdir') {
      acted = true
      do i++
      while (i < argv.length && argv[i] !== ';' && !(argv[i] === '+' && argv[i - 1] === '{}'))
    } else if (FIND_VALUED.has(word)) {
      const value = argv[++i] ?? ''
      if (word === '-maxdepth') depths.push(value)
      if (word === '-type') kinds.push(value)
      if (word === '-type' && value === 'f' && !acted) files = true
    } else if (FIND_PLAIN.has(word)) acted ||= word === '-print' || word === '-print0'
    else if (word.startsWith('-') || word === '!' || word === ',') return undefined
  }
  return depths.length === 1 && /^\d+$/.test(depths[0]!) && kinds.length === 1 && files ? Number(depths[0]) : undefined
}

export function storeBelowDepth(word: string, cwd: string, homes: readonly string[], depth: number): boolean {
  return protectedPathForms(word, cwd).every(form => (!HOLDS_CONVENTIONAL_HOME.test(form) || depth <= 1) && homes.every(home => !home.startsWith(`${form}/`) || home.slice(form.length + 1).split(/[\\/]/).length >= depth))
}

function searchesText(found: Layer): boolean {
  if (found.program !== 'select-string' && found.program !== 'sls') return false
  return !found.argv.slice(1).some(word => word.includes('$') || word.includes(UNREAD_PART) || /^-(?:path|pspath|lp|lit[a-z]*)(?::|$)/i.test(word))
}

export function stagesApart(lister: ReadCommand, later: ReadCommand): number | undefined {
  const from = lister.stages
  const next = later.stages
  const last = from[from.length - 1]
  const reader = next[next.length - 1]
  if (last === undefined || reader === undefined || from.length !== next.length || last.pipeline !== reader.pipeline) return undefined
  return next.slice(0, -1).every((stage, index) => stage.pipeline === from[index]!.pipeline && stage.stage === from[index]!.stage) ? reader.stage - last.stage : undefined
}

function makesText(layer: Layer): boolean {
  if (layer.program === 'out-string') return true
  return (layer.program === '%' || layer.program === 'foreach-object' || layer.program === 'foreach') && layer.argv.length === 2 && /^(?:fullname|name|basename|directoryname|extension)$/i.test(layer.argv[1]!)
}

export function searchesTextOfListing(lister: ReadCommand, later: ReadCommand, found: Layer, commands: readonly ReadCommand[]): boolean {
  if (!searchesText(found) || stagesApart(lister, later) !== 2) return false
  const between = commands.filter(command => stagesApart(lister, command) === 1)
  return between.length === 1 && layersOf(between[0]!.argv).every(makesText)
}

export function searchesNamesAsText(lister: ReadCommand, later: ReadCommand, found: Layer, read: ShellRead): boolean {
  if (!searchesText(found)) return false
  if (stagesApart(lister, later) === 1) return true
  const from = lister.stages
  const next = later.stages
  const last = from[from.length - 1]
  const block = from[from.length - 2]
  const reader = next[next.length - 1]
  if (last === undefined || block === undefined || reader === undefined || from.length !== next.length + 1 || read.pipelineSizes[last.pipeline] !== 1) return false
  const within = (other: ReadCommand): boolean => other.stages.length >= from.length && from.slice(0, -1).every((stage, index) => other.stages[index]!.pipeline === stage.pipeline && other.stages[index]!.stage === stage.stage)
  if (read.commands.some(other => other !== lister && within(other))) return false
  return next.slice(0, -1).every((stage, index) => stage.pipeline === from[index]!.pipeline && stage.stage === from[index]!.stage) && block.pipeline === reader.pipeline && block.stage + 1 === reader.stage
}

export function standingSpelled(root: string): string {
  return root.replace(/^\$\{?pwd\}?(?=[\\/]|$)/i, '.')
}

export function joinedUnderStanding(word: string, inner: readonly number[] | undefined, read: ShellRead): string {
  const joiner = word === UNREAD_PART && inner?.length === 1 ? read.commands[inner[0]!] : undefined
  const layer = joiner === undefined ? undefined : layersOf(joiner.argv)[0]
  if (layer === undefined || layer.program !== 'join-path') return word
  const parts = layer.argv.slice(1).filter(part => !/^-(?:path|childpath)$/i.test(part))
  return parts.length === 2 && /^(?:\.|\$\{?pwd\}?)$/i.test(parts[0]!) && wordKnown(parts[1]!) && !GLOB_PART.test(parts[1]!) ? `./${parts[1]}` : word
}

export function powershellListing(argv: readonly string[]): { roots: string[]; deep: boolean; names: boolean; patterned: string[]; sifts: string[][] } {
  const named: string[] = []
  const loose: string[] = []
  const sifts: string[][] = []
  let deep = false
  let unsure = false
  let names = false
  const listOf = (value: string): string[] => value.split(',').map(part => part.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(part => part !== '')
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if (!word.startsWith('-') || word === '-') {
      loose.push(...listOf(word))
      continue
    }
    const colon = word.indexOf(':')
    const name = (colon < 0 ? word.slice(1) : word.slice(1, colon)).toLowerCase()
    const valued = LISTER_VALUED_ALIASES.has(name) ? name : name === '' ? undefined : LISTER_VALUED.find(full => full.startsWith(name))
    const plain = LISTER_SWITCH_ALIASES.has(name) || (name !== '' && LISTER_SWITCHES.some(full => full.startsWith(name)))
    if (name === 's' || (name !== '' && 'recurse'.startsWith(name)) || valued === 'depth') deep = true
    if (colon < 0 && name !== '' && 'name'.startsWith(name)) names = true
    if (valued === undefined || plain) {
      if (valued !== undefined || !plain) unsure = true
      continue
    }
    const value = colon < 0 ? argv[++i] : word.slice(colon + 1)
    if (value !== undefined && (valued === 'path' || valued === 'literalpath' || valued === 'pspath' || valued === 'lp')) named.push(...listOf(value))
    if (value !== undefined && (valued === 'filter' || valued === 'include')) {
      const patterns = listOf(value)
      for (let next = i + 1; next < argv.length && !argv[next]!.startsWith('-'); next++) patterns.push(...listOf(argv[next]!))
      sifts.push(valued === 'filter' ? patterns.map(pattern => `*${/\.[^.*?[\]]+$/.exec(pattern)?.[0] ?? ''}*`) : patterns)
    }
  }
  const patterned: string[] = []
  const roots = [...named, ...loose].map(root => {
    const segments = standingSpelled(root).split(/[\\/]/)
    const at = segments.findIndex(segment => GLOB_PART.test(segment))
    if (at < 0) return root
    const fixed = segments.slice(0, at).join('/')
    patterned.push(segments.join('/'))
    if (/[$(@]/.test(fixed) || fixed.includes(UNREAD_PART)) patterned.push(segments.slice(at).join('/'))
    return fixed || (/^[\\/]/.test(root) ? '/' : '.')
  })
  if (roots.length === 0 || unsure || roots.some(root => /[$(@]/.test(standingSpelled(root)) || root.includes(UNREAD_PART))) roots.push('.')
  return { roots, deep, names, patterned, sifts }
}

export const FIND_NON_READERS = new Set(['ls', 'stat', 'echo', 'printf', 'file', 'du', 'wc', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'touch', 'chmod', 'chown', 'rm', 'rmdir', 'unlink', 'mv'])

export function ripgrepReachesHidden(layer: Layer, simple: ReadCommand, read: ShellRead): boolean {
  const words = layer.argv.slice(1)
  if (words.some(word => word === '--hidden' || /^-[A-Za-z]*\.[A-Za-z.]*$/.test(word))) return true
  const unrestricted = words.reduce((count, word) => count + (word === '--unrestricted' ? 1 : /^-[A-Za-z.]+$/.test(word) ? (word.match(/u/g) ?? []).length : 0), 0)
  if (unrestricted >= 2) return true
  if (words.includes('--no-config')) return false
  const named = (entries: ReadonlyArray<{ name: string; value: string }>): boolean => entries.some(entry => entry.name === 'RIPGREP_CONFIG_PATH' && entry.value !== '')
  return named(simple.env) || named(layer.env) || (read.exported.get('RIPGREP_CONFIG_PATH') ?? []).some(value => value !== '') || !!hostEnv().RIPGREP_CONFIG_PATH
}

export function treeReadRoots(layer: Layer, fed: boolean, cwd: string, cwdHolds: boolean): string[] {
  const searched = gitGrepRoots(layer, cwd)
  if (searched !== undefined) return searched
  const words = layer.argv.slice(1)
  const plain = words.filter(word => word !== '' && !word.startsWith('-'))
  const { program } = layer
  if (TREE_COPIERS.has(program)) {
    const flag = words.findIndex(word => /^(?:-t|--target-directory|-destination)$/i.test(word))
    if (flag >= 0) return plain.filter(word => word !== words[flag + 1])
    return words.some(word => word.startsWith('--target-directory=')) ? plain : plain.slice(0, -1)
  }
  if (program === 'tar' || program === 'bsdtar' || program === 'gtar') {
    const roots: string[] = []
    let base: string | undefined
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!
      if (i === 0 && !word.startsWith('-')) {
        if (word.includes('f')) i++
      } else if (word === '-C' || word === '--directory') base = words[++i]
      else if (word.startsWith('--directory=')) base = word.slice('--directory='.length)
      else if (word === '--file' || /^-[A-Za-z]*f$/.test(word)) i++
      else if (!word.startsWith('-')) roots.push(base === undefined || /^[/~]/.test(word) ? word : `${base}/${word}`)
    }
    return roots
  }
  if (program === 'zip') return plain.slice(1)
  if (program === '7z' || program === '7za') return plain.slice(2)
  if (program === 'findstr') {
    const loose = words.filter(word => word !== '' && !FINDSTR_FLAG.test(word))
    const files = words.some(word => FINDSTR_FLAG.test(word) && /^[cg]$/i.test(word.replace(/^[-/]+/, '').split(':')[0]!)) ? loose : loose.slice(1)
    const named = words.flatMap(word => (FINDSTR_FLAG.test(word) && /^d$/i.test(word.replace(/^[-/]+/, '').split(':')[0]!) ? word.slice(word.indexOf(':') + 1).split(';').filter(part => part !== '') : []))
    return [...named, ...files.map(file => file.replace(/[\\/]?[^\\/]*$/, '') || (/^[\\/]/.test(file) ? '/' : '.'))]
  }
  if (TREE_SEARCHERS.has(program)) {
    const patterned = words.some(word => /^(?:-[A-Za-z]*[ef]|--regexp|--file)$/.test(word) || /^--(?:regexp|file)=/.test(word))
    const rest = patterned ? plain : plain.slice(1)
    return fed || !cwdHolds || rest.some(word => !wordKnown(word) || existsSync(expandPath(spelling(word), cwd))) ? rest : [...rest, '.']
  }
  return plain
}

export function namesNoSecret(patterns: readonly string[], homes: readonly string[]): boolean {
  const secrets = [...SECRET_NAME_SAMPLES, ...homes.flatMap(secretsHeld), ...homes.flatMap(home => home.split(/[\\/]/)), posix.basename(defaultMercuryHome().replace(/\\/g, '/'))].filter(name => name !== '').map(name => name.toLowerCase())
  return patterns.length > 0 && patterns.every(pattern => {
    if (!wordKnown(pattern)) return false
    try {
      const test = new RegExp(`^${wildcardSource(pattern.toLowerCase())}$`)
      return !secrets.some(secret => test.test(secret))
    } catch (error) {
      passedOver(error)
      return false
    }
  })
}

export function findNamesASecret(argv: readonly string[], homes: readonly string[]): boolean {
  if (argv.some(word => /^(?:-o|-or|-not|!|,)$/.test(word))) return true
  const names = argv.flatMap((word, index) => (/^-i?name$/.test(word) ? [argv[index + 1] ?? ''] : []))
  if (names.length === 0) return true
  const secrets = [...SECRET_NAME_SAMPLES, ...homes.flatMap(secretsHeld)].map(name => name.toLowerCase())
  return names.every(name => {
    try {
      const pattern = new RegExp(`^${wildcardSource(name.toLowerCase())}$`)
      return secrets.some(secret => pattern.test(secret))
    } catch (error) {
      passedOver(error)
      return true
    }
  })
}

export function filesSentOrPrinted(layer: Layer): Set<string> {
  const { program, argv } = layer
  const out = new Set<string>()
  if (program === 'curl') {
    argv.forEach((word, at) => {
      const before = at > 0 ? argv[at - 1]! : ''
      if (before === '-T' || before === '--upload-file' || word.startsWith('--upload-file=')) out.add(word)
      if ((/^(?:-F|--form|-d|--data|--data-binary)$/.test(before) || /^--(?:form|data|data-binary)=/.test(word)) && word.includes('@')) out.add(word)
    })
  } else if (program === 'wget') {
    argv.forEach((word, at) => {
      if ((at > 0 && argv[at - 1] === '--post-file') || word.startsWith('--post-file=')) out.add(word)
    })
  } else if (program === 'gh') {
    const plain = argv.slice(1).filter(word => !word.startsWith('-'))
    if (plain[0] === 'gist' && plain[1] === 'create') for (const word of plain.slice(2)) out.add(word)
  } else if (program === 'git') {
    const at = argv.findIndex((word, index) => index > 0 && !word.startsWith('-') && !/^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(argv[index - 1]!))
    const rest = at < 0 ? [] : argv.slice(at + 1)
    const verb = at < 0 ? '' : argv[at]!
    if (verb === 'hash-object' || verb === 'add' || (verb === 'diff' && rest.includes('--no-index'))) for (const word of rest) if (!word.startsWith('-')) out.add(word)
  }
  return out
}

export function searcherOf(layer: Layer): Layer | undefined {
  if (TREE_SEARCHERS.has(layer.program)) return readsWholeTree(layer) ? layer : undefined
  if (layer.program !== 'git') return undefined
  const at = layer.argv.findIndex((word, index) => index > 0 && !word.startsWith('-') && !/^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(layer.argv[index - 1]!))
  return at > 0 && layer.argv[at] === 'grep' ? { ...layer, program: 'grep', argv: ['grep', ...layer.argv.slice(at + 1)] } : undefined
}

export function keychainItemRead(layer: Layer): string | null {
  if (layer.program !== 'security') return null
  const argv = layer.argv
  const at = argv.findIndex((word, i) => i > 0 && !word.startsWith('-'))
  const verb = at < 0 ? '' : argv[at]!.toLowerCase()
  if (verb === 'dump-keychain') return argv.slice(at + 1).some(word => /^-[A-Za-z]*d/.test(word)) ? 'the keychain' : null
  if (!['find-generic-password', 'find-internet-password', 'export'].includes(verb)) return null
  const own = [getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX), getMacOsKeychainStorageServiceName(), getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX), getRawSpellingKeychainStorageServiceName()]
  const named = argv.slice(at + 1).find(word => own.includes(word) || /^mercury(?:-[a-z]+)*-[0-9a-f]{8}$/i.test(word))
  return named === undefined ? null : `the keychain item ${named}`
}

export function sharesEarlierStage(earlier: ReadCommand, later: ReadCommand): boolean {
  for (const a of earlier.stages) for (const b of later.stages) if (a.pipeline === b.pipeline && a.stage < b.stage) return true
  return false
}

export const GIT_OPTION_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
