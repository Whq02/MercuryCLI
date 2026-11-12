import { posix } from 'node:path'
import { peelWrappers, shellCommandText } from '../bash/ast.js'
import { parseCommandRaw, type Node } from '../bash/parser.js'

export const UNREAD_PART = '\uFFFC'

type ShellDialect = 'posix' | 'powershell'
type Stage = { pipeline: number; stage: number }

type ReadRedirect = { op: string; target: string }

export type ReadCommand = {
  argv: string[]
  env: Array<{ name: string; value: string }>
  redirects: ReadRedirect[]
  text: string
  line: number
  cwd: string | undefined
  background: boolean
  stages: readonly Stage[]
  input: string | undefined
  inner: number[][]
  inputInner: number[]
  body: string | undefined
  dialect: ShellDialect
  around: string | undefined
  gates?: ReadonlyArray<readonly [number, number]> | undefined
  maybes?: readonly number[] | undefined
  substituted?: boolean | undefined
  called?: 'name' | 'block' | undefined
  handed?: string | undefined
}

export type Layer = {
  argv: string[]
  program: string
  wrappers: string[]
  env: Array<{ name: string; value: string }>
  opaque: string | undefined
  findRoots: string[] | undefined
}

export type ShellRead = {
  commands: ReadCommand[]
  pipelineSizes: number[]
  exported: Map<string, string[]>
  homes: readonly string[]
  unread: { why: string; text: string } | undefined
}

export type ReadWorld = {
  cwd: string | undefined
  home: string | undefined
  homesRoot: string
  ownNames: readonly string[]
  user?: string
  uid?: string
  windows?: boolean
}

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'mksh', 'yash', 'csh', 'tcsh'])
const POWERSHELLS = new Set(['pwsh', 'powershell'])
const PASSTHROUGH = new Set(['cat', 'tee'])
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
const READING_CAP = 8
const SCRIPT_DEPTH_CAP = 64
const SCRIPT_COUNT_CAP = 256
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

function readsStdin(argv: string[]): boolean {
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
  if (POSIX_SHELLS.has(layer.program)) return readsStdin(layer.argv)
  if (/^(?:python[\d.]*|node|nodejs|perl|ruby|php|lua|deno|bun)$/.test(layer.program)) return layer.argv.length === 1 || layer.argv.slice(1).every(word => word === '-')
  return false
}

export function scriptSentToProgram(argv: string[], text: string): string | undefined {
  const layer = layersOf(argv).at(-1)
  if (layer === undefined) return undefined
  if (POSIX_SHELLS.has(layer.program)) return readsStdin(layer.argv) ? text : undefined
  if (POWERSHELLS.has(layer.program)) return layer.argv.slice(1).some(word => /^-(?:c|f)/i.test(word)) ? undefined : shellCommandText([layer.program, '-Command', text])
  if (layer.program === 'cmd') return layer.argv.slice(1).some(word => /^\/\/?c$/i.test(word)) ? undefined : shellCommandText(['cmd', '/c', text])
  return undefined
}

type Pending = { text: string; dialect: ShellDialect; from: number; body?: string; cmd?: boolean }

const EXPANSION_CAP = 4
const ALIAS_DEFINITION = /^([^=\s]+)=([\s\S]*)$/

function withPositionals(body: string, args: string[]): string {
  const plain = (value: string): string => value.replace(/["\\$`]/g, '\\$&')
  return body.replace(/\$(?:\{([1-9@*])\}|([1-9@*]))/g, (_all, braced: string | undefined, bare: string | undefined) => {
    const key = braced ?? bare ?? ''
    return key === '@' || key === '*' ? args.map(plain).join(' ') : plain(args[Number(key) - 1] ?? '')
  })
}

export function printedBy(command: ReadCommand | undefined): string | undefined {
  const layer = command === undefined ? undefined : layersOf(command.argv).at(-1)
  if (layer === undefined) return undefined
  return layer.program === 'echo' ? echoText(layer.argv) : layer.program === 'printf' ? printfText(layer.argv) : undefined
}

function nestedScripts(command: ReadCommand, from: number, commands: readonly ReadCommand[]): Pending[] {
  const out: Pending[] = []
  for (const layer of layersOf(command.argv)) {
    const { program, argv } = layer
    if (POSIX_SHELLS.has(program) || program === 'source' || program === '.' || program === 'eval') {
      for (const at of [...command.inputInner, ...command.inner.flat()]) {
        const printed = printedBy(commands[at])
        if (printed !== undefined) out.push({ text: printed, dialect: 'posix', from })
      }
    }
    if (POSIX_SHELLS.has(program)) {
      const script = scriptWordAfter(argv, /^-[a-zA-Z]*c[a-zA-Z]*$/, SHELL_VALUED)
      if (script !== undefined) out.push({ text: script, dialect: 'posix', from })
      else if (command.input !== undefined && readsStdin(argv)) out.push({ text: command.input, dialect: 'posix', from })
    } else if (program === 'eval') {
      if (argv.length > 1) out.push({ text: argv.slice(1).join(' '), dialect: command.dialect, from })
    } else if (program === 'su' || program === 'runuser') {
      for (let i = 1; i < argv.length; i++) {
        const word = argv[i]!
        if ((word === '-c' || word === '--command' || word === '--session-command') && argv[i + 1] !== undefined) out.push({ text: argv[i + 1]!, dialect: 'posix', from })
        else if (word.startsWith('--command=')) out.push({ text: word.slice(10), dialect: 'posix', from })
      }
    } else if (program === 'trap') {
      if (argv.length > 2 && !argv[1]!.startsWith('-')) out.push({ text: argv[1]!, dialect: 'posix', from })
    } else if (POWERSHELLS.has(program)) {
      for (let i = 1; i < argv.length; i++) {
        if (!/^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(argv[i]!)) continue
        if (i + 1 < argv.length) out.push({ text: argv.slice(i + 1).join(' '), dialect: 'powershell', from })
        break
      }
    } else if (program === 'cmd') {
      const at = argv.findIndex(word => /^\/\/?[ck]$/i.test(word))
      if (at >= 0 && at + 1 < argv.length) out.push({ text: argv.slice(at + 1).join(' '), dialect: 'powershell', from, cmd: true })
    } else if (command.dialect === 'powershell' && (program === 'invoke-expression' || program === 'iex')) {
      const script = argv.slice(1).filter(word => !/^-[A-Za-z]+$/.test(word))
      if (script.length > 0) out.push({ text: script.join(' '), dialect: 'powershell', from })
      else if (command.handed !== undefined) out.push({ text: command.handed, dialect: 'powershell', from })
    } else if (command.dialect === 'powershell' && (program === 'start-process' || program === 'saps' || program === 'start')) {
      const started = startedBy(argv.slice(1))
      if (started !== undefined) out.push({ text: started, dialect: 'powershell', from })
    }
  }
  return out
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

function unescapeBackslashes(text: string): string {
  return text.replace(/\\([\s\S])/g, (_all, ch: string) => (ch === '\n' ? '' : ch))
}

function ansiC(text: string): string {
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

type Words = { values: string[]; inner: number[] }

class Reading {
  readonly commands: ReadCommand[] = []
  readonly pipelineSizes: number[] = []
  readonly exported = new Map<string, string[]>()
  readonly scope = new Map<string, string[]>()
  readonly stageHeads = new Map<string, number>()
  readonly pending: Pending[] = []
  readonly folders: Array<string | undefined> = []
  readonly functions = new Map<string, string>()
  readonly aliases = new Map<string, string>()
  readonly expansions = new Map<string, number>()
  unread: { why: string; text: string } | undefined
  scripts = 0
  contexts = 0
  cwd: string | undefined
  oldpwd: string | undefined

  constructor(readonly world: ReadWorld) {
    this.cwd = world.cwd
    if (world.home !== undefined) this.scope.set('HOME', [world.home])
    if (world.user !== undefined) for (const name of ['USER', 'LOGNAME', 'USERNAME']) this.scope.set(name, [world.user])
    if (world.uid !== undefined) for (const name of ['UID', 'EUID']) this.scope.set(name, [world.uid])
  }

  markUnread(why: string, text: string): void {
    this.unread ??= { why, text }
  }

  assign(name: string, values: string[]): void {
    const known = this.scope.get(name) ?? []
    for (const value of values) if (!known.includes(value)) known.push(value)
    this.scope.set(name, known.slice(-READING_CAP))
  }

  push(command: ReadCommand): number {
    this.commands.push(command)
    const index = this.commands.length - 1
    const stage = command.stages[command.stages.length - 1]
    if (stage !== undefined) {
      const key = `${stage.pipeline}:${stage.stage}`
      if (!this.stageHeads.has(key)) this.stageHeads.set(key, index)
    }
    for (const entry of command.env) this.assign(entry.name, [entry.value])
    for (const layer of layersOf(command.argv)) for (const entry of layer.env) this.assign(entry.name, [entry.value])
    this.follow(command)
    this.pending.push(...nestedScripts(command, index, this.commands))
    this.expand(command, index)
    return index
  }

  expand(command: ReadCommand, index: number): void {
    const head = command.argv[0]
    if (head === undefined || command.dialect !== 'posix') return
    const once = (name: string): boolean => {
      const made = this.expansions.get(name) ?? 0
      this.expansions.set(name, made + 1)
      return made < EXPANSION_CAP
    }
    const alias = this.aliases.get(head)
    if (alias !== undefined && once(`alias ${head}`)) this.pending.push({ text: `${alias} ${shellCommandText(command.argv.slice(1))}`.trim(), dialect: 'posix', from: index })
    const body = this.functions.get(head)
    if (body !== undefined && command.body === undefined && command.argv.length > 1 && once(`function ${head}`)) this.pending.push({ text: withPositionals(body, command.argv.slice(1)), dialect: 'posix', from: index, body: head })
    if (programOf(head) !== 'alias') return
    for (const word of command.argv.slice(1)) {
      const defined = ALIAS_DEFINITION.exec(word)
      if (defined !== null) this.aliases.set(defined[1]!, defined[2]!)
    }
  }

  follow(command: ReadCommand): void {
    const move = moveOf(command)
    if (move === undefined) return
    const pushes = move.program === 'pushd' || move.program === 'push-location'
    if (move.program === 'popd' || move.program === 'pop-location') {
      this.cwd = this.folders.pop()
      return
    }
    if (pushes) this.folders.push(this.cwd)
    const operands = move.operands
    const target = this.world.windows === true && operands.length > 1 && /^\/d$/i.test(operands[0]!) ? operands[1] : operands[0]
    const left = this.cwd
    if (target === undefined) this.cwd = pushes ? undefined : (this.scope.get('HOME')?.at(-1) ?? this.world.home)
    else if (target === '-') this.cwd = this.oldpwd
    else if (command.dialect === 'posix' && this.oldpwd !== undefined && /^~-(?=\/|$)/.test(target)) this.cwd = absolutePath(this.oldpwd + target.slice(2), undefined, this.world)
    else if (!wordKnown(target)) this.cwd = undefined
    else this.cwd = absolutePath(command.dialect === 'powershell' ? target.replace(/\\/g, '/') : target, this.cwd, this.world)
    this.oldpwd = left
  }
}

type Frame = { background: boolean; stages: readonly Stage[]; body: string | undefined; line: number; dialect: ShellDialect; around: string | undefined; gates?: ReadonlyArray<readonly [number, number]> | undefined; maybes?: readonly number[] | undefined; substituted?: boolean | undefined; cmd?: boolean | undefined }

const WORD_KINDS = new Set(['word', 'number', 'raw_string', 'string', 'concatenation', 'ansi_c_string', 'translated_string', 'simple_expansion', 'expansion', 'command_substitution', 'process_substitution', 'arithmetic_expansion', 'brace_expression'])
const WRITE_KEEPERS = new Set(['file_redirect', 'heredoc_redirect', 'herestring_redirect'])

function buriedScripts(text: string, quoted: boolean): string[] {
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

function cross(left: string[], right: string[]): string[] {
  const out: string[] = []
  for (const a of left) for (const b of right) if (out.length < READING_CAP) out.push(a + b)
  return out
}

class PosixWalk {
  constructor(
    readonly reading: Reading,
    readonly source: string,
  ) {}

  lineOf(node: Node, frame: Frame): number {
    let line = frame.line
    for (let i = 0; i < node.startIndex && i < this.source.length; i++) if (this.source[i] === '\n') line++
    return line
  }

  children(parent: Node, frame: Frame): void {
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i]!
      const background = parent.children[i + 1]?.type === '&'
      this.node(child, background && !frame.background ? { ...frame, background: true } : frame)
    }
  }

  isolated(run: () => void): void {
    const cwd = this.reading.cwd
    const oldpwd = this.reading.oldpwd
    const depth = this.reading.folders.length
    run()
    this.reading.cwd = cwd
    this.reading.oldpwd = oldpwd
    this.reading.folders.length = depth
  }

  maybe(frame: Frame): Frame {
    return { ...frame, maybes: [...(frame.maybes ?? []), ++this.reading.contexts] }
  }

  buried(node: Node, frame: Frame, quoted: boolean): number[] {
    const scripts = buriedScripts(node.text, quoted)
    if (scripts.length === 0) return []
    const at = this.reading.push({ argv: [], env: [], redirects: [], text: node.text, line: this.lineOf(node, frame), cwd: this.reading.cwd, background: frame.background, stages: frame.stages, input: undefined, inner: [], inputInner: [], body: frame.body, dialect: frame.dialect, around: frame.around, gates: frame.gates, maybes: frame.maybes, substituted: true })
    for (const text of scripts) this.reading.pending.push({ text, dialect: 'posix', from: at })
    return [at]
  }

  node(node: Node, frame: Frame): void {
    switch (node.type) {
      case 'command':
        this.command(node, frame, [], undefined, [])
        return
      case 'pipeline':
        this.pipeline(node, frame)
        return
      case 'redirected_statement':
        this.redirected(node, frame)
        return
      case 'subshell':
        this.isolated(() => this.children(node, frame))
        return
      case 'command_substitution':
      case 'process_substitution':
        this.isolated(() => this.children(node, { ...frame, substituted: true }))
        return
      case 'if_statement': {
        let body: Frame | undefined
        node.children.forEach((child, at) => {
          if (child.type === 'then') {
            body = this.maybe(frame)
            return
          }
          const base = child.type === 'elif_clause' || child.type === 'else_clause' ? this.maybe(frame) : (body ?? frame)
          this.node(child, node.children[at + 1]?.type === '&' && !base.background ? { ...base, background: true } : base)
        })
        return
      }
      case 'do_group':
      case 'case_item':
        this.children(node, this.maybe(frame))
        return
      case 'list': {
        const joined = node.children.findIndex(child => child.type === '&&')
        const either = node.children.findIndex(child => child.type === '||')
        if (joined <= 0 && either > 0) {
          for (const child of node.children.slice(0, either)) this.node(child, frame)
          const right = this.maybe(frame)
          for (const child of node.children.slice(either + 1)) this.node(child, right)
          return
        }
        if (joined <= 0) {
          this.children(node, frame)
          return
        }
        const from = this.reading.commands.length
        for (const child of node.children.slice(0, joined)) this.node(child, frame)
        const gate: readonly [number, number] = [from, this.reading.commands.length]
        for (const child of node.children.slice(joined + 1)) this.node(child, { ...frame, gates: [...(frame.gates ?? []), gate] })
        return
      }
      case 'for_statement':
        this.loop(node, frame)
        return
      case 'function_definition': {
        const name = node.children.find(child => child.type === 'word')?.text
        const body = node.children.find(child => child.type === 'compound_statement' || child.type === 'subshell')?.text
        if (name !== undefined && body !== undefined) this.reading.functions.set(name, body)
        this.isolated(() => this.children(node, { ...frame, body: name ?? frame.body, background: false, stages: [] }))
        return
      }
      case 'variable_assignment':
        this.assignment(node, frame)
        return
      case 'regex':
        this.buried(node, frame, true)
        return
      case 'declaration_command':
        for (const child of node.children) {
          if (child.type !== 'variable_assignment') {
            this.node(child, frame)
            continue
          }
          const assigned = this.assignment(child, frame)
          if (assigned !== undefined && node.children[0]?.type === 'export') this.reading.exported.set(assigned.name, assigned.values)
        }
        return
      case 'ERROR':
        this.reading.markUnread('the shell parser found incomplete or invalid syntax in it', this.source)
        this.children(node, frame)
        return
      default:
        if (WORD_KINDS.has(node.type)) {
          this.word(node, frame)
          return
        }
        this.children(node, frame)
    }
  }

  assignment(node: Node, frame: Frame): { name: string; values: string[] } | undefined {
    const name = node.children.find(child => child.type === 'variable_name')?.text
    const value = node.children.find(child => child.type !== 'variable_name' && child.type !== '=' && child.type !== '+=')
    const values = value === undefined ? [''] : this.word(value, frame).values
    if (name === undefined) return undefined
    this.reading.assign(name, values)
    return { name, values }
  }

  loop(node: Node, frame: Frame): void {
    const name = node.children.find(child => child.type === 'variable_name')?.text
    const items: string[] = []
    for (const child of node.children) {
      if (child.type === 'do_group') {
        if (name !== undefined) this.reading.scope.set(name, items.length > 0 ? items.slice(0, READING_CAP) : [`$${name}`])
        this.children(child, this.maybe(frame))
      } else if (WORD_KINDS.has(child.type)) items.push(...this.word(child, frame).values)
    }
  }

  userPrintedBy(inner: number[]): string | undefined {
    if (inner.length !== 1) return undefined
    const argv = this.reading.commands[inner[0]!]?.argv ?? []
    const program = programOf(argv[0] ?? '')
    const { user, uid } = this.reading.world
    if (program === 'pwd' && argv.slice(1).every(word => /^-[LP]+$/.test(word))) return this.reading.commands[inner[0]!]?.cwd
    if ((program === 'whoami' || program === 'logname') && argv.length === 1) return user
    if (program !== 'id') return undefined
    const flags = argv.slice(1).join('')
    if (flags === '-un' || flags === '-nu' || flags === '-u-n' || flags === '-n-u') return user
    return flags === '-u' || flags === '-ru' || flags === '-ur' ? uid : undefined
  }

  variable(node: Node, frame: Frame): Words {
    const name = (node.children.find(child => child.type === 'variable_name') ?? node.children.find(child => child.type === 'special_variable_name'))?.text
    const inner: number[] = []
    const within = (part: Node): void => {
      for (const child of part.children) {
        if (child.type === 'regex') inner.push(...this.buried(child, frame, true))
        else if (WORD_KINDS.has(child.type)) inner.push(...this.word(child, frame).inner)
        else within(child)
      }
    }
    within(node)
    const known = name === undefined ? undefined : this.reading.scope.get(name)
    if (known !== undefined && known.length > 0) return { values: [...known].reverse(), inner }
    if (name === 'PWD' && this.reading.cwd !== undefined && (node.type === 'simple_expansion' || node.text === '${PWD}')) return { values: [this.reading.cwd], inner }
    if (name === 'OLDPWD' && this.reading.oldpwd !== undefined && (node.type === 'simple_expansion' || node.text === '${OLDPWD}')) return { values: [this.reading.oldpwd], inner }
    return { values: [node.text], inner }
  }

  word(node: Node, frame: Frame): Words {
    switch (node.type) {
      case 'word': {
        const text = unescapeBackslashes(node.text)
        const stands = this.reading.cwd
        const leads = node.startIndex === 0 || /[\s;&|(=:]/.test(this.source[node.startIndex - 1] ?? '')
        return { values: [stands !== undefined && leads && /^~\+(?=\/|$)/.test(node.text) ? stands + text.slice(2) : text], inner: [] }
      }
      case 'raw_string':
        return { values: [node.text.slice(1, -1)], inner: [] }
      case 'ansi_c_string':
        return { values: [ansiC(node.text.slice(2, -1))], inner: [] }
      case 'simple_expansion':
      case 'expansion':
        return this.variable(node, frame)
      case 'command_substitution':
      case 'process_substitution': {
        const before = this.reading.commands.length
        this.node(node, frame)
        const inner: number[] = []
        for (let i = before; i < this.reading.commands.length; i++) inner.push(i)
        const named = node.type === 'command_substitution' ? this.userPrintedBy(inner) : undefined
        return { values: [named ?? UNREAD_PART], inner }
      }
      case 'arithmetic_expansion':
        this.children(node, frame)
        return { values: [UNREAD_PART], inner: [] }
      case 'string':
      case 'translated_string': {
        let values = ['']
        const inner: number[] = []
        let cursor: number | undefined
        for (const child of node.children) {
          if (cursor !== undefined && child.startIndex > cursor) values = cross(values, [this.source.slice(cursor, child.startIndex).replace(/\\([$`"\\\n])/g, (_all, ch: string) => (ch === '\n' ? '' : ch))])
          cursor = child.endIndex
          if (child.type === '"' || child.type === '$"') continue
          if (child.type === 'string_content') {
            values = cross(values, [child.text.replace(/\\([$`"\\\n])/g, (_all, ch: string) => (ch === '\n' ? '' : ch))])
            continue
          }
          const part = WORD_KINDS.has(child.type) ? this.word(child, frame) : { values: [child.text], inner: [] }
          values = cross(values, part.values)
          inner.push(...part.inner)
        }
        return { values, inner }
      }
      case 'concatenation': {
        let values = ['']
        const inner: number[] = []
        for (const child of node.children) {
          const part = this.word(child, frame)
          values = cross(values, part.values)
          inner.push(...part.inner)
        }
        return { values, inner }
      }
      default:
        this.children(node, frame)
        return { values: [node.text], inner: [] }
    }
  }

  redirect(node: Node, frame: Frame, redirects: ReadRedirect[], inputInner: number[]): void {
    let op = ''
    for (const child of node.children) {
      if (child.type === 'file_descriptor') continue
      if (op === '') {
        op = child.type
        continue
      }
      const read = this.word(child, frame)
      if (child.type === 'process_substitution') {
        if (op === '<') inputInner.push(...read.inner)
        continue
      }
      for (const target of read.values) redirects.push({ op, target })
    }
  }

  command(node: Node, frame: Frame, redirects: ReadRedirect[], input: string | undefined, inputInner: number[]): number {
    const words: Words[] = []
    const env: Array<{ name: string; value: string }> = []
    const own = [...redirects]
    const ownInner = [...inputInner]
    let text = input
    for (const child of node.children) {
      switch (child.type) {
        case 'variable_assignment': {
          const name = child.children.find(part => part.type === 'variable_name')?.text
          const value = child.children.find(part => part.type !== 'variable_name' && part.type !== '=' && part.type !== '+=')
          if (name !== undefined) env.push({ name, value: value === undefined ? '' : (this.word(value, frame).values[0] ?? '') })
          break
        }
        case 'command_name':
          words.push(this.word(child.children[0] ?? child, frame))
          break
        case 'file_redirect':
          this.redirect(child, frame, own, ownInner)
          break
        case 'herestring_redirect': {
          const content = child.children.find(part => part.type !== '<<<' && part.type !== 'file_descriptor')
          if (content !== undefined) text = this.word(content, frame).values[0]
          break
        }
        default:
          if (WORD_KINDS.has(child.type)) words.push(this.word(child, frame))
          else this.node(child, frame)
      }
    }
    const readings = Math.min(READING_CAP, Math.max(1, ...words.map(word => word.values.length)))
    let first = -1
    for (let k = 0; k < readings; k++) {
      const index = this.reading.push({
        argv: words.map(word => word.values[Math.min(k, word.values.length - 1)] ?? ''),
        env,
        redirects: own,
        text: node.text,
        line: this.lineOf(node, frame),
        cwd: this.reading.cwd,
        background: frame.background,
        stages: frame.stages,
        input: text,
        inner: words.map(word => word.inner),
        inputInner: ownInner,
        body: frame.body,
        dialect: frame.dialect,
        around: frame.around,
        gates: frame.gates,
        maybes: frame.maybes,
        substituted: frame.substituted,
      })
      if (first < 0) first = index
    }
    return first
  }

  redirected(node: Node, outer: Frame): void {
    const frame = outer.around === undefined ? { ...outer, around: node.text } : outer
    const redirects: ReadRedirect[] = []
    const inputInner: number[] = []
    let input: string | undefined
    let body: Node | undefined
    const continuations: Node[] = []
    for (const child of node.children) {
      if (child.type === 'file_redirect') this.redirect(child, frame, redirects, inputInner)
      else if (child.type === 'herestring_redirect') {
        const content = child.children.find(part => part.type !== '<<<' && part.type !== 'file_descriptor')
        if (content !== undefined) input = this.word(content, frame).values[0]
      } else if (child.type === 'heredoc_redirect') {
        const expands = !/['"\\]/.test(child.children.find(part => part.type === 'heredoc_start')?.text ?? '')
        for (const part of child.children) {
          if (part.type === 'heredoc_body') {
            input = part.text
            this.children(part, frame)
            if (expands) for (const leaf of part.children.length === 0 ? [part] : part.children.filter(piece => piece.type === 'heredoc_content')) this.buried(leaf, frame, false)
          } else if (part.type === 'file_redirect') this.redirect(part, frame, redirects, inputInner)
          else if (part.type !== '<<' && part.type !== '<<-' && part.type !== 'heredoc_start' && part.type !== 'heredoc_end' && part.type !== 'file_descriptor') continuations.push(part)
        }
      } else if (!WRITE_KEEPERS.has(child.type) && body === undefined) body = child
      else this.node(child, frame)
    }
    const piped = continuations.find(part => part.type === 'pipeline')
    const pipeline = piped === undefined ? undefined : this.reading.pipelineSizes.push(1 + piped.children.filter(part => part.type !== '|' && part.type !== '|&').length) - 1
    const inside = pipeline === undefined ? frame : { ...frame, stages: [...frame.stages, { pipeline, stage: 0 }] }
    const before = this.reading.commands.length
    if (body === undefined) this.reading.push({ argv: [], env: [], redirects, text: node.text, line: this.lineOf(node, frame), cwd: this.reading.cwd, background: frame.background, stages: inside.stages, input, inner: [], inputInner, body: frame.body, dialect: frame.dialect, around: frame.around })
    else if (body.type === 'command') this.command(body, inside, redirects, input, inputInner)
    else {
      this.node(body, inside)
      const last = this.reading.commands[this.reading.commands.length - 1]
      if (last !== undefined && this.reading.commands.length > before) {
        last.redirects = [...last.redirects, ...redirects]
        last.input ??= input
        last.inputInner = [...last.inputInner, ...inputInner]
        this.reading.pending.push(...nestedScripts(last, this.reading.commands.length - 1, this.reading.commands).filter(script => script.text === input))
      } else this.reading.push({ argv: [], env: [], redirects, text: node.text, line: this.lineOf(node, frame), cwd: this.reading.cwd, background: frame.background, stages: inside.stages, input, inner: [], inputInner, body: frame.body, dialect: frame.dialect, around: frame.around })
    }
    for (const part of continuations) {
      if (part !== piped || pipeline === undefined) {
        this.node(part, frame)
        continue
      }
      let stage = 0
      for (const member of part.children) {
        if (member.type === '|' || member.type === '|&') continue
        stage++
        this.isolated(() => this.node(member, { ...frame, stages: [...frame.stages, { pipeline, stage }] }))
      }
      this.feed(pipeline, stage + 1)
    }
  }

  pipeline(node: Node, outer: Frame): void {
    const frame = outer.around === undefined ? { ...outer, around: node.text } : outer
    const members = node.children.filter(child => child.type !== '|' && child.type !== '|&')
    const pipeline = this.reading.pipelineSizes.push(members.length) - 1
    for (const [stage, member] of members.entries()) this.isolated(() => this.node(member, { ...frame, stages: [...frame.stages, { pipeline, stage }] }))
    this.feed(pipeline, members.length)
  }

  feed(pipeline: number, size: number): void {
    for (let stage = 1; stage < size; stage++) {
      const at = this.reading.stageHeads.get(`${pipeline}:${stage}`)
      const reader = at === undefined ? undefined : this.reading.commands[at]
      if (at === undefined || reader === undefined || reader.input !== undefined) continue
      if (!layersOf(reader.argv).some(layer => POSIX_SHELLS.has(layer.program) && readsStdin(layer.argv))) continue
      for (let earlier = stage - 1; earlier >= 0; earlier--) {
        const head = this.reading.stageHeads.get(`${pipeline}:${earlier}`)
        const writer = head === undefined ? undefined : this.reading.commands[head]
        const layer = writer === undefined ? undefined : layersOf(writer.argv).at(-1)
        if (writer === undefined || layer === undefined) break
        if (PASSTHROUGH.has(layer.program) && writer.input !== undefined) {
          this.reading.pending.push({ text: writer.input, dialect: 'posix', from: at })
          break
        }
        const printed = printedBy(writer)
        if (printed !== undefined) {
          this.reading.pending.push({ text: printed, dialect: 'posix', from: at })
          break
        }
        if (!PASSTHROUGH.has(layer.program)) break
      }
    }
  }
}

type PsToken = { value: string; text: string; inner: number[]; bare: boolean; other?: string | undefined }
type PsValue = { value: string; sure: boolean }

const PS_STATEMENT_HEAD = new RegExp(`(?:^|${UNREAD_PART})(?:foreach|for|if|elseif|while|switch|until)$`, 'i')
const PS_LOOP_VARIABLE = new RegExp(`^(?:\\[.*\\])?\\$(?:${UNREAD_PART}|[\\p{L}\\p{N}_?^$])`, 'u')

const PS_ASSIGNS = /^([^=]*?)(?:[-+*/%]|\?\?)?=([\s\S]*)$/
const PS_VALUE_START = /^[$[('"@{]/
const PS_OPERATOR = /^(?:[-+*/%,]|\.\.|-(?:[ci]?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split)|f|join|is|isnot|as|and|or|xor|band|bor|bxor|shl|shr))$/i
const PS_HOME_CONSTANT = /^\$(?:home|env:(?:userprofile|home))$/i
const PS_VARIABLE = /^\$(?:(?:script|global|local|private):)?([a-z_]\w*)$/i
const PS_GIVEN = /^\$(?:(?:script|global|local|private):)?([a-z_]\w*)\s*((?:[-+*/%]|\?\?)?=)(?!=)/i
const PS_COMBINE = /^\[(?:System\.)?IO\.Path\]::Combine\(([\s\S]*)\)$/i

const PS_MOVES = new Set(['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location'])

class PowerShellWalk {
  at = 0
  typed = false
  said: string | undefined
  maybe: string | undefined
  values = new Map<string, string>()
  parts: readonly PsToken[] = []
  gates: ReadonlyArray<readonly [number, number]> = []
  maybes: readonly number[] = []
  previous: readonly [number, number] | undefined

  constructor(
    readonly reading: Reading,
    readonly source: string,
    readonly frame: Frame,
  ) {}

  line(at: number): number {
    let line = this.frame.line
    for (let i = 0; i < at && i < this.source.length; i++) if (this.source[i] === '\n') line++
    return line
  }

  statements(closer: string | undefined, stages: readonly Stage[]): number[] {
    const made: number[] = []
    const text = this.source
    const outer = { gates: this.gates, maybes: this.maybes, previous: this.previous }
    let held = outer.gates
    let last: readonly [number, number] | undefined
    let said: string | undefined
    let maybe: string | undefined
    let read = 0
    while (this.at < text.length) {
      this.blank(true)
      const ch = text[this.at]
      if (ch === undefined) break
      if (closer !== undefined && ch === closer) break
      if (ch === ')' || ch === '}') {
        this.at++
        continue
      }
      const from = this.reading.commands.length
      this.previous = last
      const own = this.pipeline(closer, stages)
      said = read === 0 ? this.said : undefined
      maybe = read++ === 0 ? this.maybe : undefined
      made.push(...own)
      const moved = own.length === 1 && this.reading.commands.length === from + 1 ? this.plainMove(from) : undefined
      last = moved === undefined ? undefined : [from, from + 1]
      const next = text[this.at]
      if (next === '&' && text[this.at + 1] === '&') {
        this.at += 2
        if (last === undefined) this.maybes = [...this.maybes, ++this.reading.contexts]
        else this.gates = [...this.gates, last]
        continue
      }
      if (moved === 'stops' && last !== undefined) held = [...held, last]
      this.gates = held
      this.maybes = outer.maybes
      if (next === ';' || next === '\n') this.at++
      else if (next === '|' && text[this.at + 1] === '|') this.at += 2
      else if (next === '&') this.at++
    }
    this.gates = outer.gates
    this.maybes = outer.maybes
    this.previous = outer.previous
    this.said = said
    this.maybe = maybe
    return made
  }

  kept(word: PsToken): string | undefined {
    const name = word.bare ? PS_VARIABLE.exec(word.value)?.[1] : undefined
    return name === undefined ? undefined : this.values.get(name.toLowerCase())
  }

  part(word: PsToken, loose = false): PsValue | undefined {
    if (word.value.includes(UNREAD_PART)) return word.other === undefined ? undefined : { value: word.other, sure: false }
    if (!word.bare || PS_HOME_CONSTANT.test(word.value)) return { value: word.value, sure: true }
    const kept = this.kept(word)
    if (kept !== undefined) return { value: kept, sure: false }
    return loose && wordKnown(word.value) && !word.value.startsWith('-') ? { value: word.value, sure: true } : undefined
  }

  literal(words: readonly PsToken[]): PsValue | undefined {
    const head = words[0]
    if (head === undefined) return undefined
    const parts: PsValue[] = []
    const whole = (joint: string): PsValue => ({ value: parts.map((one, at) => (joint === '' ? one.value : at === 0 ? one.value.replace(/[\\/]+$/, '') : one.value.replace(/^[\\/]+/, ''))).join(joint), sure: parts.every(one => one.sure) })
    if (head.bare && /^join-path$/i.test(head.value)) {
      for (const word of words.slice(1)) {
        if (word.bare && /^-(?:path|childpath|additionalchildpath)$/i.test(word.value)) continue
        const one = word.bare && word.value.startsWith('-') ? undefined : this.part(word.text.endsWith(',') ? { ...word, value: word.value.replace(/,$/, '') } : word, true)
        if (one === undefined) return undefined
        parts.push(one)
      }
      return parts.length < 2 ? undefined : whole('\\')
    }
    const combined = words.length === 1 && head.bare ? PS_COMBINE.exec(head.value)?.[1] : undefined
    if (combined !== undefined) {
      for (const piece of combined.match(/'[^']*'|"[^"]*"|[^,]+/g) ?? []) {
        const text = piece.trim()
        if (text === '') continue
        const quoted = /^(['"])([\s\S]*)\1$/.exec(text)
        const one = quoted !== null ? (quoted[2]!.includes('$(') ? undefined : { value: quoted[2]!, sure: true }) : this.part({ value: text, text, inner: [], bare: true })
        if (one === undefined) return undefined
        parts.push(one)
      }
      return parts.length < 2 ? undefined : whole('\\')
    }
    if (words.length >= 3 && !head.bare && words[1]!.bare && /^-f$/i.test(words[1]!.value) && !/\{\d+[,:]/.test(head.value) && !head.value.includes(UNREAD_PART)) {
      for (const word of words.slice(2)) {
        if (word.bare && word.value === ',') continue
        const one = this.part(word.text.endsWith(',') ? { ...word, value: word.value.replace(/,$/, '') } : word)
        if (one === undefined) return undefined
        parts.push(one)
      }
      const sure = parts.every(one => one.sure)
      let missing = false
      const value = head.value.replace(/\{(\d+)\}/g, (_all, at: string) => {
        const one = parts[Number(at)]
        if (one === undefined) missing = true
        return one?.value ?? ''
      })
      return missing ? undefined : { value, sure }
    }
    if (words.length % 2 === 0) return undefined
    for (const [at, word] of words.entries()) {
      if (at % 2 === 1) {
        if (!word.bare || word.value !== '+') return undefined
        continue
      }
      const one = this.part(word)
      if (one === undefined) return undefined
      parts.push(one)
    }
    return whole('')
  }

  plainMove(at: number): 'joined' | 'stops' | undefined {
    const command = this.reading.commands[at]
    const argv = command === undefined || command.background ? [] : command.argv
    const target = argv[1]
    if (target === undefined || !PS_MOVES.has(programOf(argv[0]!)) || target.startsWith('-') || !wordKnown(target)) return undefined
    if (argv.length === 2) return 'joined'
    const stops = argv.length === 4 ? /^-(?:erroraction|ea)$/i.test(argv[2]!) && /^stop$/i.test(argv[3]!) : argv.length === 3 && /^-(?:erroraction|ea):stop$/i.test(argv[2]!)
    return stops && !/\btrap\b/i.test(this.source) ? 'stops' : undefined
  }

  valueOf(words: readonly PsToken[]): readonly PsToken[] {
    let targets = true
    for (const [at, word] of words.entries()) {
      const found = word.bare ? PS_ASSIGNS.exec(word.value) : null
      const parts = found !== null && !found[1]!.includes('(') ? found : null
      const target = word.bare && /^[$[,]/.test(parts === null ? word.value : parts[1]!)
      if (parts === null || parts[1] !== '') {
        if (at > 0 && !(targets && target)) return words
        targets = targets && target
        if (parts === null) continue
      } else if (at === 0 || !(targets || at === 1)) return words
      return this.valueOf(parts[2] === '' ? words.slice(at + 1) : [{ ...word, value: parts[2]!, text: parts[2]! }, ...words.slice(at + 1)])
    }
    return words
  }

  handed(stages: readonly Stage[]): number[] {
    const text = this.source
    const made: number[] = []
    const parts: PsToken[] = []
    const typed = this.typed
    this.typed = this.frame.cmd !== true
    while (this.at < text.length) {
      this.blank(true)
      if (this.at >= text.length || text[this.at] === ')') break
      const part = this.token(stages)
      if (part === undefined) this.at++
      else {
        made.push(...part.inner)
        parts.push(part)
      }
    }
    if (text[this.at] === ')') this.at++
    this.typed = typed
    this.parts = parts
    return made
  }

  asksSuccess(tokens: readonly PsToken[]): boolean {
    const head = tokens[1]
    const asked = tokens.length === 2 && head !== undefined && head.value === UNREAD_PART && head.inner.length === 1 ? this.reading.commands[head.inner[0]!] : undefined
    return asked !== undefined && tokens[0]!.bare && tokens[0]!.value.toLowerCase() === 'if' && asked.argv.length === 1 && asked.argv[0] === '$?'
  }

  blank(lines: boolean): void {
    const text = this.source
    for (;;) {
      const ch = text[this.at]
      if (ch === ' ' || ch === '\t' || ch === '\r' || (lines && ch === '\n')) this.at++
      else if (ch === '`' && (text[this.at + 1] === '\n' || (text[this.at + 1] === '\r' && text[this.at + 2] === '\n'))) this.at += text[this.at + 1] === '\n' ? 2 : 3
      else if (ch === '<' && text[this.at + 1] === '#') {
        const end = text.indexOf('#>', this.at + 2)
        this.at = end < 0 ? text.length : end + 2
      } else if (ch === '#') {
        while (this.at < text.length && text[this.at] !== '\n') this.at++
      } else return
    }
  }

  pipeline(closer: string | undefined, outer: readonly Stage[]): number[] {
    const text = this.source
    const made: number[] = []
    const pipeline = this.reading.pipelineSizes.push(1) - 1
    const begun = this.at
    let stage = 0
    let lone: PsValue | undefined
    let given: RegExpExecArray | null = null
    let before: string | undefined
    for (;;) {
      const stages = [...outer, { pipeline, stage }]
      const start = this.at
      const tokens: PsToken[] = []
      const redirects: ReadRedirect[] = []
      for (;;) {
        this.blank(false)
        const ch = text[this.at]
        if (ch === undefined || ch === '\n' || ch === ';' || ch === '|' || (closer !== undefined && ch === closer) || ch === ')' || ch === '}') break
        if (ch === '&' && (text[this.at + 1] === '&' || (tokens.length > 0 && this.valueOf(tokens).length > 0))) break
        const redirect = /^(?:[0-9*]?>>?(?:&[0-9])?)/.exec(text.slice(this.at, this.at + 5))
        if (redirect !== null) {
          this.at += redirect[0].length
          if (redirect[0].includes('&')) continue
          this.blank(false)
          const target = this.token(stages)
          if (target !== undefined) redirects.push({ op: redirect[0].replace(/^[0-9*]/, ''), target: target.value })
          continue
        }
        const kept = this.gates
        if (this.previous !== undefined && this.asksSuccess(tokens)) this.gates = [...kept, this.previous]
        const token = this.token(stages)
        this.gates = kept
        if (token === undefined) break
        tokens.push(token)
      }
      const background = text[this.at] === '&' && text[this.at + 1] !== '&'
      let words = this.valueOf(tokens)
      const assigned = words !== tokens
      if (words === tokens && words.length > 2 && words[0]!.bare && PS_LOOP_VARIABLE.test(words[0]!.value) && words[1]!.bare && words[1]!.value.toLowerCase() === 'in') words = words.slice(2)
      const called = words[0] !== undefined && words[0].bare && (words[0].value === '&' || words[0].value === '.')
      if (called) words = words.slice(1)
      if (stage === 0) {
        lone = called || redirects.length > 0 || background || this.frame.cmd === true ? undefined : this.literal(words)
        given = assigned && this.frame.cmd !== true ? PS_GIVEN.exec(text.slice(start, this.at).trimStart()) : null
      }
      const first = words[0]
      const worded = (this.typed || assigned) && first?.bare === false && (words.length === 1 || first.text.endsWith(',') || (words[1]!.bare && PS_OPERATOR.test(words[1]!.value)))
      const value = this.frame.cmd !== true && !called && (worded || (words.length === 1 && first?.value === UNREAD_PART && first.inner.length === 0))
      const argv: string[] = []
      const inner: number[][] = []
      const second: string[] = []
      let varied = false
      for (const [at, word] of (value ? [] : words).entries()) {
        const parts = word.bare && word.value.includes(',') && !word.value.includes(UNREAD_PART) ? word.value.split(',').filter(part => part !== '') : [word.value]
        const swapped = this.frame.cmd !== true && (at > 0 || called) ? (word.other ?? this.kept(word)) : undefined
        if (swapped !== undefined) varied = true
        for (const part of parts) {
          argv.push(part)
          inner.push(word.inner)
          second.push(swapped ?? part)
        }
      }
      const readings = varied && moveOf({ argv: second, dialect: 'powershell' }) === undefined ? [argv, second] : [argv]
      if (argv.length > 0 || redirects.length > 0)
        for (const reading of readings)
          made.push(
            this.reading.push({
              argv: reading,
              env: [],
              redirects,
              text: text.slice(start, this.at).trim(),
              line: this.line(start),
              cwd: this.reading.cwd,
              background: background || this.frame.background,
              stages,
              input: undefined,
              inner,
              inputInner: [],
              body: this.frame.body,
              dialect: 'powershell',
              around: this.frame.around,
              gates: this.gates.length > 0 ? this.gates : undefined,
              maybes: this.maybes.length > 0 ? this.maybes : undefined,
              called: called ? (words[0]?.text.startsWith('{') ? 'block' : 'name') : undefined,
              handed: before,
            }),
          )
      before = this.frame.cmd !== true && !called && redirects.length === 0 && words.length === 1 && first?.bare === false && !first.value.includes(UNREAD_PART) ? first.value : undefined
      if (text[this.at] === '|' && text[this.at + 1] !== '|') {
        this.at++
        stage++
        this.blank(true)
        continue
      }
      break
    }
    this.reading.pipelineSizes[pipeline] = stage + 1
    this.said = stage === 0 && lone?.sure === true ? lone.value : undefined
    this.maybe = stage === 0 && lone?.sure === false ? lone.value : undefined
    if (given !== null) {
      if (stage === 0 && given[2] === '=' && lone !== undefined) this.values.set(given[1]!.toLowerCase(), lone.value)
      else this.values.delete(given[1]!.toLowerCase())
    }
    const whole = text.slice(begun, this.at).trim()
    for (const index of made) {
      const command = this.reading.commands[index]
      if (command !== undefined && command.around === undefined && stage > 0) command.around = whole
    }
    return made
  }

  group(closer: string, stages: readonly Stage[], typed = this.typed): number[] {
    const before = this.reading.commands.length
    const cwd = this.reading.cwd
    const outer = this.typed
    this.typed = typed
    this.statements(closer, stages)
    this.typed = outer
    if (this.source[this.at] === closer) this.at++
    this.reading.cwd = cwd
    const made: number[] = []
    for (let i = before; i < this.reading.commands.length; i++) made.push(i)
    return made
  }

  token(stages: readonly Stage[]): PsToken | undefined {
    const text = this.source
    const start = this.at
    let value = ''
    let bare = true
    const inner: number[] = []
    const swaps: Array<readonly [number, string]> = []
    while (this.at < text.length) {
      const ch = text[this.at]!
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ';' || ch === '|' || ch === ')' || ch === '}') break
      if (ch === '&') {
        if (this.at === start) value += text[this.at++]
        break
      }
      if (ch === '>' && this.at > start) break
      if ((ch === '@' && (text[this.at + 1] === "'" || text[this.at + 1] === '"')) && text[this.at + 2] === '\n') {
        const quote = text[this.at + 1]!
        const end = text.indexOf(`\n${quote}@`, this.at + 2)
        value += end < 0 ? text.slice(this.at + 3) : text.slice(this.at + 3, end)
        this.at = end < 0 ? text.length : end + 3
        bare = false
        continue
      }
      if (ch === "'") {
        bare = false
        this.at++
        for (; this.at < text.length; this.at++) {
          if (text[this.at] !== "'") value += text[this.at]
          else if (text[this.at + 1] === "'") {
            value += "'"
            this.at++
          } else break
        }
        this.at++
        continue
      }
      if (ch === '"') {
        bare = false
        this.at++
        for (; this.at < text.length; this.at++) {
          const c = text[this.at]!
          if (c === '`' && this.at + 1 < text.length) {
            const escaped = text[++this.at]!
            value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === '0' ? '' : escaped
          } else if (c === '"') {
            if (text[this.at + 1] !== '"') break
            value += '"'
            this.at++
          } else if (c === '$' && text[this.at + 1] === '(') {
            this.at += 2
            inner.push(...this.group(')', []))
            this.at--
            value += UNREAD_PART
          } else value += c
        }
        this.at++
        continue
      }
      if (ch === '`' && this.at + 1 < text.length) {
        value += text[this.at + 1] === '\n' ? '' : text[this.at + 1]
        this.at += 2
        continue
      }
      if (ch === '(' && bare && PS_STATEMENT_HEAD.test(value)) break
      if (ch === '(' || ((ch === '$' || ch === '@') && text[this.at + 1] === '(')) {
        if (ch === '(' && value !== '' && /[\w\]]$/.test(value)) {
          if (!PS_VALUE_START.test(text[start]!)) break
          const open = this.at++
          inner.push(...(value.endsWith(']') ? this.group(')', [], this.frame.cmd !== true) : this.handed(stages)))
          const made = /^\[scriptblock\]::create$/i.test(value) && this.parts.length === 1 && !this.parts[0]!.bare && !this.parts[0]!.value.includes(UNREAD_PART) ? this.parts[0]!.value : undefined
          if (made !== undefined && this.frame.cmd !== true) {
            const from = this.reading.push({ argv: [], env: [], redirects: [], text: text.slice(start, this.at), line: this.line(start), cwd: this.reading.cwd, background: this.frame.background, stages, input: undefined, inner: [], inputInner: [], body: this.frame.body, dialect: 'powershell', around: this.frame.around })
            this.reading.pending.push({ text: made, dialect: 'powershell', from })
            inner.push(from)
          }
          value += text.slice(open, this.at)
          continue
        }
        this.at += ch === '(' ? 1 : 2
        inner.push(...this.group(')', [], this.frame.cmd !== true))
        if (this.said === undefined) {
          if (this.maybe !== undefined) swaps.push([value.length, this.maybe])
          value += UNREAD_PART
        } else {
          value += this.said
          bare = false
        }
        continue
      }
      if (ch === '{' || (ch === '@' && text[this.at + 1] === '{')) {
        this.at += ch === '{' ? 1 : 2
        inner.push(...this.group('}', stages))
        value += UNREAD_PART
        continue
      }
      value += ch
      this.at++
    }
    if (this.at === start) return undefined
    const other = swaps.length === 0 ? undefined : swaps.reduceRight((whole, [at, literal]) => whole.slice(0, at) + literal + whole.slice(at + 1), value)
    return { value, text: text.slice(start, this.at), inner, bare, other }
  }
}

async function readInto(reading: Reading, text: string, frame: Frame, depth: number): Promise<void> {
  if (depth > SCRIPT_DEPTH_CAP || ++reading.scripts > SCRIPT_COUNT_CAP) {
    reading.markUnread('it nests more scripts than are read', text)
    return
  }
  if (text.trim() === '') return
  const from = reading.pending.length
  if (frame.dialect === 'powershell') new PowerShellWalk(reading, text, frame).statements(undefined, frame.stages)
  else {
    const root = await parseCommandRaw(text)
    if (root === null || typeof root === 'symbol') {
      reading.markUnread(text.length > 10_000 ? 'it is longer than the shell parser reads' : 'the shell parser is not available', text)
      return
    }
    if (root.type === 'ERROR') reading.markUnread('the shell parser found incomplete or invalid syntax in it', text)
    new PosixWalk(reading, text).node(root.type === 'ERROR' ? { ...root, type: 'program' } : root, frame)
  }
  const scripts = reading.pending.splice(from)
  for (const script of scripts) {
    const parent = reading.commands[script.from]
    if (parent === undefined) continue
    const cwd = reading.cwd
    reading.cwd = parent.cwd
    await readInto(reading, script.text, { background: parent.background, stages: parent.stages, body: script.body ?? parent.body, line: parent.line, dialect: script.dialect, around: undefined, cmd: script.cmd }, depth + 1)
    reading.cwd = cwd
  }
}

export async function readShellCommands(text: string, dialect: ShellDialect, world: ReadWorld): Promise<ShellRead> {
  const reading = new Reading(world)
  await readInto(reading, text, { background: false, stages: [], body: undefined, line: 1, dialect, around: undefined }, 0)
  return { commands: reading.commands, pipelineSizes: reading.pipelineSizes, exported: reading.exported, homes: reading.scope.get('HOME') ?? [], unread: reading.unread }
}
