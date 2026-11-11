import { peelWrappers } from '../bash/ast.js'
import { parseCommandRaw, type Node } from '../bash/parser.js'

export const UNREAD_PART = '\uFFFC'

type ShellDialect = 'posix' | 'powershell'
type Stage = { pipeline: number; stage: number }

export type ReadRedirect = { op: string; target: string }

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
  unread: { why: string; text: string } | undefined
}

export type ReadWorld = {
  cwd: string | undefined
  home: string | undefined
  homesRoot: string
  ownNames: readonly string[]
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
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(segment)
  }
  return (absolute ? '/' : '') + out.join('/')
}

export function expandTilde(word: string, world: ReadWorld): string {
  if (!word.startsWith('~')) return word
  if (word === '~' || word.startsWith('~/')) return world.home === undefined ? word : world.home + word.slice(1)
  const named = /^~([A-Za-z0-9._-]+)(\/[\s\S]*)?$/.exec(word)
  if (named === null) return word
  const own = world.ownNames.includes(named[1]!) && world.home !== undefined
  return `${own ? world.home : `${world.homesRoot}/${named[1]}`}${named[2] ?? ''}`
}

export function absolutePath(word: string, cwd: string | undefined, world: ReadWorld): string | undefined {
  const expanded = expandTilde(word, world)
  if (expanded.startsWith('/')) return collapseDots(expanded) || '/'
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
  if (program === 'coproc' || program === 'busybox') return argv.length > 1 ? argv.slice(1) : null
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

type Pending = { text: string; dialect: ShellDialect; from: number }

function printedBy(command: ReadCommand | undefined): string | undefined {
  const layer = command === undefined ? undefined : layersOf(command.argv).at(-1)
  if (layer === undefined) return undefined
  return layer.program === 'echo' ? echoText(layer.argv) : layer.program === 'printf' ? printfText(layer.argv) : undefined
}

function nestedScripts(command: ReadCommand, from: number, commands: readonly ReadCommand[]): Pending[] {
  const out: Pending[] = []
  for (const layer of layersOf(command.argv)) {
    const { program, argv } = layer
    if (POSIX_SHELLS.has(program) || program === 'source' || program === '.') {
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
      if (at >= 0 && at + 1 < argv.length) out.push({ text: argv.slice(at + 1).join(' '), dialect: 'powershell', from })
    } else if (command.dialect === 'powershell' && (program === 'invoke-expression' || program === 'iex')) {
      const script = argv.slice(1).filter(word => !/^-[A-Za-z]+$/.test(word))
      if (script.length > 0) out.push({ text: script.join(' '), dialect: 'powershell', from })
    }
  }
  return out
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
  unread: { why: string; text: string } | undefined
  scripts = 0
  cwd: string | undefined

  constructor(readonly world: ReadWorld) {
    this.cwd = world.cwd
    if (world.home !== undefined) this.scope.set('HOME', [world.home])
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
    this.follow(command)
    this.pending.push(...nestedScripts(command, index, this.commands))
    return index
  }

  follow(command: ReadCommand): void {
    const layer = layersOf(command.argv)[0]
    if (layer === undefined) return
    const program = layer.program
    const moves = program === 'cd' || program === 'chdir' || program === 'set-location' || program === 'sl'
    const pushes = program === 'pushd' || program === 'push-location'
    if (program === 'popd' || program === 'pop-location') {
      this.cwd = this.folders.pop()
      return
    }
    if (!moves && !pushes) return
    if (pushes) this.folders.push(this.cwd)
    const operands = layer.argv.slice(1).filter(word => !/^-[A-Za-z]+$/.test(word))
    const target = operands[0]
    if (target === undefined) this.cwd = pushes ? undefined : this.world.home
    else if (target === '-' || !wordKnown(target)) this.cwd = undefined
    else this.cwd = absolutePath(command.dialect === 'powershell' ? target.replace(/\\/g, '/') : target, this.cwd, this.world)
  }
}

type Frame = { background: boolean; stages: readonly Stage[]; body: string | undefined; line: number; dialect: ShellDialect }

const WORD_KINDS = new Set(['word', 'number', 'raw_string', 'string', 'concatenation', 'ansi_c_string', 'translated_string', 'simple_expansion', 'expansion', 'command_substitution', 'process_substitution', 'arithmetic_expansion', 'brace_expression'])
const WRITE_KEEPERS = new Set(['file_redirect', 'heredoc_redirect', 'herestring_redirect'])

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
    const depth = this.reading.folders.length
    run()
    this.reading.cwd = cwd
    this.reading.folders.length = depth
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
      case 'command_substitution':
      case 'process_substitution':
        this.isolated(() => this.children(node, frame))
        return
      case 'for_statement':
        this.loop(node, frame)
        return
      case 'function_definition': {
        const name = node.children.find(child => child.type === 'word')?.text
        this.isolated(() => this.children(node, { ...frame, body: name ?? frame.body, background: false, stages: [] }))
        return
      }
      case 'variable_assignment':
        this.assignment(node, frame)
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
        this.children(child, frame)
      } else if (WORD_KINDS.has(child.type)) items.push(...this.word(child, frame).values)
    }
  }

  variable(node: Node, frame: Frame): Words {
    const name = (node.children.find(child => child.type === 'variable_name') ?? node.children.find(child => child.type === 'special_variable_name'))?.text
    const inner: number[] = []
    for (const child of node.children) {
      if (child.type !== 'command_substitution' && child.type !== 'process_substitution') continue
      const before = this.reading.commands.length
      this.node(child, frame)
      for (let i = before; i < this.reading.commands.length; i++) inner.push(i)
    }
    const known = name === undefined ? undefined : this.reading.scope.get(name)
    if (known !== undefined && known.length > 0) return { values: [...known].reverse(), inner }
    return { values: [node.text], inner }
  }

  word(node: Node, frame: Frame): Words {
    switch (node.type) {
      case 'word':
        return { values: [unescapeBackslashes(node.text)], inner: [] }
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
        return { values: [UNREAD_PART], inner }
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
      })
      if (first < 0) first = index
    }
    return first
  }

  redirected(node: Node, frame: Frame): void {
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
        for (const part of child.children) {
          if (part.type === 'heredoc_body') {
            input = part.text
            this.children(part, frame)
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
    if (body === undefined) this.reading.push({ argv: [], env: [], redirects, text: node.text, line: this.lineOf(node, frame), cwd: this.reading.cwd, background: frame.background, stages: inside.stages, input, inner: [], inputInner, body: frame.body, dialect: frame.dialect })
    else if (body.type === 'command') this.command(body, inside, redirects, input, inputInner)
    else {
      this.node(body, inside)
      const last = this.reading.commands[this.reading.commands.length - 1]
      if (last !== undefined && this.reading.commands.length > before) {
        last.redirects = [...last.redirects, ...redirects]
        last.input ??= input
        last.inputInner = [...last.inputInner, ...inputInner]
        this.reading.pending.push(...nestedScripts(last, this.reading.commands.length - 1, this.reading.commands).filter(script => script.text === input))
      } else this.reading.push({ argv: [], env: [], redirects, text: node.text, line: this.lineOf(node, frame), cwd: this.reading.cwd, background: frame.background, stages: inside.stages, input, inner: [], inputInner, body: frame.body, dialect: frame.dialect })
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

  pipeline(node: Node, frame: Frame): void {
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

type PsToken = { value: string; text: string; inner: number[]; bare: boolean }

class PowerShellWalk {
  at = 0

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
    while (this.at < text.length) {
      this.blank(true)
      const ch = text[this.at]
      if (ch === undefined) break
      if (closer !== undefined && ch === closer) break
      if (ch === ')' || ch === '}') {
        this.at++
        continue
      }
      made.push(...this.pipeline(closer, stages))
      const next = text[this.at]
      if (next === ';' || next === '\n') this.at++
      else if ((next === '&' && text[this.at + 1] === '&') || (next === '|' && text[this.at + 1] === '|')) this.at += 2
      else if (next === '&') this.at++
    }
    return made
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
    let stage = 0
    for (;;) {
      const stages = [...outer, { pipeline, stage }]
      const start = this.at
      const tokens: PsToken[] = []
      const redirects: ReadRedirect[] = []
      for (;;) {
        this.blank(false)
        const ch = text[this.at]
        if (ch === undefined || ch === '\n' || ch === ';' || ch === '|' || (closer !== undefined && ch === closer) || ch === ')' || ch === '}') break
        if (ch === '&' && (tokens.length > 0 || text[this.at + 1] === '&')) break
        const redirect = /^(?:[0-9*]?>>?(?:&[0-9])?)/.exec(text.slice(this.at, this.at + 5))
        if (redirect !== null) {
          this.at += redirect[0].length
          if (redirect[0].includes('&')) continue
          this.blank(false)
          const target = this.token(stages)
          if (target !== undefined) redirects.push({ op: redirect[0].replace(/^[0-9*]/, ''), target: target.value })
          continue
        }
        const token = this.token(stages)
        if (token === undefined) break
        tokens.push(token)
      }
      const background = text[this.at] === '&' && text[this.at + 1] !== '&'
      let words = tokens
      if (words[0] !== undefined && words[0].bare && (words[0].value === '&' || words[0].value === '.')) words = words.slice(1)
      const assigned = words.findIndex(word => word.bare && /^[-+*/]?=$/.test(word.value))
      if (assigned === 1) words = words.slice(2)
      const argv: string[] = []
      const inner: number[][] = []
      for (const word of words) {
        const parts = word.bare && word.value.includes(',') && !word.value.includes(UNREAD_PART) ? word.value.split(',').filter(part => part !== '') : [word.value]
        for (const part of parts) {
          argv.push(part)
          inner.push(word.inner)
        }
      }
      if (argv.length > 0 || redirects.length > 0)
        made.push(
          this.reading.push({
            argv,
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
          }),
        )
      if (text[this.at] === '|' && text[this.at + 1] !== '|') {
        this.at++
        stage++
        this.blank(true)
        continue
      }
      break
    }
    this.reading.pipelineSizes[pipeline] = stage + 1
    return made
  }

  group(closer: string, stages: readonly Stage[]): number[] {
    const before = this.reading.commands.length
    const cwd = this.reading.cwd
    this.statements(closer, stages)
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
    while (this.at < text.length) {
      const ch = text[this.at]!
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ';' || ch === '|' || ch === ')' || ch === '}') break
      if (ch === '&' && this.at > start) break
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
      if (ch === '(' || ((ch === '$' || ch === '@') && text[this.at + 1] === '(')) {
        if (ch === '(' && value !== '' && /[\w\]]$/.test(value)) {
          const open = this.at
          let depth = 0
          for (; this.at < text.length; this.at++) {
            if (text[this.at] === '(') depth++
            else if (text[this.at] === ')' && --depth === 0) break
          }
          this.at++
          value += text.slice(open, this.at)
          continue
        }
        this.at += ch === '(' ? 1 : 2
        inner.push(...this.group(')', []))
        value += UNREAD_PART
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
    return this.at === start ? undefined : { value, text: text.slice(start, this.at), inner, bare }
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
    await readInto(reading, script.text, { background: parent.background, stages: parent.stages, body: parent.body, line: parent.line, dialect: script.dialect }, depth + 1)
    reading.cwd = cwd
  }
}

export async function readShellCommands(text: string, dialect: ShellDialect, world: ReadWorld): Promise<ShellRead> {
  const reading = new Reading(world)
  await readInto(reading, text, { background: false, stages: [], body: undefined, line: 1, dialect }, 0)
  return { commands: reading.commands, pipelineSizes: reading.pipelineSizes, exported: reading.exported, unread: reading.unread }
}
