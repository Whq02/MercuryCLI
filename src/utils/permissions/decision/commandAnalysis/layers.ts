import { posix } from 'node:path'
import { peelWrappers } from './wrappers.js'
import { UNREAD_PART, type Layer, type ReadCommand, type ReadWorld } from './reading.js'

const PRODUCT_WRAPPERS = new Set(['nohup', 'timeout', 'nice', 'env', 'stdbuf'])
const PLAIN_WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['time', new Set(['-f', '-o', '--format', '--output'])],
  ['exec', new Set(['-a'])],
  ['builtin', new Set<string>()],
  ['noglob', new Set<string>()],
  ['nocorrect', new Set<string>()],
  ['unbuffer', new Set<string>()],
  ['chronic', new Set<string>()],
  ['setsid', new Set<string>()],
  ['ionice', new Set(['-c', '-n', '--class', '--classdata'])],
  ['caffeinate', new Set(['-t', '-w'])],
  ['arch', new Set(['-arch', '-e', '-d'])],
  ['watch', new Set(['-n', '--interval'])],
  ['xargs', new Set(['-n', '-L', '-I', '-P', '-s', '-E', '-d', '-a', '-J', '-R', '-S', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--delimiter', '--arg-file'])],
])
const WRAPPER_NAMES = new Set([...PRODUCT_WRAPPERS, ...PLAIN_WRAPPERS.keys(), 'command', 'coproc', 'busybox', 'chrt', 'taskset'])
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/

export function programOf(word: string): string {
  const cut = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'))
  const name = (cut >= 0 ? word.slice(cut + 1) : word).toLowerCase()
  return name.replace(/\.(?:exe|com|cmd|bat)$/, '')
}

export function wordKnown(word: string): boolean {
  return !word.includes(UNREAD_PART) && !word.includes('$') && !word.includes('`')
}

function collapseDots(path: string): string {
  const collapsed = posix.normalize(path)
  if (collapsed === '.') return ''
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
}

function expandTilde(word: string, world: ReadWorld): string {
  if (!word.startsWith('~')) return word
  if (word === '~' || word.startsWith('~/')) return world.home === undefined ? word : world.home + word.slice(1)
  const named = /^~([A-Za-z0-9._-]+)(\/[\s\S]*)?$/.exec(word)
  if (named === null) return word
  const own = world.ownNames.includes(named[1]!) && world.home !== undefined
  return `${own ? world.home : `${world.homesRoot}/${named[1]}`}${named[2] ?? ''}`
}

function windowsSpelling(word: string): string {
  const slashed = word.replace(/\\/g, '/').replace(/^\/\/[?.]\/(?=[A-Za-z]:)/, '')
  const drive = /^\/(?:(?:mnt|cygdrive)\/)?([A-Za-z])(?=\/|$)/.exec(slashed)
  if (drive !== null) return `${drive[1]}:${slashed.slice(drive[0].length) || '/'}`
  return /^[A-Za-z]:$/.test(slashed) ? `${slashed}/` : slashed
}

export function absolutePath(word: string, cwd: string | undefined, world: ReadWorld): string | undefined {
  const expanded = world.windows === true ? windowsSpelling(expandTilde(word, world)) : expandTilde(word, world)
  if (expanded.startsWith('/') || (world.windows === true && /^[A-Za-z]:\//.test(expanded))) return collapseDots(expanded) || '/'
  if (cwd === undefined) return undefined
  return collapseDots(`${cwd}/${expanded}`) || '/'
}

function skipOptions(argv: string[], valued: ReadonlySet<string>): string[] | null {
  let i = 1
  while (i < argv.length) {
    const word = argv[i]!
    if (word === '--') {
      i++
      break
    }
    if (!word.startsWith('-') || word === '-') break
    i += valued.has(word) ? 2 : 1
  }
  return i < argv.length ? argv.slice(i) : null
}

function peelOnce(program: string, argv: string[]): string[] | string | null {
  if (PRODUCT_WRAPPERS.has(program)) {
    const peeled = peelWrappers([program, ...argv.slice(1)])
    if (!Array.isArray(peeled)) return peeled.failReason
    return peeled.length === argv.length ? null : peeled
  }
  const valued = PLAIN_WRAPPERS.get(program)
  if (valued !== undefined) return skipOptions(argv, valued)
  if (program === 'command') return argv.slice(1).some(word => /^-[a-zA-Z]*[vV]/.test(word)) ? null : skipOptions(argv, new Set())
  if (program === 'coproc') {
    const body = argv[1] === '{' ? argv.slice(2) : argv[2] === '{' ? argv.slice(3) : argv.slice(1)
    return body.length > 0 ? body : null
  }
  if (program === 'busybox') return argv.length > 1 ? argv.slice(1) : null
  if (program === 'do' || program === 'then' || program === 'else') return argv.length > 1 && wordKnown(argv[1]!) ? argv.slice(1) : null
  if (program === 'chrt' || program === 'taskset') {
    const rest = skipOptions(argv, new Set(['-c', '--cpu-list', '-p', '--pid']))
    if (rest === null) return null
    return argv.includes('-c') || argv.includes('--cpu-list') ? rest : rest.length > 1 ? rest.slice(1) : null
  }
  return null
}

function findParts(argv: string[]): { roots: string[]; execs: string[][] } {
  const roots: string[] = []
  const execs: string[][] = []
  let i = 1
  while (i < argv.length && /^-(?:[HLP]+|D|O\d?)$/.test(argv[i]!)) i += argv[i] === '-D' ? 2 : 1
  for (; i < argv.length; i++) {
    const word = argv[i]!
    if (word.startsWith('-') || word === '(' || word === '!' || word === ')') break
    roots.push(word)
  }
  for (; i < argv.length; i++) {
    if (!FIND_EXEC.has(argv[i]!)) continue
    const inner: string[] = []
    for (i++; i < argv.length && argv[i] !== ';' && argv[i] !== '+'; i++) inner.push(argv[i]!)
    if (inner.length > 0) execs.push(inner)
  }
  return { roots, execs }
}

export function layersOf(argv: string[], findRoots?: string[]): Layer[] {
  const out: Layer[] = []
  const wrappers: string[] = []
  const env: Array<{ name: string; value: string }> = []
  let current = argv
  for (let turn = 0; turn < 32 && current.length > 0; turn++) {
    const program = programOf(current[0]!)
    const layer: Layer = { argv: current, program, wrappers: [...wrappers], env: [...env], opaque: undefined, findRoots }
    out.push(layer)
    if (program === 'find') {
      const { roots, execs } = findParts(current)
      layer.findRoots = roots
      for (const inner of execs) out.push(...layersOf(inner, roots).map(found => ({ ...found, wrappers: [...wrappers, 'find', ...found.wrappers] })))
      break
    }
    const step = peelOnce(program, current)
    if (step === null) break
    if (typeof step === 'string') {
      layer.opaque = step
      break
    }
    for (const skipped of current.slice(0, current.length - step.length)) {
      const name = programOf(skipped)
      if (WRAPPER_NAMES.has(name)) wrappers.push(name)
      const assigned = ASSIGNMENT.exec(skipped)
      if (assigned !== null) env.push({ name: assigned[1]!, value: assigned[2]! })
    }
    current = step
  }
  return out
}

const MOVES = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location', 'popd', 'pop-location'])
const SAME_SHELL = new Set(['builtin', 'command', 'time', 'noglob', 'nocorrect'])
const MOVE_VALUED = ['path', 'literalpath', 'stackname', 'erroraction', 'warningaction', 'informationaction', 'progressaction', 'errorvariable', 'warningvariable', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable']
const MOVE_SWITCHES = ['passthru', 'verbose', 'debug', 'usetransaction']
const MOVE_ALIASES = new Map([['pspath', 'literalpath'], ['lp', 'literalpath'], ['ea', 'erroraction'], ['wa', 'warningaction'], ['infa', 'informationaction'], ['proga', 'progressaction'], ['ev', 'errorvariable'], ['wv', 'warningvariable'], ['iv', 'informationvariable'], ['ov', 'outvariable'], ['ob', 'outbuffer'], ['pv', 'pipelinevariable'], ['vb', 'verbose'], ['db', 'debug'], ['usetx', 'usetransaction']])

export function inSameShell(layer: Layer): boolean {
  return layer.wrappers.every(name => SAME_SHELL.has(name))
}

export function moveOf(command: Pick<ReadCommand, 'argv' | 'dialect'>): { program: string; operands: string[] } | undefined {
  const layer = layersOf(command.argv).find(found => MOVES.has(found.program))
  if (layer === undefined || layer.wrappers.some(name => !SAME_SHELL.has(name))) return undefined
  const words = layer.argv.slice(1)
  if (command.dialect === 'posix') {
    const ends = words.indexOf('--')
    return { program: layer.program, operands: words.filter((word, at) => (ends >= 0 && at > ends) || (at !== ends && !/^-[A-Za-z]+$/.test(word))) }
  }
  const named: string[] = []
  const loose: string[] = []
  const unknown: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === '--') {
      loose.push(...words.slice(i + 1))
      break
    }
    if (!/^-[A-Za-z]/.test(word)) {
      loose.push(word)
      continue
    }
    const colon = word.indexOf(':')
    const name = (colon < 0 ? word.slice(1) : word.slice(1, colon)).toLowerCase()
    const meant = [...MOVE_VALUED, ...MOVE_SWITCHES].filter(full => full.startsWith(name))
    const full = MOVE_ALIASES.get(name) ?? (meant.includes(name) ? name : meant.length === 1 ? meant[0] : undefined)
    if (full === undefined) unknown.push(word)
    else if (MOVE_VALUED.includes(full)) {
      const value = colon < 0 ? words[++i] : word.slice(colon + 1)
      if (value !== undefined && (full === 'path' || full === 'literalpath')) named.push(value)
    }
  }
  return { program: layer.program, operands: named.length + loose.length === 0 && unknown.length > 0 ? ['.', ...unknown] : [...named, ...loose, ...unknown] }
}
