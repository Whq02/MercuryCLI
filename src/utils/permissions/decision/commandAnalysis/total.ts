import { shellCommandText } from '../../../bash/ast.js'
import { misreadWordList, parseCommandRaw } from '../../../bash/parser.js'
import { absolutePath, layersOf, moveOf, programOf, wordKnown } from './layers.js'
import { nestedScripts, type Pending } from './scripts.js'
import { PosixWalk, READING_CAP } from './totalPosix.js'
import { PowerShellWalk } from './totalPowerShell.js'
import type { ReadCommand, ReadWorld, ShellDialect, ShellRead, Stage } from './reading.js'

const SCRIPT_DEPTH_CAP = 64
const SCRIPT_COUNT_CAP = 256

const EXPANSION_CAP = 4
const ALIAS_DEFINITION = /^([^=\s]+)=([\s\S]*)$/

function withPositionals(body: string, args: string[]): string {
  const plain = (value: string): string => value.replace(/["\\$`]/g, '\\$&')
  return body.replace(/\$(?:\{([1-9@*])\}|([1-9@*]))/g, (_all, braced: string | undefined, bare: string | undefined) => {
    const key = braced ?? bare ?? ''
    return key === '@' || key === '*' ? args.map(plain).join(' ') : plain(args[Number(key) - 1] ?? '')
  })
}

export class Reading {
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
    else if (!wordKnown(target)) this.cwd = this.world.folderOf?.(target)
    else this.cwd = this.world.folderOf?.(target) ?? absolutePath(command.dialect === 'powershell' ? target.replace(/\\/g, '/') : target, this.cwd, this.world)
    this.oldpwd = left
  }
}

export type Frame = { background: boolean; stages: readonly Stage[]; body: string | undefined; line: number; dialect: ShellDialect; around: string | undefined; gates?: ReadonlyArray<readonly [number, number]> | undefined; maybes?: readonly number[] | undefined; substituted?: boolean | undefined; cmd?: boolean | undefined }

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
    if (root.type === 'ERROR') reading.markUnread(misreadWordList(root) === null ? 'the shell parser found incomplete or invalid syntax in it' : 'a line break stands between the words of one command in it', text)
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

let failing = false

export function failShellReadingForTesting(fail: boolean): void {
  failing = fail
}

export async function readShellCommands(text: string, dialect: ShellDialect, world: ReadWorld): Promise<ShellRead> {
  const reading = new Reading(world)
  try {
    if (failing) throw new Error('the reading was made to fail')
    await readInto(reading, text, { background: false, stages: [], body: undefined, line: 1, dialect, around: undefined }, 0)
  } catch {
    reading.markUnread('it could not be read', text)
  }
  return { commands: reading.commands, pipelineSizes: reading.pipelineSizes, exported: reading.exported, homes: reading.scope.get('HOME') ?? [], unread: reading.unread }
}
